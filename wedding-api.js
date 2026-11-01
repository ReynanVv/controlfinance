import crypto from 'node:crypto';

const PLAN_MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const STARTING_SUPPLIERS = [
  { id: 'pomme', name: "Pomme d'Or", total: 2035220, paid: 1193060, note: 'Entrada de R$ 3.509,00 + 6 de 12 parcelas pagas.' },
  { id: 'fotos', name: 'Fotos', total: 449500, paid: 262250, note: 'Pré-wedding de R$ 750,00 pago; 5 de 10 parcelas do casamento pagas.' },
  { id: 'bebidas', name: 'Bebidas', total: 428000, paid: 257750, note: 'Parcela de outubro/2026 atrasada e redistribuída entre novembro e março.' },
  { id: 'bolo', name: 'Bolo', total: 350000, paid: 275000, note: 'Parcela de outubro/2026 atrasada e redistribuída entre novembro e março.' },
  { id: 'doces', name: 'Doces', total: 120000, paid: 120000, note: 'Integralmente pago.' },
  { id: 'cerimonial', name: 'Cerimonial', total: 400000, paid: 400000, note: 'Integralmente pago.' },
  { id: 'degustacao', name: 'Degustação', total: 32600, paid: 32600, note: 'Integralmente pago.' },
  { id: 'cantores', name: 'Cantores', total: 162000, paid: 162000, note: 'Integralmente pago.' },
  { id: 'dj', name: 'DJ', total: 330000, paid: 330000, note: 'Integralmente pago.' },
  { id: 'decoracao', name: 'Decoração', total: 2000000, paid: 600000, note: 'Entrada de R$ 6.000,00 paga; restante distribuído até março/2027.' },
];

class InvalidInput extends Error {}
const bad = (message) => { throw new InvalidInput(message); };

function toCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000000000) bad(label + ' inválido.');
  return value;
}

function supplierPayload(body) {
  const name = String(body?.name ?? '').trim();
  const note = String(body?.note ?? '').trim();
  if (!name || name.length > 120) bad('Informe um nome com até 120 caracteres.');
  if (note.length > 500) bad('Observação muito longa.');
  const totalCents = toCents(body?.totalCents, 'Valor total');
  const baselinePaidCents = toCents(body?.baselinePaidCents, 'Valor já pago');
  if (baselinePaidCents > totalCents) bad('O valor já pago não pode superar o total.');
  return { name, note, totalCents, baselinePaidCents };
}

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function monthsForNewExpense() {
  const today = new Date();
  const current = String(today.getFullYear()) + '-' + String(today.getMonth() + 1).padStart(2, '0');
  const eligible = PLAN_MONTHS.filter((value) => value >= current);
  return eligible.length ? eligible : ['2027-03'];
}

async function rebalance(client, supplierId) {
  const { rows: suppliers } = await client.query(
    'SELECT id, total_cents, baseline_paid_cents FROM wedding_suppliers WHERE id = $1 FOR UPDATE',
    [supplierId]
  );
  if (!suppliers.length) bad('Fornecedor não encontrado.');

  const { rows } = await client.query(
    'SELECT id, amount_cents, paid FROM wedding_installments WHERE supplier_id = $1 ORDER BY month, created_at, id FOR UPDATE',
    [supplierId]
  );
  const paid = rows.filter((row) => row.paid).reduce((sum, row) => sum + Number(row.amount_cents), 0);
  const due = Number(suppliers[0].total_cents) - Number(suppliers[0].baseline_paid_cents) - paid;
  if (due < 0) bad('Os pagamentos superam o valor contratado.');

  let unpaid = rows.filter((row) => !row.paid);
  if (due === 0) {
    await client.query('DELETE FROM wedding_installments WHERE supplier_id = $1 AND paid = FALSE', [supplierId]);
    return;
  }
  if (!unpaid.length) {
    const id = crypto.randomUUID();
    await client.query(
      'INSERT INTO wedding_installments (id, supplier_id, month, amount_cents) VALUES ($1, $2, $3, $4)',
      [id, supplierId, '2027-03', due]
    );
    return;
  }
  const each = Math.floor(due / unpaid.length);
  const leftover = due % unpaid.length;
  for (let index = 0; index < unpaid.length; index++) {
    await client.query('UPDATE wedding_installments SET amount_cents = $2 WHERE id = $1',
      [unpaid[index].id, each + (index < leftover ? 1 : 0)]);
  }
}

