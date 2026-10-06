const $ = (selector) => document.querySelector(selector);
const state = { month: currentMonth(), data: null, user: null, authMode: 'login' };
const LEGACY_STORAGE_KEY = 'controlfinance.v1';

const monthNames = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonth(value) {
  const [year, month] = value.split('-').map(Number);
  return monthNames.format(new Date(Date.UTC(year, month - 1, 1)));
}

function changeMonth(delta) {
  const [year, month] = state.month.split('-').map(Number);
  const d = new Date(year, month - 1 + delta, 1);
  state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadSummary();
}

function formatMeta(item) {
  const parts = [];
  if (item.day) parts.push(`dia ${item.day}`);
  if (item.notes) parts.push(item.notes);
  return parts.join(' · ') || 'Sem observação';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) showLogin();
    throw new Error(body.error || 'Não foi possível concluir a ação.');
  }
  return body;
}

async function init() {
  const auth = await api('/api/auth/status');
  if (!auth.authenticated) return showLogin();
  state.user = auth.user;
  showApp();
  await maybeImportLegacyData();
  await loadSummary();
}

function showLogin() {
  state.user = null;
  $('#app').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#accountLabel').textContent = state.user ? `@${state.user.username}` : '';
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  $('#loginModeBtn').classList.toggle('active', !registering);
  $('#registerModeBtn').classList.toggle('active', registering);
  $('#authSubmitBtn').textContent = registering ? 'Criar conta' : 'Entrar';
  $('#authSubtitle').textContent = registering
    ? 'Crie uma conta para manter seus dados separados e salvos.'
    : 'Entre na sua conta para acessar seu histórico.';
  $('#passwordInput').autocomplete = registering ? 'new-password' : 'current-password';
  $('#loginError').textContent = '';
}

async function maybeImportLegacyData() {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const hasData = Array.isArray(data?.incomes) && Array.isArray(data?.expenses) &&
    (data.incomes.length > 0 || data.expenses.length > 0);
  if (!hasData) {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return;
  }

  if (!confirm('Encontrei lançamentos da versão anterior neste aparelho. Deseja importar para esta conta?')) return;

  try {
    await api('/api/import-local', { method: 'POST', body: JSON.stringify(data) });
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    toast('Histórico antigo importado.');
  } catch (error) {
    toast(`Não foi possível importar: ${error.message}`, true);
  }
}

