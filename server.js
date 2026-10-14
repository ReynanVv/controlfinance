import 'dotenv/config';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import cookieParser from 'cookie-parser';
import pg from 'pg';

const { Pool } = pg;
const scryptAsync = promisify(crypto.scrypt);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

if (!DATABASE_URL) throw new Error('DATABASE_URL não configurada.');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
});

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.static('public'));

const ATLAS_FRONT_ORIGINS = new Set(['https://atlas-front-kl8a.onrender.com','https://atlas-live-i72f.onrender.com','http://localhost:5173','http://127.0.0.1:5173']);
app.use('/atlas-api', (req, res, next) => {
  const origin = req.headers.origin;
  if (ATLAS_FRONT_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

const rateLimitStores = new Map();
const loginFailures = new Map();

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimit({
  name,
  windowMs,
  max,
  key = (req) => clientIp(req),
  message = 'Muitas requisições. Tente novamente em instantes.',
}) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${name}:${key(req)}`;
    const current = rateLimitStores.get(bucketKey);

    if (!current || now >= current.resetAt) {
      rateLimitStores.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message, retryAfter });
    }

    next();
  };
}

const globalApiLimit = rateLimit({
  name: 'api',
  windowMs: 60 * 1000,
  max: 120,
});

const authLimit = rateLimit({
  name: 'auth',
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Muitas tentativas de autenticação. Aguarde alguns minutos.',
});

const registerLimit = rateLimit({
  name: 'register',
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Muitas contas criadas a partir deste endereço. Tente novamente mais tarde.',
});

function loginFailureKey(req, usernameKey) {
  return `${clientIp(req)}:${usernameKey}`;
}

function checkLoginBlock(req, res, usernameKey) {
  const key = loginFailureKey(req, usernameKey);
  const entry = loginFailures.get(key);
  const now = Date.now();

  if (!entry) return true;

  if (entry.blockedUntil && entry.blockedUntil > now) {
    const retryAfter = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'Muitas tentativas incorretas. Tente novamente mais tarde.',
      retryAfter,
    });
    return false;
  }

  if (entry.blockedUntil && entry.blockedUntil <= now) {
    loginFailures.delete(key);
  }

  return true;
}

function recordLoginFailure(req, usernameKey) {
  const key = loginFailureKey(req, usernameKey);
  const now = Date.now();
  const entry = loginFailures.get(key);

  if (!entry || now - entry.firstFailureAt > 15 * 60 * 1000) {
    loginFailures.set(key, { count: 1, firstFailureAt: now, blockedUntil: 0 });
    return;
  }

  entry.count += 1;
  if (entry.count >= 5) {
    entry.blockedUntil = now + 15 * 60 * 1000;
  }
}

function clearLoginFailures(req, usernameKey) {
  loginFailures.delete(loginFailureKey(req, usernameKey));
}

setInterval(() => {
  const now = Date.now();

  for (const [key, value] of rateLimitStores) {
    if (now >= value.resetAt) rateLimitStores.delete(key);
  }

  for (const [key, value] of loginFailures) {
    const oldFailure = now - value.firstFailureAt > 60 * 60 * 1000;
    const expiredBlock = value.blockedUntil && now >= value.blockedUntil;
    if (oldFailure || expiredBlock) loginFailures.delete(key);
  }
}, 10 * 60 * 1000).unref();

function money(value, fieldName = 'valor') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${fieldName} inválido.`);
    return Math.round(value * 100) / 100;
  }
  if (typeof value !== 'string') throw new Error(`${fieldName} inválido.`);
  let normalized = value.trim().replace(/\s/g, '');
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${fieldName} inválido.`);
  return Math.round(parsed * 100) / 100;
}

function month(value) {
  if (!monthRegex.test(String(value || ''))) throw new Error('Mês inválido. Use AAAA-MM.');
  return String(value);
}

function day(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) throw new Error('Dia deve estar entre 1 e 31.');
  return parsed;
}

function text(value, fieldName, required = false, max = 500) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(`${fieldName} é obrigatório.`);
  if (result.length > max) throw new Error(`${fieldName} é muito longo.`);
  return result || null;
}

function normalizeUsername(value) {
  const username = String(value ?? '').trim();
  if (username.length < 3 || username.length > 40) throw new Error('Usuário deve ter entre 3 e 40 caracteres.');
  if (!/^[\p{L}\p{N}._-]+$/u.test(username)) throw new Error('Usuário pode conter letras, números, ponto, hífen e sublinhado.');
  return { username, key: username.toLocaleLowerCase('pt-BR') };
}

function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
  if (password.length > 200) throw new Error('Senha muito longa.');
  return password;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = Buffer.from(await scryptAsync(password, salt, 64));
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function signedInUserId(req) {
  const value = req.signedCookies?.cf_user;
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function requireAuth(req, res, next) {
  const userId = signedInUserId(req);
  if (!userId) return res.status(401).json({ error: 'Não autenticado.' });
  req.userId = userId;
  next();
}

function setAuthCookie(res, userId) {
  res.cookie('cf_user', userId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cf_users (
      id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cf_incomes (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES cf_users(id) ON DELETE CASCADE,
      month VARCHAR(7) NOT NULL,
      name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      day SMALLINT CHECK (day BETWEEN 1 AND 31),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cf_expenses (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES cf_users(id) ON DELETE CASCADE,
      month VARCHAR(7) NOT NULL,
      name TEXT NOT NULL,
      base_amount NUMERIC(12,2) NOT NULL CHECK (base_amount >= 0),
      day SMALLINT CHECK (day BETWEEN 1 AND 31),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cf_subexpenses (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES cf_users(id) ON DELETE CASCADE,
      expense_id UUID NOT NULL REFERENCES cf_expenses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      day SMALLINT CHECK (day BETWEEN 1 AND 31),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cf_incomes_user_month ON cf_incomes(user_id, month);
    CREATE INDEX IF NOT EXISTS idx_cf_expenses_user_month ON cf_expenses(user_id, month);
    CREATE INDEX IF NOT EXISTS idx_cf_subexpenses_user_expense ON cf_subexpenses(user_id, expense_id);
  `);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', globalApiLimit);

app.get('/api/auth/status', asyncRoute(async (req, res) => {
  const userId = signedInUserId(req);
  if (!userId) return res.json({ authenticated: false, user: null });

  const { rows } = await pool.query('SELECT id, username FROM cf_users WHERE id = $1', [userId]);
  if (!rows[0]) {
    res.clearCookie('cf_user');
    return res.json({ authenticated: false, user: null });
  }
  res.json({ authenticated: true, user: rows[0] });
}));

app.post('/api/auth/register', authLimit, registerLimit, asyncRoute(async (req, res) => {
  const { username, key } = normalizeUsername(req.body?.username);
  const password = validatePassword(req.body?.password);
  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();

  try {
    const { rows } = await pool.query(
      `INSERT INTO cf_users (id, username, username_key, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username`,
      [id, username, key, passwordHash]
    );
    setAuthCookie(res, id);
    res.status(201).json({ user: rows[0] });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Esse usuário já existe.' });
    throw error;
  }
}));

app.post('/api/auth/login', authLimit, asyncRoute(async (req, res) => {
  const { key } = normalizeUsername(req.body?.username);
  if (!checkLoginBlock(req, res, key)) return;

  const password = String(req.body?.password ?? '');
  const { rows } = await pool.query(
    'SELECT id, username, password_hash FROM cf_users WHERE username_key = $1',
    [key]
  );

  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordLoginFailure(req, key);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  clearLoginFailures(req, key);
  setAuthCookie(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
}));

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('cf_user');
  res.json({ ok: true });
});

app.use('/api', requireAuth);

