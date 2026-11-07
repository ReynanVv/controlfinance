import crypto from 'node:crypto';

const MONTHS = ['2026-11','2026-12','2027-01','2027-02','2027-03'];
const INITIAL = [
  ["Pomme d'Or",2035220,1193060,"Entrada de R$ 3.509,00 paga; 6 de 12 parcelas pagas. Restam 6 parcelas de R$ 1.403,60, duas em novembro e uma por mês até março."],
  ['Fotos',449500,262250,'Pré-casamento pago e 5 de 10 parcelas pagas.'],
  ['Bebidas',428000,257750,'Uma parcela de outubro/2026 atrasada; saldo redistribuído até março.'],
  ['Bolo',350000,275000,'Uma parcela de outubro/2026 atrasada; saldo redistribuído até março.'],
  ['Doces',120000,120000,'Integralmente pago.'],
  ['Cerimonial',400000,400000,'Integralmente pago.'],
  ['Degustação',32600,32600,'Integralmente pago.'],
  ['Cantores',162000,162000,'Integralmente pago.'],
  ['DJ',330000,330000,'Integralmente pago.'],
  ['Decoração',2000000,600000,'Entrada de R$ 6.000,00 paga; saldo até março de 2027.'],
];

class InvalidWeddingInput extends Error {}
function invalid(message) { throw new InvalidWeddingInput(message); }
function cents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000000000) invalid(field + ' inválido.');
  return value;
}
function fields(body) {
  const name=String(body?.name??'').trim();
  const note=String(body?.note??'').trim();
  const total=cents(body?.totalCents,'Valor total');
  const baseline=cents(body?.baselinePaidCents,'Valor pago');
  if (!name || name.length>120) invalid('Nome inválido ou muito longo.');
  if (note.length>500) invalid('Observação muito longa.');
  if (baseline>total) invalid('O valor pago não pode superar o total.');
  return {name,note,total,baseline};
}
async function tx(pool, fn) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const result=await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
function validMonth() {
  const now=new Date();
  const key=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  const rest=MONTHS.filter(month=>month>=key);
  return rest.length ? rest : ['2027-03'];
}
async function rebalance(client, userId, supplierId) {
  const supplier=await client.query(
    'SELECT id,total_cents,baseline_paid_cents FROM cf_wedding_suppliers WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [supplierId,userId]
  );
  if (!supplier.rowCount) invalid('Fornecedor não encontrado.');
  const result=await client.query(
    'SELECT id,amount_cents,paid FROM cf_wedding_installments WHERE supplier_id=$1 AND user_id=$2 ORDER BY month,created_at,id FOR UPDATE',
    [supplierId,userId]
  );
  const paid=result.rows.filter(row=>row.paid).reduce((sum,row)=>sum+Number(row.amount_cents),0);
  const due=Number(supplier.rows[0].total_cents)-Number(supplier.rows[0].baseline_paid_cents)-paid;
  if (due<0) invalid('Pagamentos realizados superam o contrato.');
  const unpaid=result.rows.filter(row=>!row.paid);
  if (!due) {
    await client.query('DELETE FROM cf_wedding_installments WHERE supplier_id=$1 AND user_id=$2 AND paid=FALSE',[supplierId,userId]);
    return;
  }
  if (!unpaid.length) {
    await client.query(
      'INSERT INTO cf_wedding_installments (id,user_id,supplier_id,month,amount_cents) VALUES ($1,$2,$3,$4,$5)',
      [crypto.randomUUID(),userId,supplierId,'2027-03',due]
    );
    return;
  }
  const each=Math.floor(due/unpaid.length), remainder=due%unpaid.length;
  for (let i=0;i<unpaid.length;i++) {
    await client.query('UPDATE cf_wedding_installments SET amount_cents=$3 WHERE id=$1 AND user_id=$2',
      [unpaid[i].id,userId,each+(i<remainder?1:0)]);
  }
}
function route(fn) {
  return (req,res,next)=>Promise.resolve(fn(req,res)).catch(error=>{
    if (error instanceof InvalidWeddingInput) return res.status(400).json({error:error.message});
    next(error);
  });
}
export async function ensureWeddingSchema(pool) {
  await pool.query([
    'CREATE TABLE IF NOT EXISTS cf_wedding_seeds (user_id UUID PRIMARY KEY REFERENCES cf_users(id) ON DELETE CASCADE);',
    'CREATE TABLE IF NOT EXISTS cf_wedding_suppliers (',
    ' id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES cf_users(id) ON DELETE CASCADE,',
    " name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',",
    ' total_cents BIGINT NOT NULL CHECK(total_cents>=0),',
    ' baseline_paid_cents BIGINT NOT NULL CHECK(baseline_paid_cents>=0),',
    ' sort_order INTEGER NOT NULL DEFAULT 100, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ');',
    'CREATE TABLE IF NOT EXISTS cf_wedding_installments (',
    ' id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES cf_users(id) ON DELETE CASCADE,',
    ' supplier_id UUID NOT NULL REFERENCES cf_wedding_suppliers(id) ON DELETE CASCADE,',
    ' month VARCHAR(7) NOT NULL, amount_cents BIGINT NOT NULL CHECK(amount_cents>=0),',
    ' paid BOOLEAN NOT NULL DEFAULT FALSE, paid_on DATE,',
    ' created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_cf_wedding_suppliers_user ON cf_wedding_suppliers(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_cf_wedding_installments_user_supplier ON cf_wedding_installments(user_id,supplier_id);'
  ].join('\n'));

  // Repair untouched Pomme d'Or plans imported by the previous version.
  // Only the original five unpaid R$ 1.684,32 installments qualify;
  // never overwrite edited amounts or recorded payments.
  await tx(pool,async client=>{
    const result=await client.query(`
      SELECT s.id,s.user_id
      FROM cf_wedding_suppliers s
      JOIN cf_wedding_seeds seed ON seed.user_id=s.user_id
      JOIN cf_wedding_installments p ON p.supplier_id=s.id AND p.user_id=s.user_id
      WHERE s.name='Pomme d''Or' AND s.total_cents=2035220 AND s.baseline_paid_cents=1193060
      GROUP BY s.id,s.user_id
      HAVING COUNT(*)=5
        AND BOOL_AND(p.paid=FALSE AND p.amount_cents=168432)
        AND ARRAY_AGG(p.month ORDER BY p.month) = ARRAY['2026-11','2026-12','2027-01','2027-02','2027-03']
    `);
    for(const row of result.rows) {
      await client.query('SELECT id FROM cf_wedding_suppliers WHERE id=$1 AND user_id=$2 FOR UPDATE',[row.id,row.user_id]);
      const current=await client.query(
        'SELECT month,amount_cents,paid FROM cf_wedding_installments WHERE supplier_id=$1 AND user_id=$2 ORDER BY month FOR UPDATE',
        [row.id,row.user_id]
      );
      if(current.rows.length!==5 ||
        current.rows.some((part,i)=>part.month!==MONTHS[i] || part.paid || Number(part.amount_cents)!==168432)) continue;
      await client.query(
        'UPDATE cf_wedding_installments SET amount_cents=140360 WHERE supplier_id=$1 AND user_id=$2 AND paid=FALSE',
        [row.id,row.user_id]
      );
      await client.query(
        'INSERT INTO cf_wedding_installments(id,user_id,supplier_id,month,amount_cents) VALUES($1,$2,$3,$4,$5)',
        [crypto.randomUUID(),row.user_id,row.id,'2026-11',140360]
      );
      await client.query(
        `UPDATE cf_wedding_suppliers SET note=$3 WHERE id=$1 AND user_id=$2
           AND note='Entrada de R$ 3.509,00 e 6 de 12 parcelas pagas.'`,
        [row.id,row.user_id,INITIAL[0][3]]
      );
    }
  });

}