export async function ensureWeddingSchema(pool) {
  await pool.query([
    'CREATE TABLE IF NOT EXISTS wedding_meta (key TEXT PRIMARY KEY);',
    'CREATE TABLE IF NOT EXISTS wedding_suppliers (',
    '  id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT \'\',',
    '  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),',
    '  baseline_paid_cents BIGINT NOT NULL CHECK (baseline_paid_cents >= 0),',
    '  sort_order INTEGER NOT NULL DEFAULT 100,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ');',
    'CREATE TABLE IF NOT EXISTS wedding_installments (',
    '  id UUID PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES wedding_suppliers(id) ON DELETE CASCADE,',
    '  month VARCHAR(7) NOT NULL, amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),',
    '  paid BOOLEAN NOT NULL DEFAULT FALSE, paid_on DATE,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_wedding_installments_supplier ON wedding_installments(supplier_id);',
    'CREATE INDEX IF NOT EXISTS idx_wedding_installments_month ON wedding_installments(month);',
  ].join('\n'));

  await transaction(pool, async (client) => {
    const seeded = await client.query(
      "INSERT INTO wedding_meta (key) VALUES ('seeded_v1') ON CONFLICT DO NOTHING RETURNING key"
    );
    if (!seeded.rowCount) return;
    for (const [index, item] of STARTING_SUPPLIERS.entries()) {
      await client.query(
        'INSERT INTO wedding_suppliers (id, name, note, total_cents, baseline_paid_cents, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [item.id, item.name, item.note, item.total, item.paid, index]
      );
      const due = item.total - item.paid;
      if (!due) continue;
      const each = Math.floor(due / PLAN_MONTHS.length);
      const leftover = due % PLAN_MONTHS.length;
      for (const [monthIndex, planMonth] of PLAN_MONTHS.entries()) {
        await client.query(
          'INSERT INTO wedding_installments (id, supplier_id, month, amount_cents) VALUES ($1,$2,$3,$4)',
          [crypto.randomUUID(), item.id, planMonth, each + (monthIndex < leftover ? 1 : 0)]
        );
      }
    }
  });
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch((error) => {
    if (error instanceof InvalidInput) return res.status(400).json({ error: error.message });
    next(error);
  });
}

export function registerWeddingRoutes(app, pool) {
  // All endpoints are registered after the existing /api authentication middleware.
  app.get('/api/wedding', wrap(async (_req, res) => {
    const [supplierResult, installmentResult] = await Promise.all([
      pool.query('SELECT id, name, note, total_cents, baseline_paid_cents FROM wedding_suppliers ORDER BY sort_order, created_at, id'),
      pool.query('SELECT id, supplier_id, month, amount_cents, paid, paid_on FROM wedding_installments ORDER BY month, created_at, id'),
    ]);
    const suppliers = supplierResult.rows.map((row) => {
      const installments = installmentResult.rows.filter((item) => item.supplier_id === row.id)
        .map((item) => ({
          id: item.id,
          month: item.month,
          amountCents: Number(item.amount_cents),
          paid: item.paid,
          paidOn: item.paid_on ? new Date(item.paid_on).toISOString().slice(0, 10) : null,
        }));
      const paidCents = Number(row.baseline_paid_cents) +
        installments.filter((item) => item.paid).reduce((sum, item) => sum + item.amountCents, 0);
      return {
        id: row.id, name: row.name, note: row.note,
        totalCents: Number(row.total_cents),
        baselinePaidCents: Number(row.baseline_paid_cents),
        paidCents, remainingCents: Number(row.total_cents) - paidCents,
        installments,
      };
    });
    res.json({ suppliers, deadline: '2027-03-20' });
  }));

  app.post('/api/wedding/suppliers', wrap(async (req, res) => {
    const payload = supplierPayload(req.body);
    const id = crypto.randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        'INSERT INTO wedding_suppliers (id, name, note, total_cents, baseline_paid_cents) VALUES ($1,$2,$3,$4,$5)',
        [id, payload.name, payload.note, payload.totalCents, payload.baselinePaidCents]
      );
      const due = payload.totalCents - payload.baselinePaidCents;
      if (!due) return;
      for (const month of monthsForNewExpense()) {
        await client.query('INSERT INTO wedding_installments (id, supplier_id, month, amount_cents) VALUES ($1,$2,$3,0)',
          [crypto.randomUUID(), id, month]);
      }
      await rebalance(client, id);
    });
    res.status(201).json({ id });
  }));

  app.put('/api/wedding/suppliers/:id', wrap(async (req, res) => {
    const payload = supplierPayload(req.body);
    await transaction(pool, async (client) => {
      const updated = await client.query(
        'UPDATE wedding_suppliers SET name=$2, note=$3, total_cents=$4, baseline_paid_cents=$5 WHERE id=$1 RETURNING id',
        [req.params.id, payload.name, payload.note, payload.totalCents, payload.baselinePaidCents]
      );
      if (!updated.rowCount) bad('Fornecedor não encontrado.');
      await rebalance(client, req.params.id);
    });
    res.json({ ok: true });
  }));

  app.delete('/api/wedding/suppliers/:id', wrap(async (req, res) => {
    const result = await pool.query('DELETE FROM wedding_suppliers WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.status(204).end();
  }));

  app.patch('/api/wedding/installments/:id', wrap(async (req, res) => {
    if (typeof req.body?.paid !== 'boolean') bad('Informe o status do pagamento.');
    const amount = req.body.paid ? toCents(req.body.amountCents, 'Valor pago') : null;
    if (req.body.paid && amount === 0) bad('Informe um valor pago maior que zero.');
    const paidOn = req.body.paid ? String(req.body.paidOn ?? '').trim() : null;
    if (req.body.paid && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) bad('Data de pagamento inválida.');

    await transaction(pool, async (client) => {
      const installment = await client.query(
        'SELECT id, supplier_id FROM wedding_installments WHERE id = $1', [req.params.id]
      );
      if (!installment.rowCount) bad('Parcela não encontrada.');
      // Lock the supplier to serialize changes to its installments.
      await client.query('SELECT id FROM wedding_suppliers WHERE id=$1 FOR UPDATE', [installment.rows[0].supplier_id]);
      await client.query(
        'UPDATE wedding_installments SET paid=$2, amount_cents=COALESCE($3,amount_cents), paid_on=$4 WHERE id=$1',
        [req.params.id, req.body.paid, amount, paidOn]
      );
      await rebalance(client, installment.rows[0].supplier_id);
    });
    res.json({ ok: true });
  }));
}