app.get('/api/summary', asyncRoute(async (req, res) => {
  const selectedMonth = month(req.query.month);
  const userId = req.userId;

  const [incomeResult, expenseResult] = await Promise.all([
    pool.query(`
      SELECT id, month, name, amount::float8 AS amount, day, notes
      FROM cf_incomes
      WHERE user_id = $1 AND month = $2
      ORDER BY day NULLS LAST, created_at
    `, [userId, selectedMonth]),
    pool.query(`
      SELECT
        e.id, e.month, e.name, e.base_amount::float8 AS "baseAmount", e.day, e.notes,
        COALESCE(SUM(s.amount), 0)::float8 AS "subTotal"
      FROM cf_expenses e
      LEFT JOIN cf_subexpenses s ON s.expense_id = e.id AND s.user_id = e.user_id
      WHERE e.user_id = $1 AND e.month = $2
      GROUP BY e.id
      ORDER BY e.day NULLS LAST, e.created_at
    `, [userId, selectedMonth]),
  ]);

  const expenseIds = expenseResult.rows.map((item) => item.id);
  let subRows = [];
  if (expenseIds.length) {
    const result = await pool.query(`
      SELECT id, expense_id AS "expenseId", name, amount::float8 AS amount, day, notes
      FROM cf_subexpenses
      WHERE user_id = $1 AND expense_id = ANY($2::uuid[])
      ORDER BY day NULLS LAST, created_at
    `, [userId, expenseIds]);
    subRows = result.rows;
  }

  const byExpense = new Map();
  for (const sub of subRows) {
    if (!byExpense.has(sub.expenseId)) byExpense.set(sub.expenseId, []);
    byExpense.get(sub.expenseId).push(sub);
  }

  const expenses = expenseResult.rows.map((expense) => ({
    ...expense,
    total: Number((expense.baseAmount + expense.subTotal).toFixed(2)),
    subexpenses: byExpense.get(expense.id) || [],
  }));

  const incomeTotal = Number(incomeResult.rows.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const expenseTotal = Number(expenses.reduce((sum, item) => sum + item.total, 0).toFixed(2));

  res.json({
    month: selectedMonth,
    incomes: incomeResult.rows,
    expenses,
    totals: {
      income: incomeTotal,
      expense: expenseTotal,
      balance: Number((incomeTotal - expenseTotal).toFixed(2)),
    },
  });
}));

app.post('/api/incomes', asyncRoute(async (req, res) => {
  const id = crypto.randomUUID();
  const payload = {
    month: month(req.body.month),
    name: text(req.body.name, 'Nome', true, 120),
    amount: money(req.body.amount),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows } = await pool.query(`
    INSERT INTO cf_incomes (id, user_id, month, name, amount, day, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, month, name, amount::float8 AS amount, day, notes
  `, [id, req.userId, payload.month, payload.name, payload.amount, payload.day, payload.notes]);
  res.status(201).json(rows[0]);
}));

app.put('/api/incomes/:id', asyncRoute(async (req, res) => {
  const payload = {
    month: month(req.body.month),
    name: text(req.body.name, 'Nome', true, 120),
    amount: money(req.body.amount),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows } = await pool.query(`
    UPDATE cf_incomes
    SET month = $3, name = $4, amount = $5, day = $6, notes = $7, updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING id, month, name, amount::float8 AS amount, day, notes
  `, [req.params.id, req.userId, payload.month, payload.name, payload.amount, payload.day, payload.notes]);

  if (!rows[0]) return res.status(404).json({ error: 'Ganho não encontrado.' });
  res.json(rows[0]);
}));

app.delete('/api/incomes/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM cf_incomes WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!result.rowCount) return res.status(404).json({ error: 'Ganho não encontrado.' });
  res.status(204).end();
}));

app.post('/api/expenses', asyncRoute(async (req, res) => {
  const id = crypto.randomUUID();
  const payload = {
    month: month(req.body.month),
    name: text(req.body.name, 'Nome', true, 120),
    baseAmount: money(req.body.baseAmount ?? req.body.amount),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows } = await pool.query(`
    INSERT INTO cf_expenses (id, user_id, month, name, base_amount, day, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, month, name, base_amount::float8 AS "baseAmount", day, notes
  `, [id, req.userId, payload.month, payload.name, payload.baseAmount, payload.day, payload.notes]);
  res.status(201).json(rows[0]);
}));

app.put('/api/expenses/:id', asyncRoute(async (req, res) => {
  const payload = {
    month: month(req.body.month),
    name: text(req.body.name, 'Nome', true, 120),
    totalAmount: money(req.body.baseAmount ?? req.body.amount, 'Valor total'),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows: subtotalRows } = await pool.query(`
    SELECT
      e.id,
      COALESCE(SUM(s.amount), 0)::float8 AS "subTotal"
    FROM cf_expenses e
    LEFT JOIN cf_subexpenses s
      ON s.expense_id = e.id
      AND s.user_id = e.user_id
    WHERE e.id = $1 AND e.user_id = $2
    GROUP BY e.id
  `, [req.params.id, req.userId]);

  if (!subtotalRows[0]) return res.status(404).json({ error: 'Gasto não encontrado.' });

  const subTotal = Number(subtotalRows[0].subTotal || 0);
  const baseAmount = Number((payload.totalAmount - subTotal).toFixed(2));

  if (baseAmount < 0) {
    return res.status(400).json({
      error: `O valor total não pode ser menor que os subgastos já cadastrados (${subTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`,
    });
  }

  const { rows } = await pool.query(`
    UPDATE cf_expenses
    SET month = $3, name = $4, base_amount = $5, day = $6, notes = $7, updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING id, month, name, base_amount::float8 AS "baseAmount", day, notes
  `, [req.params.id, req.userId, payload.month, payload.name, baseAmount, payload.day, payload.notes]);

  res.json({
    ...rows[0],
    subTotal,
    total: payload.totalAmount,
  });
}));

app.delete('/api/expenses/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM cf_expenses WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!result.rowCount) return res.status(404).json({ error: 'Gasto não encontrado.' });
  res.status(204).end();
}));

app.post('/api/expenses/:expenseId/subexpenses', asyncRoute(async (req, res) => {
  const expenseExists = await pool.query(
    'SELECT 1 FROM cf_expenses WHERE id = $1 AND user_id = $2',
    [req.params.expenseId, req.userId]
  );
  if (!expenseExists.rowCount) return res.status(404).json({ error: 'Gasto não encontrado.' });

  const id = crypto.randomUUID();
  const payload = {
    name: text(req.body.name, 'Nome', true, 120),
    amount: money(req.body.amount),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows } = await pool.query(`
    INSERT INTO cf_subexpenses (id, user_id, expense_id, name, amount, day, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, expense_id AS "expenseId", name, amount::float8 AS amount, day, notes
  `, [id, req.userId, req.params.expenseId, payload.name, payload.amount, payload.day, payload.notes]);
  res.status(201).json(rows[0]);
}));

app.put('/api/subexpenses/:id', asyncRoute(async (req, res) => {
  const payload = {
    name: text(req.body.name, 'Nome', true, 120),
    amount: money(req.body.amount),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows } = await pool.query(`
    UPDATE cf_subexpenses
    SET name = $3, amount = $4, day = $5, notes = $6, updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING id, expense_id AS "expenseId", name, amount::float8 AS amount, day, notes
  `, [req.params.id, req.userId, payload.name, payload.amount, payload.day, payload.notes]);

  if (!rows[0]) return res.status(404).json({ error: 'Subgasto não encontrado.' });
  res.json(rows[0]);
}));

app.delete('/api/subexpenses/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM cf_subexpenses WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!result.rowCount) return res.status(404).json({ error: 'Subgasto não encontrado.' });
  res.status(204).end();
}));