async function loadSummary() {
  $('#monthLabel').textContent = formatMonth(state.month);
  $('#monthInput').value = state.month;
  try {
    state.data = await api(`/api/summary?month=${encodeURIComponent(state.month)}`);
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

function render() {
  const { incomes, expenses, totals } = state.data;
  $('#balanceValue').textContent = brl.format(totals.balance);
  $('#incomeValue').textContent = brl.format(totals.income);
  $('#expenseValue').textContent = brl.format(totals.expense);
  $('#incomeCount').textContent = `${incomes.length} ${incomes.length === 1 ? 'lançamento' : 'lançamentos'}`;
  $('#expenseCount').textContent = `${expenses.length} ${expenses.length === 1 ? 'lançamento' : 'lançamentos'}`;
  $('#balanceValue').style.color = totals.balance < 0 ? 'var(--red)' : 'var(--gold)';
  renderIncomes(incomes);
  renderExpenses(expenses);
}

function renderIncomes(incomes) {
  const list = $('#incomeList');
  if (!incomes.length) {
    list.innerHTML = '<div class="empty-state">Nenhum ganho neste mês.</div>';
    return;
  }
  list.innerHTML = incomes.map((item) => `
    <article class="entry-card">
      <div class="entry-main">
        <div class="entry-copy">
          <p class="entry-name">${escapeHtml(item.name)}</p>
          <div class="entry-meta">${escapeHtml(formatMeta(item))}</div>
        </div>
        <div>
          <div class="entry-value income">+ ${brl.format(item.amount)}</div>
          <div class="entry-actions">
            <button class="mini-btn" data-action="edit-income" data-id="${item.id}">Editar</button>
            <button class="mini-btn danger" data-action="delete-income" data-id="${item.id}">Excluir</button>
          </div>
        </div>
      </div>
    </article>
  `).join('');
}

function renderExpenses(expenses) {
  const list = $('#expenseList');
  if (!expenses.length) {
    list.innerHTML = '<div class="empty-state">Nenhum gasto neste mês.</div>';
    return;
  }
  list.innerHTML = expenses.map((item) => `
    <article class="entry-card">
      <div class="entry-main">
        <div class="entry-copy">
          <p class="entry-name">${escapeHtml(item.name)}</p>
          <div class="entry-meta">Base ${brl.format(item.baseAmount)}${item.day ? ` · dia ${item.day}` : ''}${item.notes ? ` · ${escapeHtml(item.notes)}` : ''}</div>
        </div>
        <div>
          <div class="entry-value expense">− ${brl.format(item.total)}</div>
          <div class="entry-actions">
            <button class="mini-btn" data-action="edit-expense" data-id="${item.id}">Editar</button>
            <button class="mini-btn danger" data-action="delete-expense" data-id="${item.id}">Excluir</button>
          </div>
        </div>
      </div>
      <div class="expense-footer">
        ${item.subexpenses.length ? `
          <div class="sub-list">
            ${item.subexpenses.map((sub) => `
              <div class="sub-row">
                <div>
                  <div class="sub-name">${escapeHtml(sub.name)}</div>
                  <div class="sub-meta">${escapeHtml(formatMeta(sub))}</div>
                </div>
                <div class="sub-right">
                  <div class="sub-value">+ ${brl.format(sub.amount)}</div>
                  <div class="sub-actions">
                    <button class="mini-btn" data-action="edit-sub" data-id="${sub.id}" data-parent="${item.id}">Editar</button>
                    <button class="mini-btn danger" data-action="delete-sub" data-id="${sub.id}">Excluir</button>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>` : ''}
        <div class="expense-total-row">
          <span>Base ${brl.format(item.baseAmount)} + subgastos ${brl.format(item.subTotal)}</span>
          <strong>${brl.format(item.total)}</strong>
        </div>
        <button class="mini-btn add-sub-btn" data-action="add-sub" data-id="${item.id}">+ Adicionar subgasto</button>
      </div>
    </article>
  `).join('');
}

function openDialog(type, item = null, parentExpenseId = '') {
  const isSub = type === 'subexpense';
  const isIncome = type === 'income';
  $('#entryType').value = type;
  $('#entryId').value = item?.id || '';
  $('#parentExpenseId').value = parentExpenseId || item?.expenseId || '';
  $('#dialogEyebrow').textContent = item ? 'EDITAR LANÇAMENTO' : 'NOVO LANÇAMENTO';
  $('#dialogTitle').textContent = isSub ? 'Subgasto' : isIncome ? 'Ganho' : 'Gasto';
  $('#nameField').value = item?.name || '';
  $('#amountField').value = item ? String(isIncome || isSub ? item.amount : item.baseAmount).replace('.', ',') : '';
  $('#monthField').value = item?.month || state.month;
  $('#dayField').value = item?.day || '';
  $('#notesField').value = item?.notes || '';
  $('#monthFieldWrap').classList.toggle('hidden', isSub);
  $('#monthField').required = !isSub;
  $('#entryError').textContent = '';
  $('#saveEntryBtn').textContent = item ? 'Salvar alterações' : 'Adicionar';
  $('#entryDialog').showModal();
  setTimeout(() => $('#nameField').focus(), 0);
}

function findExpense(id) {
  return state.data.expenses.find((item) => item.id === id);
}

function findSub(id) {
  for (const expense of state.data.expenses) {
    const item = expense.subexpenses.find((sub) => sub.id === id);
    if (item) return item;
  }
  return null;
}

async function saveEntry(event) {
  event.preventDefault();
  const type = $('#entryType').value;
  const id = $('#entryId').value;
  const parentExpenseId = $('#parentExpenseId').value;
  const payload = {
    name: $('#nameField').value,
    amount: $('#amountField').value,
    baseAmount: $('#amountField').value,
    month: $('#monthField').value,
    day: $('#dayField').value,
    notes: $('#notesField').value,
  };

  let path;
  let method;
  if (type === 'income') {
    path = id ? `/api/incomes/${id}` : '/api/incomes';
    method = id ? 'PUT' : 'POST';
  } else if (type === 'expense') {
    path = id ? `/api/expenses/${id}` : '/api/expenses';
    method = id ? 'PUT' : 'POST';
  } else {
    path = id ? `/api/subexpenses/${id}` : `/api/expenses/${parentExpenseId}/subexpenses`;
    method = id ? 'PUT' : 'POST';
  }

  try {
    $('#saveEntryBtn').disabled = true;
    await api(path, { method, body: JSON.stringify(payload) });
    $('#entryDialog').close();
    if (type !== 'subexpense' && payload.month && payload.month !== state.month) state.month = payload.month;
    await loadSummary();
    toast(id ? 'Lançamento atualizado.' : 'Lançamento adicionado.');
  } catch (error) {
    $('#entryError').textContent = error.message;
  } finally {
    $('#saveEntryBtn').disabled = false;
  }
}

async function deleteItem(type, id) {
  const labels = { income: 'este ganho', expense: 'este gasto e todos os subgastos dele', subexpense: 'este subgasto' };
  if (!confirm(`Excluir ${labels[type]}?`)) return;
  const path = type === 'income' ? `/api/incomes/${id}` : type === 'expense' ? `/api/expenses/${id}` : `/api/subexpenses/${id}`;
  try {
    await api(path, { method: 'DELETE' });
    await loadSummary();
    toast('Excluído.');
  } catch (error) {
    toast(error.message, true);
  }
}

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

$('#loginModeBtn').addEventListener('click', () => setAuthMode('login'));
$('#registerModeBtn').addEventListener('click', () => setAuthMode('register'));

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';

  try {
    $('#authSubmitBtn').disabled = true;
    const result = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        username: $('#usernameInput').value,
        password: $('#passwordInput').value,
      }),
    });
    state.user = result.user;
    $('#passwordInput').value = '';
    showApp();
    await maybeImportLegacyData();
    await loadSummary();
  } catch (error) {
    $('#loginError').textContent = error.message;
  } finally {
    $('#authSubmitBtn').disabled = false;
  }
});

$('#reloadBtn').addEventListener('click', () => {
  window.location.reload();
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('#prevMonth').addEventListener('click', () => changeMonth(-1));
$('#nextMonth').addEventListener('click', () => changeMonth(1));
$('#monthLabel').addEventListener('click', () => {
  if ($('#monthInput').showPicker) $('#monthInput').showPicker();
  else $('#monthInput').click();
});
$('#monthInput').addEventListener('change', (event) => {
  if (!event.target.value) return;
  state.month = event.target.value;
  loadSummary();
});
$('#addIncomeBtn').addEventListener('click', () => openDialog('income'));
$('#addExpenseBtn').addEventListener('click', () => openDialog('expense'));
$('#closeDialogBtn').addEventListener('click', () => $('#entryDialog').close());
$('#entryForm').addEventListener('submit', saveEntry);

$('#incomeList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const item = state.data.incomes.find((row) => row.id === button.dataset.id);
  if (button.dataset.action === 'edit-income') openDialog('income', item);
  if (button.dataset.action === 'delete-income') deleteItem('income', button.dataset.id);
});

$('#expenseList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, parent } = button.dataset;
  if (action === 'edit-expense') openDialog('expense', findExpense(id));
  if (action === 'delete-expense') deleteItem('expense', id);
  if (action === 'add-sub') openDialog('subexpense', null, id);
  if (action === 'edit-sub') openDialog('subexpense', findSub(id), parent);
  if (action === 'delete-sub') deleteItem('subexpense', id);
});

setAuthMode('login');
init().catch((error) => {
  console.error(error);
  showLogin();
  $('#loginError').textContent = 'Não foi possível conectar ao servidor.';
});
