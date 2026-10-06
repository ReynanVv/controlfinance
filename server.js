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
app.use(cookieParser(SESSION_SECRET));
app.use(express.static('public'));

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

app.get('*', (_req, res) => {
  res.sendFile(new URL('./public/index.html', import.meta.url).pathname);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const isUserError = error instanceof Error && /inválid|obrigat|longo|Dia deve|Mês inválido|senha|usuário/i.test(error.message);
  res.status(isUserError ? 400 : 500).json({ error: isUserError ? error.message : 'Erro interno do servidor.' });
});

await ensureSchema();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ControlFinance rodando na porta ${PORT}`);
});