app.post('/api/import-local', asyncRoute(async (req, res) => {
  const incomes = Array.isArray(req.body?.incomes) ? req.body.incomes : [];
  const expenses = Array.isArray(req.body?.expenses) ? req.body.expenses : [];
  if (incomes.length + expenses.length > 1000) return res.status(400).json({ error: 'Importação grande demais.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const item of incomes) {
      await client.query(
        `INSERT INTO cf_incomes (id, user_id, month, name, amount, day, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [crypto.randomUUID(), req.userId, month(item.month), text(item.name, 'Nome', true, 120), money(item.amount), day(item.day), text(item.notes, 'Observação', false, 500)]
      );
    }

    for (const expense of expenses) {
      const expenseId = crypto.randomUUID();
      await client.query(
        `INSERT INTO cf_expenses (id, user_id, month, name, base_amount, day, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [expenseId, req.userId, month(expense.month), text(expense.name, 'Nome', true, 120), money(expense.baseAmount), day(expense.day), text(expense.notes, 'Observação', false, 500)]
      );

      const subs = Array.isArray(expense.subexpenses) ? expense.subexpenses : [];
      for (const sub of subs) {
        await client.query(
          `INSERT INTO cf_subexpenses (id, user_id, expense_id, name, amount, day, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [crypto.randomUUID(), req.userId, expenseId, text(sub.name, 'Nome', true, 120), money(sub.amount), day(sub.day), text(sub.notes, 'Observação', false, 500)]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, imported: incomes.length + expenses.length });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));


// -----------------------------
// Atlas demo API (shares the existing Postgres using atlas_* tables)
const ATLAS_DEMO_PASSWORD = process.env.ATLAS_DEMO_PASSWORD || crypto.randomUUID();
// -----------------------------

function atlasTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function atlasInviteHash(token) {
  return crypto.createHash('sha256').update('atlas-invite:' + String(token)).digest('hex');
}

async function atlasCreateSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO atlas_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
    [crypto.randomUUID(), userId, atlasTokenHash(token)]
  );
  return token;
}

async function atlasRequireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const tokenHash = atlasTokenHash(token);
    const { rows } = await pool.query(`
      SELECT u.id, u.name, u.email, u.role
      FROM atlas_sessions s
      JOIN atlas_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()
    `, [tokenHash]);

    if (!rows[0]) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    req.atlasUser = rows[0];
    req.atlasTokenHash = tokenHash;
    next();
  } catch (error) {
    next(error);
  }
}

function atlasRole(role) {
  return (req, res, next) => {
    if (req.atlasUser?.role !== role) return res.status(403).json({ error: 'Perfil sem permissão para esta ação.' });
    next();
  };
}

function atlasDays(value) {
  const days = [...new Set((Array.isArray(value) ? value : []).map(Number))].sort((a, b) => a - b);
  if (!days.length || days.some((item) => !Number.isInteger(item) || item < 0 || item > 6)) {
    throw new Error('Selecione pelo menos um dia válido da semana.');
  }
  return days;
}

function atlasWorkoutPayload(row, exercises = []) {
  return {
    id: row.id,
    trainerId: row.trainer_id,
    studentId: row.student_id,
    trainerName: row.trainer_name,
    studentName: row.student_name,
    name: row.name,
    model: row.model,
    notes: row.notes,
    scheduledDays: row.scheduled_days || [],
    createdAt: row.created_at,
    exercises,
  };
}

async function ensureAtlasSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS atlas_users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('trainer', 'student')),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS atlas_sessions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS atlas_invitations (
      id UUID PRIMARY KEY,
      trainer_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      student_email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS atlas_trainer_students (
      id UUID PRIMARY KEY,
      trainer_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (trainer_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS atlas_availability (
      id UUID PRIMARY KEY,
      student_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      UNIQUE (student_id, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS atlas_workouts (
      id UUID PRIMARY KEY,
      trainer_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      scheduled_days SMALLINT[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS atlas_workout_exercises (
      id UUID PRIMARY KEY,
      workout_id UUID NOT NULL REFERENCES atlas_workouts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sets SMALLINT NOT NULL CHECK (sets > 0),
      reps SMALLINT NOT NULL CHECK (reps > 0),
      suggested_weight NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (suggested_weight >= 0),
      rest_seconds INTEGER NOT NULL DEFAULT 0 CHECK (rest_seconds >= 0),
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS atlas_workout_sessions (
      id UUID PRIMARY KEY,
      workout_id UUID NOT NULL REFERENCES atlas_workouts(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS atlas_set_logs (
      id UUID PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES atlas_workout_sessions(id) ON DELETE CASCADE,
      exercise_id UUID NOT NULL REFERENCES atlas_workout_exercises(id) ON DELETE CASCADE,
      set_number SMALLINT NOT NULL CHECK (set_number > 0),
      reps SMALLINT NOT NULL CHECK (reps >= 0),
      weight NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (weight >= 0),
      completed BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT NOT NULL DEFAULT '',
      UNIQUE (session_id, exercise_id, set_number)
    );

    CREATE INDEX IF NOT EXISTS idx_atlas_invites_email ON atlas_invitations(student_email);
    CREATE INDEX IF NOT EXISTS idx_atlas_links_trainer ON atlas_trainer_students(trainer_id);
    CREATE INDEX IF NOT EXISTS idx_atlas_availability_student ON atlas_availability(student_id);
    CREATE INDEX IF NOT EXISTS idx_atlas_workouts_student ON atlas_workouts(student_id);
    CREATE INDEX IF NOT EXISTS idx_atlas_sessions_student ON atlas_workout_sessions(student_id);
  `);

  await pool.query(`
    ALTER TABLE atlas_invitations ALTER COLUMN student_email DROP NOT NULL;
    ALTER TABLE atlas_invitations ADD COLUMN IF NOT EXISTS token_hash TEXT;
    ALTER TABLE atlas_invitations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_invites_token_hash
      ON atlas_invitations(token_hash)
      WHERE token_hash IS NOT NULL;
  `);

  const trainerPassword = await hashPassword(ATLAS_DEMO_PASSWORD);
  const studentPassword = await hashPassword(ATLAS_DEMO_PASSWORD);

  await pool.query(`
    INSERT INTO atlas_users (id, name, email, role, password_hash)
    VALUES
      ('11111111-1111-4111-8111-111111111111', 'Professor Atlas', 'professor@atlas.test', 'trainer', $1),
      ('22222222-2222-4222-8222-222222222222', 'Aluno Atlas', 'aluno@atlas.test', 'student', $2)
    ON CONFLICT (email) DO UPDATE
    SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
  `, [trainerPassword, studentPassword]);
}

app.get('/atlas-api/health', (_req, res) => {
  res.json({ ok: true, service: 'atlas-api', database: 'shared-postgres' });
});

app.get('/atlas-api/demo', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, role FROM atlas_users ORDER BY role DESC');
  res.json({
    users: rows,
    password: ATLAS_DEMO_PASSWORD,
    steps: [
      'Professor envia convite',
      'Aluno aceita o convite',
      'Aluno informa disponibilidade',
      'Professor cria e prescreve o treino',
      'Aluno inicia, registra séries e conclui o treino',
    ],
  });
}));

app.post('/atlas-api/demo/reset', asyncRoute(async (req, res) => {
  if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'Envie confirm=RESET.' });

  await pool.query(`
    DELETE FROM atlas_set_logs;
    DELETE FROM atlas_workout_sessions;
    DELETE FROM atlas_workout_exercises;
    DELETE FROM atlas_workouts;
    DELETE FROM atlas_availability;
    DELETE FROM atlas_trainer_students;
    DELETE FROM atlas_invitations;
  `);

  res.json({ ok: true, message: 'Fluxo Atlas reiniciado. Os dois usuários de teste foram preservados.' });
}));

app.post('/atlas-api/auth/register', authLimit, asyncRoute(async (req, res) => {
  const name = text(req.body?.name, 'Nome', true, 120);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const inviteToken = String(req.body?.inviteToken || '').trim();
  const requestedRole = req.body?.role === 'trainer' ? 'trainer' : 'student';

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });

  const existing = await pool.query('SELECT id FROM atlas_users WHERE email = $1', [email]);
  if (existing.rowCount) return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });

  let invitation = null;
  let role = requestedRole;
  if (inviteToken) {
    const inviteHash = atlasInviteHash(inviteToken);
    const { rows } = await pool.query(
      `SELECT id, trainer_id, student_email, accepted_at, expires_at
       FROM atlas_invitations
       WHERE token_hash = $1`,
      [inviteHash]
    );
    invitation = rows[0];
    if (!invitation) return res.status(404).json({ error: 'Convite inválido.' });
    if (invitation.accepted_at) return res.status(409).json({ error: 'Este convite já foi aceito.' });
    if (invitation.expires_at && new Date(invitation.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Este convite expirou. Solicite um novo link ao treinador.' });
    }
    role = 'student';
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO atlas_users (id, name, email, role, password_hash) VALUES ($1, $2, $3, $4, $5)',
      [userId, name, email, role, passwordHash]
    );

    if (invitation) {
      await client.query(
        'UPDATE atlas_invitations SET accepted_at = NOW(), student_email = $2 WHERE id = $1',
        [invitation.id, email]
      );
      await client.query(
        `INSERT INTO atlas_trainer_students (id, trainer_id, student_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (trainer_id, student_id) DO NOTHING`,
        [crypto.randomUUID(), invitation.trainer_id, userId]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const token = await atlasCreateSession(userId);
  res.status(201).json({
    token,
    user: { id: userId, name, email, role },
    invitationAccepted: Boolean(invitation),
  });
}));

app.post('/atlas-api/auth/login', authLimit, asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const { rows } = await pool.query(
    'SELECT id, name, email, role, password_hash FROM atlas_users WHERE email = $1',
    [email]
  );

  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = atlasTokenHash(token);
  await pool.query(
    `INSERT INTO atlas_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
    [crypto.randomUUID(), user.id, tokenHash]
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}));

app.post('/atlas-api/auth/demo-login', asyncRoute(async (req, res) => {
  const role = req.body?.role === 'trainer' ? 'trainer' : req.body?.role === 'student' ? 'student' : null;
  if (!role) return res.status(400).json({ error: 'Perfil inválido.' });

  const { rows } = await pool.query(
    'SELECT id, name, email, role FROM atlas_users WHERE role = $1 ORDER BY created_at LIMIT 1',
    [role]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'Usuário de demonstração não encontrado.' });

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO atlas_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
    [crypto.randomUUID(), user.id, atlasTokenHash(token)]
  );

  res.json({ token, user });
}));

app.post('/atlas-api/auth/logout', atlasRequireAuth, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM atlas_sessions WHERE token_hash = $1', [req.atlasTokenHash]);
  res.json({ ok: true });
}));

app.get('/atlas-api/me', atlasRequireAuth, (req, res) => {
  res.json({ user: req.atlasUser });
});

app.get('/atlas-api/invitations/resolve/:token', asyncRoute(async (req, res) => {
  const inviteHash = atlasInviteHash(req.params.token);
  const { rows } = await pool.query(
    `SELECT i.id, i.accepted_at AS "acceptedAt", i.expires_at AS "expiresAt",
            t.name AS "trainerName"
     FROM atlas_invitations i
     JOIN atlas_users t ON t.id = i.trainer_id
     WHERE i.token_hash = $1`,
    [inviteHash]
  );
  const invitation = rows[0];
  if (!invitation) return res.status(404).json({ error: 'Convite inválido.' });
  if (invitation.acceptedAt) return res.status(409).json({ error: 'Este convite já foi aceito.' });
  if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
    return res.status(410).json({ error: 'Este convite expirou. Solicite um novo link ao treinador.' });
  }
  res.json(invitation);
}));

app.post('/atlas-api/invitations/accept-token', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const rawToken = String(req.body?.token || '').trim();
  if (!rawToken) return res.status(400).json({ error: 'Token de convite ausente.' });

  const inviteHash = atlasInviteHash(rawToken);
  const { rows } = await pool.query(
    `SELECT id, trainer_id, accepted_at, expires_at
     FROM atlas_invitations
     WHERE token_hash = $1`,
    [inviteHash]
  );
  const invitation = rows[0];
  if (!invitation) return res.status(404).json({ error: 'Convite inválido.' });
  if (invitation.accepted_at) return res.status(409).json({ error: 'Este convite já foi aceito.' });
  if (invitation.expires_at && new Date(invitation.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Este convite expirou. Solicite um novo link ao treinador.' });
  }

  const alreadyLinked = await pool.query(
    'SELECT 1 FROM atlas_trainer_students WHERE trainer_id = $1 AND student_id = $2',
    [invitation.trainer_id, req.atlasUser.id]
  );
  if (alreadyLinked.rowCount) {
    return res.status(409).json({ error: 'Você já está vinculado a este treinador.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE atlas_invitations SET accepted_at = NOW(), student_email = $2 WHERE id = $1',
      [invitation.id, req.atlasUser.email]
    );
    await client.query(
      `INSERT INTO atlas_trainer_students (id, trainer_id, student_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (trainer_id, student_id) DO NOTHING`,
      [crypto.randomUUID(), invitation.trainer_id, req.atlasUser.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.json({ id: invitation.id, status: 'Accepted' });
}));

app.get('/atlas-api/invitations', atlasRequireAuth, asyncRoute(async (req, res) => {
  if (req.atlasUser.role === 'trainer') {
    const { rows } = await pool.query(`
      SELECT i.id, i.student_email AS "studentEmail", i.created_at AS "createdAt",
             i.accepted_at AS "acceptedAt",
             CASE WHEN i.accepted_at IS NULL THEN 'Pending' ELSE 'Accepted' END AS status
      FROM atlas_invitations i
      WHERE i.trainer_id = $1
      ORDER BY i.created_at DESC
    `, [req.atlasUser.id]);
    return res.json(rows);
  }

  const { rows } = await pool.query(`
    SELECT i.id, i.trainer_id AS "trainerId", u.name AS "trainerName",
           i.created_at AS "createdAt", i.accepted_at AS "acceptedAt",
           CASE WHEN i.accepted_at IS NULL THEN 'Pending' ELSE 'Accepted' END AS status
    FROM atlas_invitations i
    JOIN atlas_users u ON u.id = i.trainer_id
    WHERE i.student_email = $1
    ORDER BY i.created_at DESC
  `, [req.atlasUser.email]);
  res.json(rows);
}));

app.post('/atlas-api/invitations', atlasRequireAuth, atlasRole('trainer'), asyncRoute(async (req, res) => {
  const inviteToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = atlasInviteHash(inviteToken);
  const invitationId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO atlas_invitations
      (id, trainer_id, student_email, token_hash, expires_at)
     VALUES ($1, $2, NULL, $3, NOW() + INTERVAL '7 days')`,
    [invitationId, req.atlasUser.id, tokenHash]
  );

  const inviteUrl = `https://atlas-front-kl8a.onrender.com/?invite=${inviteToken}`;
  res.status(201).json({
    id: invitationId,
    status: 'Pending',
    inviteUrl,
    expiresInDays: 7,
  });
}));