export function registerWeddingRoutes(app,pool) {
  app.get('/api/wedding',route(async(req,res)=>{
    const [supResult,partsResult,initResult]=await Promise.all([
      pool.query('SELECT id,name,note,total_cents,baseline_paid_cents FROM cf_wedding_suppliers WHERE user_id=$1 ORDER BY sort_order,created_at,id',[req.userId]),
      pool.query('SELECT id,supplier_id,month,amount_cents,paid,paid_on FROM cf_wedding_installments WHERE user_id=$1 ORDER BY month,created_at,id',[req.userId]),
      pool.query('SELECT 1 FROM cf_wedding_seeds WHERE user_id=$1',[req.userId])
    ]);
    const bySupplier=new Map();
    for(const part of partsResult.rows) {
      if(!bySupplier.has(part.supplier_id)) bySupplier.set(part.supplier_id,[]);
      bySupplier.get(part.supplier_id).push({
        id:part.id,month:part.month,amountCents:Number(part.amount_cents),paid:part.paid,
        paidOn:part.paid_on?new Date(part.paid_on).toISOString().slice(0,10):null
      });
    }
    res.json({initialized:Boolean(initResult.rowCount),deadline:'2027-03-20',
      suppliers:supResult.rows.map(s=>{
        const installments=bySupplier.get(s.id)||[];
        const paidCents=Number(s.baseline_paid_cents)+installments.filter(p=>p.paid).reduce((sum,p)=>sum+p.amountCents,0);
        return {
          id:s.id,name:s.name,note:s.note,totalCents:Number(s.total_cents),
          baselinePaidCents:Number(s.baseline_paid_cents),
          paidCents,remainingCents:Number(s.total_cents)-paidCents,installments
        };
      })
    });
  }));

  app.post('/api/wedding/initialize',route(async(req,res)=>{
    const added=await tx(pool,async client=>{
      const inserted=await client.query(
        'INSERT INTO cf_wedding_seeds(user_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING user_id',[req.userId]
      );
      if(!inserted.rowCount) return false;
      // Do not preload a personal wedding into an account with manually created suppliers.
      const existing=await client.query('SELECT 1 FROM cf_wedding_suppliers WHERE user_id=$1 LIMIT 1',[req.userId]);
      if(existing.rowCount) return true;
      for(const [i,[name,total,baseline,note]] of INITIAL.entries()){
        const supplierId=crypto.randomUUID();
        await client.query(
          'INSERT INTO cf_wedding_suppliers(id,user_id,name,note,total_cents,baseline_paid_cents,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [supplierId,req.userId,name,note,total,baseline,i]
        );
        const due=total-baseline;
        if(!due) continue;
        // Pomme d'Or: preserve the contractual installment of R$ 1.403,60.
        // Six pending installments over five months: two in November.
        const schedule=i===0 ? [MONTHS[0],...MONTHS] : MONTHS;
        const each=Math.floor(due/schedule.length),remainder=due%schedule.length;
        for(const [m,month] of schedule.entries()){
          await client.query(
            'INSERT INTO cf_wedding_installments(id,user_id,supplier_id,month,amount_cents) VALUES($1,$2,$3,$4,$5)',
            [crypto.randomUUID(),req.userId,supplierId,month,each+(m<remainder?1:0)]
          );
        }
      }
      return true;
    });
    res.json({initialized:true,added});
  }));

  app.post('/api/wedding/suppliers',route(async(req,res)=>{
    const p=fields(req.body), id=crypto.randomUUID();
    await tx(pool,async client=>{
      await client.query(
        'INSERT INTO cf_wedding_suppliers(id,user_id,name,note,total_cents,baseline_paid_cents) VALUES($1,$2,$3,$4,$5,$6)',
        [id,req.userId,p.name,p.note,p.total,p.baseline]
      );
      if(p.total===p.baseline) return;
      for(const month of validMonth()) await client.query(
        'INSERT INTO cf_wedding_installments(id,user_id,supplier_id,month,amount_cents) VALUES($1,$2,$3,$4,0)',
        [crypto.randomUUID(),req.userId,id,month]
      );
      await rebalance(client,req.userId,id);
    });
    res.status(201).json({id});
  }));

  app.put('/api/wedding/suppliers/:id',route(async(req,res)=>{
    const p=fields(req.body);
    await tx(pool,async client=>{
      const updated=await client.query(
        'UPDATE cf_wedding_suppliers SET name=$3,note=$4,total_cents=$5,baseline_paid_cents=$6 WHERE id=$1 AND user_id=$2 RETURNING id',
        [req.params.id,req.userId,p.name,p.note,p.total,p.baseline]
      );
      if(!updated.rowCount) invalid('Fornecedor não encontrado.');
      await rebalance(client,req.userId,req.params.id);
    });
    res.json({ok:true});
  }));

  app.delete('/api/wedding/suppliers/:id',route(async(req,res)=>{
    const result=await pool.query('DELETE FROM cf_wedding_suppliers WHERE id=$1 AND user_id=$2',[req.params.id,req.userId]);
    if(!result.rowCount) return res.status(404).json({error:'Fornecedor não encontrado.'});
    res.status(204).end();
  }));

  app.patch('/api/wedding/installments/:id',route(async(req,res)=>{
    if(typeof req.body?.paid!=='boolean') invalid('Informe o status de pagamento.');
    const amount=req.body.paid?cents(req.body.amountCents,'Valor pago'):null;
    if(req.body.paid && !amount) invalid('Informe um valor maior que zero.');
    const date=req.body.paid?String(req.body.paidOn??'').trim():null;
    if(req.body.paid && !/^\d{4}-\d{2}-\d{2}$/.test(date)) invalid('Data inválida.');
    await tx(pool,async client=>{
      const part=await client.query(
        'SELECT supplier_id FROM cf_wedding_installments WHERE id=$1 AND user_id=$2',[req.params.id,req.userId]
      );
      if(!part.rowCount) invalid('Parcela não encontrada.');
      const supplierId=part.rows[0].supplier_id;
      await client.query('SELECT 1 FROM cf_wedding_suppliers WHERE id=$1 AND user_id=$2 FOR UPDATE',[supplierId,req.userId]);
      await client.query(
        'UPDATE cf_wedding_installments SET paid=$3,amount_cents=COALESCE($4,amount_cents),paid_on=$5 WHERE id=$1 AND user_id=$2',
        [req.params.id,req.userId,req.body.paid,amount,date]
      );
      await rebalance(client,req.userId,supplierId);
    });
    res.json({ok:true});
  }));
}
