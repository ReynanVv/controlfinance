const w = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const DEFAULT_MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const state = { suppliers: [] };
const fmt = (cents) => currency.format(cents / 100);
const inputMoney = (cents) => (cents / 100).toFixed(2).replace('.', ',');

function clean(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function toCents(value) {
  const raw = String(value ?? '').replace(/\s/g, '');
  if (!raw) throw new Error('Informe um valor.');
  let normalized = raw;
  if (raw.includes(',') && raw.includes('.')) normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.')
    ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  else if (raw.includes(',')) normalized = raw.replace(',', '.');
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) throw new Error('Valor inválido.');
  return Math.round(amount * 100);
}
function dateToday() {
  const d = new Date();
  return String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function currentMonth() { return dateToday().slice(0, 7); }
function monthName(ym) {
  const [year, month] = ym.split('-').map(Number);
  const s = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) showLogin();
    throw new Error(data.error || 'Não foi possível concluir a operação.');
  }
  return response.status === 204 ? null : response.json();
}
function showLogin() {
  w('weddingContent').classList.add('hidden');
  w('weddingLoading').classList.add('hidden');
  w('weddingLogin').classList.remove('hidden');
}
function message(value, error = false) {
  const node = w('weddingToast');
  node.textContent = value;
  node.classList.toggle('error', error);
  node.classList.add('show');
  clearTimeout(message.timer);
  message.timer = setTimeout(() => node.classList.remove('show'), 3000);
}
async function load() {
  const data = await api('/api/wedding');
  state.suppliers = data.suppliers;
  w('weddingSetup').classList.toggle('hidden', !!data.initialized);
  w('weddingLogin').classList.add('hidden');
  w('weddingLoading').classList.add('hidden');
  w('weddingPageError').classList.add('hidden');
  w('weddingContent').classList.remove('hidden');
  render();
}
function render() {
  const total = state.suppliers.reduce((sum, s) => sum + s.totalCents, 0);
  const paid = state.suppliers.reduce((sum, s) => sum + s.paidCents, 0);
  const due = total - paid;
  const pct = total ? Math.round(paid * 1000 / total) / 10 : 100;
  const finished = state.suppliers.filter((s) => !s.remainingCents).length;
  w('weddingTotal').textContent = fmt(total);
  w('weddingPaid').textContent = fmt(paid);
  w('weddingDue').textContent = fmt(due);
  w('weddingPercent').textContent = pct.toLocaleString('pt-BR') + '%';
  w('weddingProgressFill').style.width = Math.min(100, pct) + '%';
  w('weddingProgressText').textContent = finished + ' de ' + state.suppliers.length +
    ' fornecedores quitados · o casamento não entra nas contas mensais.';
  renderSchedule();
  renderSuppliers();
}
function scheduleMonths() {
  const found = new Set();
  for (const supplier of state.suppliers) {
    for (const installment of supplier.installments) found.add(installment.month);
  }
  const sorted = [...found].sort();
  return sorted.length ? sorted : DEFAULT_MONTHS;
}
function renderSchedule() {
  w('weddingSchedule').innerHTML = scheduleMonths().map((month) => {
    const rows = state.suppliers.flatMap((supplier) => supplier.installments
      .filter((part) => part.month === month).map((part) => ({ ...part, supplier })));
    const due = rows.filter((row) => !row.paid).reduce((sum, row) => sum + row.amountCents, 0);
    const settled = rows.filter((row) => row.paid).reduce((sum, row) => sum + row.amountCents, 0);
    const content = rows.length ? rows.map((row) =>
      '<div class="wedding-payment-row"><div><div class="wedding-payment-name">' + clean(row.supplier.name) +
      (row.supplier.name === "Pomme d'Or" && row.supplier.totalCents === 1754500 &&
       row.supplier.installments.length === 4
        ? ' · ' + String(row.supplier.installments.findIndex((p) => p.id === row.id) + 7) + '/10' : '') +
      '</div><div class="wedding-payment-meta">' + (row.paid ? 'Pago em ' + clean(row.paidOn || '—') :
      (row.month < currentMonth() ? 'Em atraso' : 'Previsto')) +
      (row.supplier.name === "Pomme d'Or" && row.supplier.totalCents === 1754500 ? ' · vencimento dia 20' : '') +
      '</div></div><div class="wedding-payment-right"><strong>' + fmt(row.amountCents) +
      '</strong><div class="wedding-payment-buttons">' +
      '<button type="button" class="wedding-mini secondary" data-action="edit-plan" data-id="' + clean(row.supplier.id) + '">Editar plano</button>' +
      '<button type="button" class="wedding-mini ' + (row.paid ? 'paid' : '') + '" data-action="' +
      (row.paid ? 'undo' : 'pay') + '" data-id="' + clean(row.id) + '">' +
      (row.paid ? '✓ Pago · desfazer' : 'Marcar pago') + '</button></div></div></div>'
    ).join('') : '<div class="wedding-payment-row wedding-payment-meta">Sem parcelas neste mês.</div>';
    return '<article class="wedding-month"><div class="wedding-month-head"><div><h3>' + monthName(month) +
      '</h3><small>Pago: ' + fmt(settled) + '</small></div><span>Falta ' + fmt(due) + '</span></div>' +
      content + '</article>';
  }).join('');
}
function renderSuppliers() {
  w('weddingSuppliers').innerHTML = state.suppliers.length ? state.suppliers.map((s) => {
    const pct = s.totalCents ? Math.round((s.paidCents / s.totalCents) * 100) : 100;
    return '<article class="wedding-vendor"><div class="wedding-vendor-top"><h3>' + clean(s.name) +
      '</h3><span class="wedding-status ' + (s.remainingCents ? 'pending' : '') + '">' +
      (s.remainingCents ? pct + '% pago' : 'Quitado') + '</span></div>' +
      '<div class="wedding-vendor-amounts"><div><span>Total</span><strong>' + fmt(s.totalCents) +
      '</strong></div><div><span>Pago</span><strong class="green">' + fmt(s.paidCents) +
      '</strong></div><div><span>Restante</span><strong class="gold">' + fmt(s.remainingCents) +
      '</strong></div></div>' + (s.note ? '<div class="wedding-vendor-note">' + clean(s.note) + '</div>' : '') +
      (s.unplannedCents ? '<div class="wedding-unplanned">Ainda sem parcela definida: <strong>' + fmt(s.unplannedCents) + '</strong></div>' : '') +
      '<div class="wedding-vendor-actions"><button type="button" class="mini-btn" data-action="edit" data-id="' +
      clean(s.id) + '">Editar plano</button><button type="button" class="mini-btn danger" data-action="delete" data-id="' +
      clean(s.id) + '">Excluir</button></div></article>';
  }).join('') : '<div class="empty-state">Nenhum fornecedor cadastrado.</div>';
}
function supplierById(id) { return state.suppliers.find((s) => s.id === id); }
function installmentById(id) {
  for (const supplier of state.suppliers) {
    const installment = supplier.installments.find((p) => p.id === id);
    if (installment) return { supplier, installment };
  }
  return null;
}
function planRow(part = {}) {
  const row = document.createElement('div');
  row.className = 'wedding-plan-row';
  row.innerHTML =
    '<label>Mês<input type="month" data-plan-month required></label>' +
    '<label>Valor (R$)<input inputmode="decimal" data-plan-amount required placeholder="0,00"></label>' +
    '<label class="wedding-paid-check"><span>Já paga</span><input type="checkbox" data-plan-paid></label>' +
    '<label class="wedding-paid-date hidden">Data do pagamento<input type="date" data-plan-paid-on></label>' +
    '<button class="mini-btn danger wedding-remove-part" type="button" data-remove-part>Remover</button>';

  const monthInput = row.querySelector('[data-plan-month]');
  const amountInput = row.querySelector('[data-plan-amount]');
  const paidInput = row.querySelector('[data-plan-paid]');
  const paidDateWrap = row.querySelector('.wedding-paid-date');
  const paidOnInput = row.querySelector('[data-plan-paid-on]');

  monthInput.value = part.month || currentMonth();
  amountInput.value = Number.isFinite(part.amountCents) ? inputMoney(part.amountCents) : '';
  paidInput.checked = Boolean(part.paid);
  paidOnInput.value = part.paidOn || (part.paid ? dateToday() : '');
  paidDateWrap.classList.toggle('hidden', !paidInput.checked);

  paidInput.addEventListener('change', () => {
    paidDateWrap.classList.toggle('hidden', !paidInput.checked);
    if (paidInput.checked && !paidOnInput.value) paidOnInput.value = dateToday();
  });

  row.querySelector('[data-remove-part]').addEventListener('click', () => {
    row.remove();
    updatePlanSummary();
  });
  row.querySelectorAll('input').forEach((input) => input.addEventListener('input', updatePlanSummary));
  return row;
}
function addPlanRow(part) {
  w('weddingInstallmentEditor').appendChild(planRow(part));
  updatePlanSummary();
}
function collectPlan() {
  return [...w('weddingInstallmentEditor').querySelectorAll('.wedding-plan-row')].map((row, index) => {
    const paid = row.querySelector('[data-plan-paid]').checked;
    const paidOn = row.querySelector('[data-plan-paid-on]').value;
    if (paid && !paidOn) throw new Error('Informe a data de pagamento da parcela ' + (index + 1) + '.');
    return {
      month: row.querySelector('[data-plan-month]').value,
      amountCents: toCents(row.querySelector('[data-plan-amount]').value),
      paid,
      paidOn: paid ? paidOn : null,
    };
  });
}
function updatePlanSummary() {
  let total = 0;
  try {
    total = [...w('weddingInstallmentEditor').querySelectorAll('[data-plan-amount]')]
      .reduce((sum, input) => sum + (input.value.trim() ? toCents(input.value) : 0), 0);
  } catch {}
  let baseline = 0;
  let contract = 0;
  try { baseline = w('weddingSupplierBaseline').value.trim() ? toCents(w('weddingSupplierBaseline').value) : 0; } catch {}
  try { contract = w('weddingSupplierTotal').value.trim() ? toCents(w('weddingSupplierTotal').value) : 0; } catch {}
  const distributed = baseline + total;
  const left = Math.max(0, contract - distributed);
  w('weddingPlanSummary').innerHTML =
    '<span>Parcelas: <strong>' + fmt(total) + '</strong></span>' +
    '<span>Pago anterior: <strong>' + fmt(baseline) + '</strong></span>' +
    '<span class="' + (left ? 'gold' : 'green') + '">Sem distribuir: <strong>' + fmt(left) + '</strong></span>';
}
function supplierDialog(item) {
  w('weddingSupplierTitle').textContent = item ? 'Editar gasto e parcelas' : 'Novo gasto e parcelas';
  w('weddingSupplierId').value = item?.id || '';
  w('weddingSupplierName').value = item?.name || '';
  w('weddingSupplierTotal').value = item ? inputMoney(item.totalCents) : '';
  w('weddingSupplierBaseline').value = item ? inputMoney(item.baselinePaidCents) : '0,00';
  w('weddingSupplierNote').value = item?.note || '';
  w('weddingSupplierError').textContent = '';
  w('weddingInstallmentEditor').innerHTML = '';
  for (const installment of item?.installments || []) addPlanRow(installment);
  updatePlanSummary();
  w('weddingSupplierDialog').showModal();
}
function paymentDialog(id) {
  const match = installmentById(id);
  if (!match) return;
  w('weddingInstallmentId').value = id;
  w('weddingPaymentDescription').textContent = match.supplier.name + ' · ' + monthName(match.installment.month);
  w('weddingPaymentAmount').value = inputMoney(match.installment.amountCents);
  w('weddingPaymentDate').value = dateToday();
  w('weddingPaymentError').textContent = '';
  w('weddingPaymentDialog').showModal();
}
async function saveSupplier(event) {
  event.preventDefault();
  const id = w('weddingSupplierId').value;
  try {
    const totalCents = toCents(w('weddingSupplierTotal').value);
    const baselinePaidCents = toCents(w('weddingSupplierBaseline').value);
    if (baselinePaidCents > totalCents) throw new Error('O valor já pago é maior que o total.');
    const installments = collectPlan();
    const scheduledCents = installments.reduce((sum, part) => sum + part.amountCents, 0);
    if (baselinePaidCents + scheduledCents > totalCents) {
      throw new Error('O valor já pago somado às parcelas supera o total contratado.');
    }
    await api(id ? '/api/wedding/suppliers/' + encodeURIComponent(id) : '/api/wedding/suppliers', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: w('weddingSupplierName').value,
        totalCents, baselinePaidCents, note: w('weddingSupplierNote').value,
        installments,
      }),
    });
    w('weddingSupplierDialog').close();
    await load();
    message('Fornecedor salvo.');
  } catch (error) { w('weddingSupplierError').textContent = error.message; }
}
async function savePayment(event) {
  event.preventDefault();
  try {
    await api('/api/wedding/installments/' + encodeURIComponent(w('weddingInstallmentId').value), {
      method: 'PATCH',
      body: JSON.stringify({
        paid: true, amountCents: toCents(w('weddingPaymentAmount').value),
        paidOn: w('weddingPaymentDate').value,
      }),
    });
    w('weddingPaymentDialog').close();
    await load();
    message('Pagamento registrado.');
  } catch (error) { w('weddingPaymentError').textContent = error.message; }
}
async function action(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const kind = button.dataset.action;
  if (kind === 'edit' || kind === 'edit-plan') return supplierDialog(supplierById(id));
  if (kind === 'pay') return paymentDialog(id);
  if (kind === 'delete' && !confirm('Excluir este fornecedor e todas as parcelas do casamento?')) return;
  if (kind === 'undo' && !confirm('Desfazer o pagamento desta parcela?')) return;
  if (kind !== 'delete' && kind !== 'undo') return;
  button.disabled = true;
  try {
    if (kind === 'delete') await api('/api/wedding/suppliers/' + encodeURIComponent(id), { method: 'DELETE' });
    else await api('/api/wedding/installments/' + encodeURIComponent(id), {
      method: 'PATCH', body: JSON.stringify({ paid: false }),
    });
    await load();
    message(kind === 'delete' ? 'Fornecedor excluído.' : 'Pagamento desfeito.');
  } catch (error) { button.disabled = false; message(error.message, true); }
}
async function bootstrap() {
  try {
    const status = await api('/api/auth/status');
    if (!status.authenticated) return showLogin();
    await load();
  } catch (error) {
    w('weddingLoading').classList.add('hidden');
    w('weddingPageError').textContent = error.message;
    w('weddingPageError').classList.remove('hidden');
  }
}
w('weddingInitialize').addEventListener('click', async () => {
  const button = w('weddingInitialize');
  button.disabled = true;
  try {
    await api('/api/wedding/initialize', { method: 'POST', body: '{}' });
    await load();
    message('Planejamento inicial importado para sua conta.');
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
w('addWeddingSupplier').addEventListener('click', () => supplierDialog(null));
w('addWeddingPlanExpense').addEventListener('click', () => supplierDialog(null));
w('addWeddingInstallment').addEventListener('click', () => addPlanRow({ month: currentMonth() }));
w('weddingSupplierTotal').addEventListener('input', updatePlanSummary);
w('weddingSupplierBaseline').addEventListener('input', updatePlanSummary);
w('weddingSupplierForm').addEventListener('submit', saveSupplier);
w('weddingPaymentForm').addEventListener('submit', savePayment);
w('weddingSchedule').addEventListener('click', action);
w('weddingSuppliers').addEventListener('click', action);
document.querySelectorAll('[data-close]').forEach((button) =>
  button.addEventListener('click', () => w(button.dataset.close).close()));
bootstrap();