app.post('/atlas-api/invitations/:id/accept', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, trainer_id, student_email, accepted_at
     FROM atlas_invitations
     WHERE id = $1 AND student_email = $2`,
    [req.params.id, req.atlasUser.email]
  );
  const invitation = rows[0];
  if (!invitation) return res.status(404).json({ error: 'Convite não encontrado.' });

  if (!invitation.accepted_at) {
    await pool.query('UPDATE atlas_invitations SET accepted_at = NOW() WHERE id = $1', [invitation.id]);
    await pool.query(
      `INSERT INTO atlas_trainer_students (id, trainer_id, student_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (trainer_id, student_id) DO NOTHING`,
      [crypto.randomUUID(), invitation.trainer_id, req.atlasUser.id]
    );
  }

  res.json({ id: invitation.id, status: 'Accepted' });
}));

app.get('/atlas-api/availability', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT day_of_week AS day FROM atlas_availability WHERE student_id = $1 ORDER BY day_of_week',
    [req.atlasUser.id]
  );
  res.json({ days: rows.map((item) => item.day) });
}));

app.put('/atlas-api/availability', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const days = atlasDays(req.body?.days);
  const linked = await pool.query('SELECT 1 FROM atlas_trainer_students WHERE student_id = $1', [req.atlasUser.id]);
  if (!linked.rowCount) return res.status(400).json({ error: 'Aceite o convite de um professor antes de informar a disponibilidade.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM atlas_availability WHERE student_id = $1', [req.atlasUser.id]);
    for (const dayOfWeek of days) {
      await client.query(
        'INSERT INTO atlas_availability (id, student_id, day_of_week) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), req.atlasUser.id, dayOfWeek]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.json({ days });
}));

app.get('/atlas-api/trainer/students', atlasRequireAuth, atlasRole('trainer'), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.email,
           COALESCE(array_agg(a.day_of_week ORDER BY a.day_of_week)
             FILTER (WHERE a.day_of_week IS NOT NULL), '{}') AS availability,
           COUNT(DISTINCT w.id)::int AS "workoutCount"
    FROM atlas_trainer_students ts
    JOIN atlas_users u ON u.id = ts.student_id
    LEFT JOIN atlas_availability a ON a.student_id = u.id
    LEFT JOIN atlas_workouts w ON w.student_id = u.id AND w.trainer_id = ts.trainer_id
    WHERE ts.trainer_id = $1
    GROUP BY u.id, u.name, u.email
    ORDER BY u.name
  `, [req.atlasUser.id]);
  res.json(rows);
}));

