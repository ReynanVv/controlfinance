import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada.');
}

if (process.env.NODE_ENV === 'production' && (!APP_PASSWORD || !SESSION_SECRET)) {
  throw new Error('Em produção, APP_PASSWORD e SESSION_SECRET são obrigatórios.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
});

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser(SESSION_SECRET || 'dev-secret'));
app.use(express.static('public'));

const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

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

function safeCompare(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signedIn(req) {
  return req.signedCookies?.controlfinance === 'ok';
}

function requireAuth(req, res, next) {
  if (!APP_PASSWORD || signedIn(req)) return next();
  return res.status(401).json({ error: 'Não autenticado.' });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incomes (
      id UUID PRIMARY KEY,
      month VARCHAR(7) NOT NULL,
      name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      day SMALLINT CHECK (day BETWEEN 1 AND 31),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id UUID PRIMARY KEY,
      month VARCHAR(7) NOT NULL,
      name TEXT NOT NULL,
      base_amount NUMERIC(12,2) NOT NULL CHECK (base_amount >= 0),
      day SMALLINT CHECK (day BETWEEN 1 AND 31),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subexpenses (
      id UUID PRIMARY KEY,
      expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      day SMALLINT CHECK (day BETWEEN 1 AND 31),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_incomes_month ON incomes(month);
    CREATE INDEX IF NOT EXISTS idx_expenses_month ON expenses(month);
    CREATE INDEX IF NOT EXISTS idx_subexpenses_expense ON subexpenses(expense_id);
  `);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/auth/status', (req, res) => {
  res.json({ required: Boolean(APP_PASSWORD), authenticated: !APP_PASSWORD || signedIn(req) });
});

app.post('/api/auth/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  if (!safeCompare(req.body?.password ?? '', APP_PASSWORD)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  res.cookie('controlfinance', 'ok', {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('controlfinance');
  res.json({ ok: true });
});

app.use('/api', requireAuth);

app.get('/api/months', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT month FROM incomes
    UNION
    SELECT month FROM expenses
    ORDER BY month DESC
  `);
  res.json({ months: rows.map((row) => row.month) });
}));

app.get('/api/summary', asyncRoute(async (req, res) => {
  const selectedMonth = month(req.query.month);

  const [incomeResult, expenseResult] = await Promise.all([
    pool.query(`
      SELECT id, month, name, amount::float8 AS amount, day, notes
      FROM incomes
      WHERE month = $1
      ORDER BY day NULLS LAST, created_at
    `, [selectedMonth]),
    pool.query(`
      SELECT
        e.id, e.month, e.name, e.base_amount::float8 AS "baseAmount", e.day, e.notes,
        COALESCE(SUM(s.amount), 0)::float8 AS "subTotal"
      FROM expenses e
      LEFT JOIN subexpenses s ON s.expense_id = e.id
      WHERE e.month = $1
      GROUP BY e.id
      ORDER BY e.day NULLS LAST, e.created_at
    `, [selectedMonth]),
  ]);

  const expenseIds = expenseResult.rows.map((item) => item.id);
  let subRows = [];
  if (expenseIds.length) {
    const result = await pool.query(`
      SELECT id, expense_id AS "expenseId", name, amount::float8 AS amount, day, notes
      FROM subexpenses
      WHERE expense_id = ANY($1::uuid[])
      ORDER BY day NULLS LAST, created_at
    `, [expenseIds]);
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
    INSERT INTO incomes (id, month, name, amount, day, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, month, name, amount::float8 AS amount, day, notes
  `, [id, payload.month, payload.name, payload.amount, payload.day, payload.notes]);
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
    UPDATE incomes
    SET month = $2, name = $3, amount = $4, day = $5, notes = $6, updated_at = NOW()
    WHERE id = $1
    RETURNING id, month, name, amount::float8 AS amount, day, notes
  `, [req.params.id, payload.month, payload.name, payload.amount, payload.day, payload.notes]);

  if (!rows[0]) return res.status(404).json({ error: 'Ganho não encontrado.' });
  res.json(rows[0]);
}));

app.delete('/api/incomes/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM incomes WHERE id = $1', [req.params.id]);
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
    INSERT INTO expenses (id, month, name, base_amount, day, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, month, name, base_amount::float8 AS "baseAmount", day, notes
  `, [id, payload.month, payload.name, payload.baseAmount, payload.day, payload.notes]);
  res.status(201).json(rows[0]);
}));

app.put('/api/expenses/:id', asyncRoute(async (req, res) => {
  const payload = {
    month: month(req.body.month),
    name: text(req.body.name, 'Nome', true, 120),
    baseAmount: money(req.body.baseAmount ?? req.body.amount),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows } = await pool.query(`
    UPDATE expenses
    SET month = $2, name = $3, base_amount = $4, day = $5, notes = $6, updated_at = NOW()
    WHERE id = $1
    RETURNING id, month, name, base_amount::float8 AS "baseAmount", day, notes
  `, [req.params.id, payload.month, payload.name, payload.baseAmount, payload.day, payload.notes]);

  if (!rows[0]) return res.status(404).json({ error: 'Gasto não encontrado.' });
  res.json(rows[0]);
}));

app.delete('/api/expenses/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Gasto não encontrado.' });
  res.status(204).end();
}));

app.post('/api/expenses/:expenseId/subexpenses', asyncRoute(async (req, res) => {
  const expenseExists = await pool.query('SELECT 1 FROM expenses WHERE id = $1', [req.params.expenseId]);
  if (!expenseExists.rowCount) return res.status(404).json({ error: 'Gasto não encontrado.' });

  const id = crypto.randomUUID();
  const payload = {
    name: text(req.body.name, 'Nome', true, 120),
    amount: money(req.body.amount),
    day: day(req.body.day),
    notes: text(req.body.notes, 'Observação', false, 500),
  };

  const { rows } = await pool.query(`
    INSERT INTO subexpenses (id, expense_id, name, amount, day, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, expense_id AS "expenseId", name, amount::float8 AS amount, day, notes
  `, [id, req.params.expenseId, payload.name, payload.amount, payload.day, payload.notes]);
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
    UPDATE subexpenses
    SET name = $2, amount = $3, day = $4, notes = $5, updated_at = NOW()
    WHERE id = $1
    RETURNING id, expense_id AS "expenseId", name, amount::float8 AS amount, day, notes
  `, [req.params.id, payload.name, payload.amount, payload.day, payload.notes]);

  if (!rows[0]) return res.status(404).json({ error: 'Subgasto não encontrado.' });
  res.json(rows[0]);
}));

app.delete('/api/subexpenses/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM subexpenses WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Subgasto não encontrado.' });
  res.status(204).end();
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  const isUserError = error instanceof Error && /inválid|obrigat|longo|Dia deve|Mês inválido/i.test(error.message);
  res.status(isUserError ? 400 : 500).json({ error: isUserError ? error.message : 'Erro interno do servidor.' });
});

await ensureSchema();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ControlFinance rodando na porta ${PORT}`);
});
