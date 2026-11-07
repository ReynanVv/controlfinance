const w = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const months = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
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
function renderSchedule() {
  w('weddingSchedule').innerHTML = months.map((month) => {
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
      '</strong><button type="button" class="wedding-mini ' + (row.paid ? 'paid' : '') + '" data-action="' +
      (row.paid ? 'undo' : 'pay') + '" data-id="' + clean(row.id) + '">' +
      (row.paid ? '✓ Pago · desfazer' : 'Marcar pago') + '</button></div></div>'
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
      '<div class="wedding-vendor-actions"><button type="button" class="mini-btn" data-action="edit" data-id="' +
      clean(s.id) + '">Editar</button><button type="button" class="mini-btn danger" data-action="delete" data-id="' +
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
function supplierDialog(item) {
  w('weddingSupplierTitle').textContent = item ? 'Editar fornecedor' : 'Novo fornecedor';
  w('weddingSupplierId').value = item?.id || '';
  w('weddingSupplierName').value = item?.name || '';
  w('weddingSupplierTotal').value = item ? inputMoney(item.totalCents) : '';
  w('weddingSupplierBaseline').value = item ? inputMoney(item.baselinePaidCents) : '0,00';
  w('weddingSupplierNote').value = item?.note || '';
  w('weddingSupplierError').textContent = '';
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
    await api(id ? '/api/wedding/suppliers/' + encodeURIComponent(id) : '/api/wedding/suppliers', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: w('weddingSupplierName').value,
        totalCents, baselinePaidCents, note: w('weddingSupplierNote').value,
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
  if (kind === 'edit') return supplierDialog(supplierById(id));
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
w('weddingSupplierForm').addEventListener('submit', saveSupplier);
w('weddingPaymentForm').addEventListener('submit', savePayment);
w('weddingSchedule').addEventListener('click', action);
w('weddingSuppliers').addEventListener('click', action);
document.querySelectorAll('[data-close]').forEach((button) =>
  button.addEventListener('click', () => w(button.dataset.close).close()));
bootstrap();