app.post('/atlas-api/workouts', atlasRequireAuth, atlasRole('trainer'), asyncRoute(async (req, res) => {
  const studentId = String(req.body?.studentId || '');
  const name = text(req.body?.name, 'Nome do treino', true, 120);
  const model = text(req.body?.model, 'Modelo', true, 30).toUpperCase();
  const notes = text(req.body?.notes, 'Observações', false, 1000) || '';
  const scheduledDays = atlasDays(req.body?.scheduledDays);
  const exercises = Array.isArray(req.body?.exercises) ? req.body.exercises : [];
  if (!exercises.length) return res.status(400).json({ error: 'Adicione pelo menos um exercício.' });

  const linked = await pool.query(
    'SELECT 1 FROM atlas_trainer_students WHERE trainer_id = $1 AND student_id = $2',
    [req.atlasUser.id, studentId]
  );
  if (!linked.rowCount) return res.status(400).json({ error: 'O aluno precisa aceitar o convite antes de receber treinos.' });

  const availabilityResult = await pool.query(
    'SELECT day_of_week FROM atlas_availability WHERE student_id = $1 ORDER BY day_of_week',
    [studentId]
  );
  const availability = availabilityResult.rows.map((item) => item.day_of_week);
  if (!availability.length) return res.status(400).json({ error: 'O aluno ainda não informou a disponibilidade.' });
  if (scheduledDays.some((dayOfWeek) => !availability.includes(dayOfWeek))) {
    return res.status(400).json({ error: 'O treino só pode ser marcado em dias informados pelo aluno.', availability });
  }

  const workoutId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO atlas_workouts (id, trainer_id, student_id, name, model, notes, scheduled_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7::smallint[])`,
      [workoutId, req.atlasUser.id, studentId, name, model, notes, scheduledDays]
    );

    for (let index = 0; index < exercises.length; index += 1) {
      const exercise = exercises[index] || {};
      const exerciseName = text(exercise.name, 'Exercício', true, 120);
      const sets = Math.max(1, Number.parseInt(exercise.sets, 10) || 1);
      const reps = Math.max(1, Number.parseInt(exercise.reps, 10) || 1);
      const suggestedWeight = Math.max(0, Number(exercise.suggestedWeight) || 0);
      const restSeconds = Math.max(0, Number.parseInt(exercise.restSeconds, 10) || 0);

      await client.query(
        `INSERT INTO atlas_workout_exercises
          (id, workout_id, name, sets, reps, suggested_weight, rest_seconds, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [crypto.randomUUID(), workoutId, exerciseName, sets, reps, suggestedWeight, restSeconds, index]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.status(201).json({ id: workoutId, name, model, scheduledDays });
}));

app.get('/atlas-api/workouts', atlasRequireAuth, asyncRoute(async (req, res) => {
  const ownerColumn = req.atlasUser.role === 'trainer' ? 'w.trainer_id' : 'w.student_id';
  const { rows: workouts } = await pool.query(`
    SELECT w.*, t.name AS trainer_name, s.name AS student_name
    FROM atlas_workouts w
    JOIN atlas_users t ON t.id = w.trainer_id
    JOIN atlas_users s ON s.id = w.student_id
    WHERE ${ownerColumn} = $1
    ORDER BY w.created_at DESC
  `, [req.atlasUser.id]);

  const result = [];
  for (const workout of workouts) {
    const { rows: exercises } = await pool.query(`
      SELECT id, name, sets, reps, suggested_weight::float8 AS "suggestedWeight",
             rest_seconds AS "restSeconds", position
      FROM atlas_workout_exercises
      WHERE workout_id = $1
      ORDER BY position
    `, [workout.id]);

    const { rows: sessions } = await pool.query(`
      SELECT id, started_at AS "startedAt", completed_at AS "completedAt"
      FROM atlas_workout_sessions
      WHERE workout_id = $1 AND student_id = $2
      ORDER BY started_at DESC
      LIMIT 1
    `, [workout.id, workout.student_id]);

    result.push({
      ...atlasWorkoutPayload(workout, exercises),
      latestSession: sessions[0] || null,
    });
  }

  res.json(result);
}));

app.post('/atlas-api/workouts/:id/start', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const { rows: workouts } = await pool.query(
    'SELECT id FROM atlas_workouts WHERE id = $1 AND student_id = $2',
    [req.params.id, req.atlasUser.id]
  );
  if (!workouts[0]) return res.status(404).json({ error: 'Treino não encontrado.' });

  const { rows: openSessions } = await pool.query(`
    SELECT id, started_at AS "startedAt"
    FROM atlas_workout_sessions
    WHERE workout_id = $1 AND student_id = $2 AND completed_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `, [req.params.id, req.atlasUser.id]);
  if (openSessions[0]) return res.json(openSessions[0]);

  const id = crypto.randomUUID();
  const { rows } = await pool.query(`
    INSERT INTO atlas_workout_sessions (id, workout_id, student_id)
    VALUES ($1, $2, $3)
    RETURNING id, started_at AS "startedAt", completed_at AS "completedAt"
  `, [id, req.params.id, req.atlasUser.id]);
  res.status(201).json(rows[0]);
}));

app.get('/atlas-api/sessions/:id', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const { rows: sessions } = await pool.query(`
    SELECT ws.id, ws.workout_id AS "workoutId", ws.started_at AS "startedAt",
           ws.completed_at AS "completedAt", w.name AS "workoutName"
    FROM atlas_workout_sessions ws
    JOIN atlas_workouts w ON w.id = ws.workout_id
    WHERE ws.id = $1 AND ws.student_id = $2
  `, [req.params.id, req.atlasUser.id]);
  if (!sessions[0]) return res.status(404).json({ error: 'Execução não encontrada.' });

  const { rows: exercises } = await pool.query(`
    SELECT e.id, e.name, e.sets, e.reps, e.suggested_weight::float8 AS "suggestedWeight",
           e.rest_seconds AS "restSeconds", e.position
    FROM atlas_workout_exercises e
    WHERE e.workout_id = $1
    ORDER BY e.position
  `, [sessions[0].workoutId]);

  const { rows: logs } = await pool.query(`
    SELECT id, exercise_id AS "exerciseId", set_number AS "setNumber",
           reps, weight::float8 AS weight, completed, notes
    FROM atlas_set_logs WHERE session_id = $1
    ORDER BY exercise_id, set_number
  `, [req.params.id]);

  res.json({ ...sessions[0], exercises, logs });
}));

app.put('/atlas-api/sessions/:sessionId/exercises/:exerciseId/sets/:setNumber', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const setNumber = Math.max(1, Number.parseInt(req.params.setNumber, 10) || 1);
  const reps = Math.max(0, Number.parseInt(req.body?.reps, 10) || 0);
  const weight = Math.max(0, Number(req.body?.weight) || 0);
  const notes = text(req.body?.notes, 'Observação', false, 300) || '';

  const ownership = await pool.query(`
    SELECT 1
    FROM atlas_workout_sessions ws
    JOIN atlas_workout_exercises e ON e.workout_id = ws.workout_id
    WHERE ws.id = $1 AND ws.student_id = $2 AND e.id = $3 AND ws.completed_at IS NULL
  `, [req.params.sessionId, req.atlasUser.id, req.params.exerciseId]);
  if (!ownership.rowCount) return res.status(404).json({ error: 'Série ou execução não encontrada.' });

  const { rows } = await pool.query(`
    INSERT INTO atlas_set_logs
      (id, session_id, exercise_id, set_number, reps, weight, completed, notes)
    VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
    ON CONFLICT (session_id, exercise_id, set_number)
    DO UPDATE SET reps = EXCLUDED.reps, weight = EXCLUDED.weight,
                  completed = TRUE, notes = EXCLUDED.notes
    RETURNING id, exercise_id AS "exerciseId", set_number AS "setNumber",
              reps, weight::float8 AS weight, completed, notes
  `, [crypto.randomUUID(), req.params.sessionId, req.params.exerciseId, setNumber, reps, weight, notes]);

  res.json(rows[0]);
}));

app.post('/atlas-api/sessions/:id/complete', atlasRequireAuth, atlasRole('student'), asyncRoute(async (req, res) => {
  const { rows: sessionRows } = await pool.query(`
    SELECT ws.id, ws.workout_id
    FROM atlas_workout_sessions ws
    WHERE ws.id = $1 AND ws.student_id = $2 AND ws.completed_at IS NULL
  `, [req.params.id, req.atlasUser.id]);
  if (!sessionRows[0]) return res.status(404).json({ error: 'Execução aberta não encontrada.' });

  const { rows: exerciseRows } = await pool.query(
    'SELECT id, sets FROM atlas_workout_exercises WHERE workout_id = $1',
    [sessionRows[0].workout_id]
  );
  const requiredSets = exerciseRows.reduce((sum, item) => sum + item.sets, 0);

  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM atlas_set_logs WHERE session_id = $1 AND completed = TRUE',
    [req.params.id]
  );

  if (countRows[0].count < requiredSets) {
    return res.status(400).json({
      error: 'Conclua todas as séries antes de finalizar o treino.',
      completedSets: countRows[0].count,
      requiredSets,
    });
  }

  const notes = text(req.body?.notes, 'Observação final', false, 1000) || '';
  const { rows } = await pool.query(`
    UPDATE atlas_workout_sessions
    SET completed_at = NOW(), notes = $2
    WHERE id = $1
    RETURNING id, started_at AS "startedAt", completed_at AS "completedAt", notes
  `, [req.params.id, notes]);

  res.json(rows[0]);
}));


const ATLAS_DEMO_TRAINER_ID = '11111111-1111-4111-8111-111111111111';
const ATLAS_DEMO_STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const ATLAS_DEMO_STUDENT_EMAIL = 'aluno@atlas.test';
const ATLAS_DEMO_DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const ATLAS_DEMO_DAY_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function atlasHtmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function atlasDemoRedirect(res, role, message = '', error = '') {
  const params = new URLSearchParams({ role });
  if (message) params.set('m', message);
  if (error) params.set('e', error);
  res.redirect(303, '/atlas-demo?' + params.toString());
}

async function atlasDemoState() {
  const [inviteResult, linkResult, availabilityResult, workoutsResult] = await Promise.all([
    pool.query(
      `SELECT id, accepted_at
       FROM atlas_invitations
       WHERE trainer_id = $1 AND student_email = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_EMAIL]
    ),
    pool.query(
      'SELECT linked_at FROM atlas_trainer_students WHERE trainer_id = $1 AND student_id = $2',
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID]
    ),
    pool.query(
      'SELECT day_of_week FROM atlas_availability WHERE student_id = $1 ORDER BY day_of_week',
      [ATLAS_DEMO_STUDENT_ID]
    ),
    pool.query(
      `SELECT w.id, w.name, w.model, w.scheduled_days,
              latest.id AS session_id,
              latest.started_at,
              latest.completed_at
       FROM atlas_workouts w
       LEFT JOIN LATERAL (
         SELECT ws.id, ws.started_at, ws.completed_at
         FROM atlas_workout_sessions ws
         WHERE ws.workout_id = w.id AND ws.student_id = w.student_id
         ORDER BY ws.started_at DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE w.trainer_id = $1 AND w.student_id = $2
       ORDER BY w.created_at DESC`,
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID]
    ),
  ]);

  const availability = availabilityResult.rows.map((row) => Number(row.day_of_week));
  const workouts = workoutsResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    model: row.model,
    scheduledDays: row.scheduled_days || [],
    sessionId: row.session_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));

  return {
    invitation: inviteResult.rows[0] || null,
    linked: Boolean(linkResult.rowCount),
    availability,
    workouts,
    completed: workouts.some((workout) => Boolean(workout.completedAt)),
  };
}

function atlasDemoStyles() {
  return `
    *{box-sizing:border-box}html,body{margin:0;background:#F4F6F8;color:#0B1B3A;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    a{text-decoration:none;color:inherit}button,input{font:inherit}
    .top{position:sticky;top:0;z-index:10;height:78px;background:#0B1B3A;color:white;display:flex;align-items:center;justify-content:space-between;padding:0 22px}
    .brand{display:flex;align-items:center;gap:10px;font-size:24px;font-weight:900}.brand-mark{width:42px;height:42px;border-radius:12px;background:#B8E400;color:#0B1B3A;display:grid;place-items:center;font-weight:1000}
    .switch{display:flex;gap:8px}.switch a{padding:10px 12px;border-radius:10px;background:#162846;color:#fff;font-size:12px;font-weight:800}.switch a.active{background:#B8E400;color:#0B1B3A}
    .wrap{max-width:920px;margin:0 auto;padding:28px 18px 80px}.eyebrow{font-size:11px;letter-spacing:.15em;font-weight:900}.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:18px}.hero h1{font-size:38px;line-height:1.04;margin:8px 0}.hero p{margin:0;color:#69737A;line-height:1.55}
    .steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:24px 0}.step{padding:12px;border-radius:12px;background:#fff;border:1px solid #D8DDE4;font-size:12px;font-weight:900}.step.done{background:#B8E400;border-color:#B8E400}
    .notice{padding:13px 15px;border-radius:12px;margin:12px 0;font-weight:800}.notice.ok{background:#E9ECF2}.notice.err{background:#FFE5E2;color:#8D2F2A}
    .panel{background:#fff;border:1px solid #D8DDE4;border-radius:20px;padding:22px;margin:14px 0}.panel-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.panel h2{margin:0 0 5px;font-size:22px}.panel p{margin:0;color:#69737A;line-height:1.5}
    .badge{display:inline-flex;border-radius:999px;padding:5px 9px;background:#B8E400;color:#0B1B3A;font-size:10px;font-weight:1000;white-space:nowrap}
    .state{margin-top:16px;padding:14px;border-radius:12px;background:#F4F6F8;display:flex;justify-content:space-between;gap:12px;align-items:center}.state strong{display:block}.state small{color:#69737A}
    .btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;border:0;border-radius:12px;background:#B8E400;color:#0B1B3A;font-weight:950;cursor:pointer}.btn.secondary{background:#0B1B3A;color:#fff}.btn.ghost{background:#E9ECF2}.btn:disabled{opacity:.45}
    .days{display:grid;grid-template-columns:repeat(7,1fr);gap:7px;margin:16px 0}.day{height:52px;border:1px solid #D8DDE4;border-radius:11px;background:#fff;color:#69737A;display:grid;place-items:center;font-weight:900}.day.active{background:#B8E400;color:#0B1B3A;border-color:#B8E400}.day-check input{position:absolute;opacity:0}.day-check span{cursor:pointer}.day-check input:checked+span{background:#B8E400;color:#0B1B3A;border-color:#B8E400}
    .workout{display:flex;justify-content:space-between;gap:14px;align-items:center;border-top:1px solid #E9ECF2;padding:15px 0}.workout:first-of-type{margin-top:14px}.workout strong{display:block}.workout small{display:block;color:#69737A;margin-top:4px}
    .exercise{padding:14px 0;border-top:1px solid #E9ECF2}.exercise strong{display:block}.exercise small{color:#69737A}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:16px}
    .role-page{min-height:100vh;background:#0B1B3A;color:#fff;display:grid;place-items:center;padding:26px}.role-box{width:min(760px,100%)}.role-box .pill{display:inline-block;background:#B8E400;color:#0B1B3A;padding:7px 12px;border-radius:999px;font-size:11px;font-weight:1000}.role-box h1{font-size:clamp(46px,8vw,78px);line-height:.98;margin:22px 0}.role-box h1 em{font-style:normal;color:#B8E400}.role-box>p{color:#B7C0CA;line-height:1.6}.roles{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:28px}.role-card{display:block;background:#17283C;border:1px solid #31445C;border-radius:18px;padding:20px}.role-card strong{display:block;font-size:22px;margin-bottom:5px}.role-card span{color:#AEB8C4;font-size:13px}
    @media(max-width:680px){.top{height:70px;padding:0 14px}.brand{font-size:20px}.brand-mark{width:36px;height:36px}.switch a{padding:8px;font-size:10px}.wrap{padding:22px 14px 70px}.hero{flex-direction:column;align-items:flex-start}.hero h1{font-size:32px}.steps{grid-template-columns:1fr 1fr}.panel{padding:18px}.roles{grid-template-columns:1fr}.days{gap:5px}.day{height:46px}.workout{align-items:flex-start;flex-direction:column}.btn{width:100%}}
  `;
}

function atlasDemoShell(content, title = 'Atlas — Demonstração') {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B1B3A"><meta name="robots" content="noindex"><title>${atlasHtmlEscape(title)}</title><style>${atlasDemoStyles()}</style></head><body>${content}</body></html>`;
}

async function atlasDemoDashboard(role, message = '', error = '') {
  const state = await atlasDemoState();
  const isTrainer = role === 'trainer';
  const inviteDone = state.linked || Boolean(state.invitation);
  const availabilityDone = state.availability.length > 0;
  const workoutDone = state.workouts.length > 0;
  const executionDone = state.completed;

  const steps = [
    ['Convite', inviteDone],
    ['Disponibilidade', availabilityDone],
    ['Prescrição', workoutDone],
    ['Execução', executionDone],
  ].map(([label, done], index) =>
    `<div class="step ${done ? 'done' : ''}">${done ? '✓' : index + 1} · ${label}</div>`
  ).join('');

  const daysDisplay = ATLAS_DEMO_DAY_SHORT.map((label, index) =>
    `<span class="day ${state.availability.includes(index) ? 'active' : ''}">${label}</span>`
  ).join('');

  const workoutRows = state.workouts.map((workout) => {
    const status = workout.completedAt ? 'Concluído' : workout.sessionId ? 'Em execução' : 'Prescrito';
    return `<div class="workout"><div><strong>${atlasHtmlEscape(workout.name)}</strong><small>${atlasHtmlEscape(workout.model)} · ${workout.scheduledDays.map((day) => ATLAS_DEMO_DAY_NAMES[day]).join(' · ')}</small></div><span class="badge">${status}</span></div>`;
  }).join('');

  let body = '';
  if (isTrainer) {
    const inviteBody = state.linked
      ? `<div class="state"><div><strong>Aluno Atlas</strong><small>aluno@atlas.test</small></div><span class="badge">Vinculado</span></div>`
      : state.invitation
        ? `<div class="state"><div><strong>Aluno Atlas</strong><small>Convite enviado</small></div><span class="badge">Aguardando aceite</span></div>`
        : `<form method="post" action="/atlas-demo/invite"><button class="btn" type="submit">Enviar convite para Aluno Atlas</button></form>`;

    const availabilityBody = availabilityDone
      ? `<div class="days">${daysDisplay}</div><strong>${state.availability.length} dias: ${state.availability.map((day) => ATLAS_DEMO_DAY_NAMES[day]).join(' · ')}</strong>`
      : `<p>${state.linked ? 'Aguardando o aluno informar os dias disponíveis.' : 'O aluno precisa aceitar o convite primeiro.'}</p>`;

    const prescribeBody = availabilityDone
      ? (workoutDone
          ? `<p>O treino já foi prescrito. Acompanhe o status abaixo.</p>`
          : `<form method="post" action="/atlas-demo/prescribe"><button class="btn" type="submit">Prescrever Treino A — Peito & Costas</button></form>`)
      : `<p>A prescrição será liberada depois que o aluno salvar a disponibilidade.</p>`;

    body = `
      <section class="panel"><div class="panel-head"><div><h2>1. Convidar aluno</h2><p>O vínculo só existe depois do aceite.</p></div>${state.linked ? '<span class="badge">Vinculado</span>' : ''}</div>${inviteBody}</section>
      <section class="panel"><div class="panel-head"><div><h2>2. Disponibilidade do aluno</h2><p>Somente o aluno escolhe quando consegue treinar.</p></div>${availabilityDone ? '<span class="badge">Informada</span>' : ''}</div>${availabilityBody}</section>
      <section class="panel"><div class="panel-head"><div><h2>3. Prescrever treino</h2><p>O treino respeita a disponibilidade informada.</p></div>${workoutDone ? '<span class="badge">Prescrito</span>' : ''}</div>${prescribeBody}${workoutRows}</section>
    `;
  } else {
    const pendingInvite = state.invitation && !state.invitation.accepted_at && !state.linked;
    const inviteBody = state.linked
      ? '<span class="badge">Professor vinculado</span>'
      : pendingInvite
        ? `<form method="post" action="/atlas-demo/accept"><button class="btn" type="submit">Aceitar convite do Professor Atlas</button></form>`
        : '<p>Entre como Professor Atlas e envie o convite primeiro.</p>';

    const availabilityForm = state.linked
      ? `<form method="post" action="/atlas-demo/availability"><div class="days">${ATLAS_DEMO_DAY_SHORT.map((label, index) => `<label class="day-check"><input type="checkbox" name="days" value="${index}" ${state.availability.includes(index) ? 'checked' : ''}><span class="day">${label}</span></label>`).join('')}</div><button class="btn" type="submit">Salvar disponibilidade</button></form>`
      : '<p>Aceite o convite antes de informar sua rotina.</p>';

    let studentWorkoutBody = '<p>Aguardando o professor prescrever um treino.</p>';
    if (workoutDone) {
      const latest = state.workouts[0];
      if (latest.completedAt) {
        studentWorkoutBody = `${workoutRows}<div class="actions"><span class="badge">Treino concluído</span></div>`;
      } else if (latest.sessionId) {
        studentWorkoutBody = `${workoutRows}<form method="post" action="/atlas-demo/complete"><button class="btn" type="submit">Registrar séries e concluir treino</button></form>`;
      } else {
        studentWorkoutBody = `${workoutRows}<form method="post" action="/atlas-demo/start"><button class="btn" type="submit">Iniciar treino</button></form>`;
      }
    }

    body = `
      <section class="panel"><div class="panel-head"><div><h2>1. Convite do professor</h2><p>Você decide se deseja criar o vínculo.</p></div>${state.linked ? '<span class="badge">Aceito</span>' : ''}</div>${inviteBody}</section>
      <section class="panel"><div class="panel-head"><div><h2>2. Minha disponibilidade</h2><p>Escolha os dias em que você consegue treinar.</p></div>${availabilityDone ? `<span class="badge">${state.availability.length} dias</span>` : ''}</div>${availabilityForm}</section>
      <section class="panel"><div class="panel-head"><div><h2>3. Meus treinos</h2><p>Treinos prescritos pelo Professor Atlas.</p></div>${workoutDone ? '<span class="badge">Recebido</span>' : ''}</div>${studentWorkoutBody}</section>
    `;
  }

  const notice = `${message ? `<div class="notice ok">${atlasHtmlEscape(message)}</div>` : ''}${error ? `<div class="notice err">${atlasHtmlEscape(error)}</div>` : ''}`;

  return atlasDemoShell(`
    <header class="top"><a class="brand" href="/atlas-demo"><span class="brand-mark">⌁</span>Atlas</a><nav class="switch"><a class="${isTrainer ? 'active' : ''}" href="/atlas-demo?role=trainer">Professor</a><a class="${!isTrainer ? 'active' : ''}" href="/atlas-demo?role=student">Aluno</a></nav></header>
    <main class="wrap">
      <section class="hero"><div><span class="eyebrow">${isTrainer ? 'PAINEL DO PROFESSOR' : 'PAINEL DO ALUNO'}</span><h1>${isTrainer ? 'Fluxo de acompanhamento' : 'Seu fluxo de treino'}</h1><p>${isTrainer ? 'Convide, acompanhe a disponibilidade e prescreva um treino.' : 'Aceite o professor, informe seus dias e execute o treino recebido.'}</p></div>${isTrainer ? '<form method="post" action="/atlas-demo/reset"><button class="btn ghost" type="submit">Reiniciar demo</button></form>' : ''}</section>
      <div class="steps">${steps}</div>
      ${notice}
      ${body}
    </main>
  `, 'Atlas — Fluxo integrado');
}

app.get('/atlas-demo', asyncRoute(async (req, res) => {
  const role = req.query.role === 'trainer' ? 'trainer' : req.query.role === 'student' ? 'student' : null;
  if (!role) {
    return res.type('html').send(atlasDemoShell(`
      <main class="role-page"><section class="role-box"><span class="pill">ATLAS · BACKEND CONECTADO</span><h1>Professor e aluno.<br><em>Do convite ao treino concluído.</em></h1><p>Esta versão é renderizada diretamente pelo backend. Não depende de JavaScript, CORS ou cache do navegador.</p><div class="roles"><a class="role-card" href="/atlas-demo?role=trainer"><strong>Professor Atlas</strong><span>Convite e prescrição</span></a><a class="role-card" href="/atlas-demo?role=student"><strong>Aluno Atlas</strong><span>Disponibilidade e execução</span></a></div></section></main>
    `));
  }

  res.type('html').send(await atlasDemoDashboard(
    role,
    String(req.query.m || ''),
    String(req.query.e || '')
  ));
}));

app.post('/atlas-demo/invite', asyncRoute(async (_req, res) => {
  try {
    const linked = await pool.query(
      'SELECT 1 FROM atlas_trainer_students WHERE trainer_id = $1 AND student_id = $2',
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID]
    );
    if (linked.rowCount) return atlasDemoRedirect(res, 'trainer', 'Aluno já está vinculado.');

    const pending = await pool.query(
      'SELECT id FROM atlas_invitations WHERE trainer_id = $1 AND student_email = $2 AND accepted_at IS NULL LIMIT 1',
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_EMAIL]
    );
    if (!pending.rowCount) {
      await pool.query(
        'INSERT INTO atlas_invitations (id, trainer_id, student_email) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_EMAIL]
      );
    }
    atlasDemoRedirect(res, 'trainer', 'Convite enviado. Agora entre como Aluno Atlas para aceitar.');
  } catch (error) {
    console.error('Atlas demo invite:', error);
    atlasDemoRedirect(res, 'trainer', '', 'Não foi possível enviar o convite.');
  }
}));

app.post('/atlas-demo/accept', asyncRoute(async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM atlas_invitations
       WHERE trainer_id = $1 AND student_email = $2 AND accepted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_EMAIL]
    );
    if (!rows[0]) return atlasDemoRedirect(res, 'student', '', 'Nenhum convite pendente foi encontrado.');

    await pool.query('UPDATE atlas_invitations SET accepted_at = NOW() WHERE id = $1', [rows[0].id]);
    await pool.query(
      `INSERT INTO atlas_trainer_students (id, trainer_id, student_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (trainer_id, student_id) DO NOTHING`,
      [crypto.randomUUID(), ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID]
    );
    atlasDemoRedirect(res, 'student', 'Convite aceito. Agora informe sua disponibilidade.');
  } catch (error) {
    console.error('Atlas demo accept:', error);
    atlasDemoRedirect(res, 'student', '', 'Não foi possível aceitar o convite.');
  }
}));

app.post('/atlas-demo/availability', asyncRoute(async (req, res) => {
  try {
    const raw = Array.isArray(req.body.days) ? req.body.days : req.body.days != null ? [req.body.days] : [];
    const selectedDays = [...new Set(raw.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
    if (!selectedDays.length) return atlasDemoRedirect(res, 'student', '', 'Selecione pelo menos um dia.');

    const linked = await pool.query(
      'SELECT 1 FROM atlas_trainer_students WHERE trainer_id = $1 AND student_id = $2',
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID]
    );
    if (!linked.rowCount) return atlasDemoRedirect(res, 'student', '', 'Aceite o convite primeiro.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM atlas_availability WHERE student_id = $1', [ATLAS_DEMO_STUDENT_ID]);
      for (const day of selectedDays) {
        await client.query(
          'INSERT INTO atlas_availability (id, student_id, day_of_week) VALUES ($1, $2, $3)',
          [crypto.randomUUID(), ATLAS_DEMO_STUDENT_ID, day]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    atlasDemoRedirect(res, 'student', 'Disponibilidade salva. Agora volte ao Professor Atlas.');
  } catch (error) {
    console.error('Atlas demo availability:', error);
    atlasDemoRedirect(res, 'student', '', 'Não foi possível salvar a disponibilidade.');
  }
}));

app.post('/atlas-demo/prescribe', asyncRoute(async (_req, res) => {
  try {
    const existing = await pool.query(
      'SELECT 1 FROM atlas_workouts WHERE trainer_id = $1 AND student_id = $2 LIMIT 1',
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID]
    );
    if (existing.rowCount) return atlasDemoRedirect(res, 'trainer', 'O treino já está prescrito.');

    const { rows } = await pool.query(
      'SELECT day_of_week FROM atlas_availability WHERE student_id = $1 ORDER BY day_of_week',
      [ATLAS_DEMO_STUDENT_ID]
    );
    const available = rows.map((row) => Number(row.day_of_week));
    if (!available.length) return atlasDemoRedirect(res, 'trainer', '', 'O aluno ainda não informou disponibilidade.');

    const workoutId = crypto.randomUUID();
    const scheduledDays = available.slice(0, Math.min(2, available.length));
    const exercises = [
      ['Supino reto com halteres', 3, 10, 18, 90],
      ['Remada baixa', 3, 12, 42, 75],
      ['Elevação lateral', 3, 15, 7, 60],
    ];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO atlas_workouts (id, trainer_id, student_id, name, model, notes, scheduled_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7::smallint[])`,
        [workoutId, ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID, 'Treino A — Peito & Costas', 'AB', 'Amplitude controlada e progressão de carga.', scheduledDays]
      );
      for (let index = 0; index < exercises.length; index += 1) {
        const [name, sets, reps, weight, rest] = exercises[index];
        await client.query(
          `INSERT INTO atlas_workout_exercises
            (id, workout_id, name, sets, reps, suggested_weight, rest_seconds, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [crypto.randomUUID(), workoutId, name, sets, reps, weight, rest, index]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    atlasDemoRedirect(res, 'trainer', 'Treino prescrito. Entre como Aluno Atlas para executar.');
  } catch (error) {
    console.error('Atlas demo prescribe:', error);
    atlasDemoRedirect(res, 'trainer', '', 'Não foi possível prescrever o treino.');
  }
}));

app.post('/atlas-demo/start', asyncRoute(async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM atlas_workouts
       WHERE trainer_id = $1 AND student_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [ATLAS_DEMO_TRAINER_ID, ATLAS_DEMO_STUDENT_ID]
    );
    if (!rows[0]) return atlasDemoRedirect(res, 'student', '', 'Nenhum treino foi prescrito.');

    const workoutId = rows[0].id;
    const open = await pool.query(
      `SELECT id FROM atlas_workout_sessions
       WHERE workout_id = $1 AND student_id = $2 AND completed_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [workoutId, ATLAS_DEMO_STUDENT_ID]
    );
    if (!open.rowCount) {
      await pool.query(
        'INSERT INTO atlas_workout_sessions (id, workout_id, student_id) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), workoutId, ATLAS_DEMO_STUDENT_ID]
      );
    }
    atlasDemoRedirect(res, 'student', 'Treino iniciado. Agora registre as séries e conclua.');
  } catch (error) {
    console.error('Atlas demo start:', error);
    atlasDemoRedirect(res, 'student', '', 'Não foi possível iniciar o treino.');
  }
}));

app.post('/atlas-demo/complete', asyncRoute(async (_req, res) => {
  try {
    const { rows: sessionRows } = await pool.query(
      `SELECT ws.id, ws.workout_id
       FROM atlas_workout_sessions ws
       WHERE ws.student_id = $1 AND ws.completed_at IS NULL
       ORDER BY ws.started_at DESC LIMIT 1`,
      [ATLAS_DEMO_STUDENT_ID]
    );
    const session = sessionRows[0];
    if (!session) return atlasDemoRedirect(res, 'student', '', 'Nenhum treino em execução.');

    const { rows: exercises } = await pool.query(
      `SELECT id, sets, reps, suggested_weight
       FROM atlas_workout_exercises
       WHERE workout_id = $1
       ORDER BY position`,
      [session.workout_id]
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const exercise of exercises) {
        for (let setNumber = 1; setNumber <= exercise.sets; setNumber += 1) {
          await client.query(
            `INSERT INTO atlas_set_logs
              (id, session_id, exercise_id, set_number, reps, weight, completed, notes)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE, '')
             ON CONFLICT (session_id, exercise_id, set_number)
             DO UPDATE SET reps = EXCLUDED.reps, weight = EXCLUDED.weight, completed = TRUE`,
            [crypto.randomUUID(), session.id, exercise.id, setNumber, exercise.reps, exercise.suggested_weight]
          );
        }
      }
      await client.query(
        `UPDATE atlas_workout_sessions
         SET completed_at = NOW(), notes = 'Treino concluído pelo fluxo server-rendered.'
         WHERE id = $1`,
        [session.id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    atlasDemoRedirect(res, 'student', 'Treino concluído e séries registradas no PostgreSQL.');
  } catch (error) {
    console.error('Atlas demo complete:', error);
    atlasDemoRedirect(res, 'student', '', 'Não foi possível concluir o treino.');
  }
}));

app.post('/atlas-demo/reset', asyncRoute(async (_req, res) => {
  try {
    await pool.query(`
      DELETE FROM atlas_set_logs;
      DELETE FROM atlas_workout_sessions;
      DELETE FROM atlas_workout_exercises;
      DELETE FROM atlas_workouts;
      DELETE FROM atlas_availability;
      DELETE FROM atlas_trainer_students;
      DELETE FROM atlas_invitations;
    `);
    atlasDemoRedirect(res, 'trainer', 'Demonstração reiniciada.');
  } catch (error) {
    console.error('Atlas demo reset:', error);
    atlasDemoRedirect(res, 'trainer', '', 'Não foi possível reiniciar a demonstração.');
  }
}));

app.get('*', (_req, res) => {
  res.sendFile(new URL('./public/index.html', import.meta.url).pathname);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const isUserError = error instanceof Error && /inválid|obrigat|longo|Dia deve|Mês inválido|senha|usuário/i.test(error.message);
  res.status(isUserError ? 400 : 500).json({ error: isUserError ? error.message : 'Erro interno do servidor.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ControlFinance rodando na porta ${PORT}`);
});

Promise.all([ensureSchema(), ensureAtlasSchema()])
  .then(() => console.log('Schemas ControlFinance/Atlas verificados.'))
  .catch((error) => console.error('Falha ao verificar schemas:', error));
