const $ = (selector) => document.querySelector(selector);

const STORAGE_KEY = 'controlfinance.v1';
const state = {
  month: currentMonth(),
  data: null,
  store: loadStore(),
};

const monthNames = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function emptyStore() {
  return { incomes: [], expenses: [] };
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || !Array.isArray(parsed.incomes) || !Array.isArray(parsed.expenses)) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store));
}

function id() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseMoney(value) {
  const raw = String(value ?? '').trim().replace(/\s/g, '');
  if (!raw) throw new Error('Informe um valor.');

  let normalized = raw;
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.lastIndexOf(',') > normalized.lastIndexOf('.')
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '');
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
  }

  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) throw new Error('Valor inválido.');
  return Math.round(number * 100) / 100;
}

function parseDay(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 31) {
    throw new Error('Dia deve estar entre 1 e 31.');
  }
  return number;
}

function cleanText(value, required = false, max = 500) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error('Informe um nome.');
  if (result.length > max) throw new Error('Texto muito longo.');
  return result || '';
}

function formatMonth(value) {
  const [year, month] = value.split('-').map(Number);
  return monthNames.format(new Date(Date.UTC(year, month - 1, 1)));
}

function changeMonth(delta) {
  const [year, month] = state.month.split('-').map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  state.month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
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
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function loadSummary() {
  $('#monthLabel').textContent = formatMonth(state.month);
  $('#monthInput').value = state.month;

  const incomes = state.store.incomes
    .filter((item) => item.month === state.month)
    .sort((a, b) => (a.day ?? 99) - (b.day ?? 99));

  const expenses = state.store.expenses
    .filter((item) => item.month === state.month)
    .sort((a, b) => (a.day ?? 99) - (b.day ?? 99))
    .map((expense) => {
      const subTotal = expense.subexpenses.reduce((sum, sub) => sum + sub.amount, 0);
      return {
        ...expense,
        subTotal: Math.round(subTotal * 100) / 100,
        total: Math.round((expense.baseAmount + subTotal) * 100) / 100,
      };
    });

  const incomeTotal = incomes.reduce((sum, item) => sum + item.amount, 0);
  const expenseTotal = expenses.reduce((sum, item) => sum + item.total, 0);

  state.data = {
    incomes,
    expenses,
    totals: {
      income: Math.round(incomeTotal * 100) / 100,
      expense: Math.round(expenseTotal * 100) / 100,
      balance: Math.round((incomeTotal - expenseTotal) * 100) / 100,
    },
  };

  render();
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
                    <button class="mini-btn danger" data-action="delete-sub" data-id="${sub.id}" data-parent="${item.id}">Excluir</button>
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
  $('#amountField').value = item
    ? String(isIncome || isSub ? item.amount : item.baseAmount).replace('.', ',')
    : '';
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

function findIncome(itemId) {
  return state.store.incomes.find((item) => item.id === itemId);
}

function findExpense(itemId) {
  return state.store.expenses.find((item) => item.id === itemId);
}

function findSub(itemId, parentId) {
  return findExpense(parentId)?.subexpenses.find((sub) => sub.id === itemId);
}

function saveEntry(event) {
  event.preventDefault();

  try {
    const type = $('#entryType').value;
    const entryId = $('#entryId').value;
    const parentExpenseId = $('#parentExpenseId').value;
    const name = cleanText($('#nameField').value, true, 120);
    const amount = parseMoney($('#amountField').value);
    const day = parseDay($('#dayField').value);
    const notes = cleanText($('#notesField').value, false, 500);
    const selectedMonth = $('#monthField').value || state.month;

    if (type === 'income') {
      if (entryId) {
        const item = findIncome(entryId);
        Object.assign(item, { month: selectedMonth, name, amount, day, notes });
      } else {
        state.store.incomes.push({ id: id(), month: selectedMonth, name, amount, day, notes });
      }
    } else if (type === 'expense') {
      if (entryId) {
        const item = findExpense(entryId);
        Object.assign(item, { month: selectedMonth, name, baseAmount: amount, day, notes });
      } else {
        state.store.expenses.push({
          id: id(),
          month: selectedMonth,
          name,
          baseAmount: amount,
          day,
          notes,
          subexpenses: [],
        });
      }
    } else {
      const parent = findExpense(parentExpenseId);
      if (!parent) throw new Error('Gasto principal não encontrado.');

      if (entryId) {
        const item = findSub(entryId, parentExpenseId);
        Object.assign(item, { name, amount, day, notes });
      } else {
        parent.subexpenses.push({
          id: id(),
          expenseId: parentExpenseId,
          name,
          amount,
          day,
          notes,
        });
      }
    }

    saveStore();
    $('#entryDialog').close();

    if (type !== 'subexpense' && selectedMonth !== state.month) {
      state.month = selectedMonth;
    }

    loadSummary();
    toast(entryId ? 'Lançamento atualizado.' : 'Lançamento adicionado.');
  } catch (error) {
    $('#entryError').textContent = error.message;
  }
}

function deleteItem(type, itemId, parentId = '') {
  const labels = {
    income: 'este ganho',
    expense: 'este gasto e todos os subgastos dele',
    subexpense: 'este subgasto',
  };
  if (!confirm(`Excluir ${labels[type]}?`)) return;

  if (type === 'income') {
    state.store.incomes = state.store.incomes.filter((item) => item.id !== itemId);
  } else if (type === 'expense') {
    state.store.expenses = state.store.expenses.filter((item) => item.id !== itemId);
  } else {
    const expense = findExpense(parentId);
    if (expense) expense.subexpenses = expense.subexpenses.filter((item) => item.id !== itemId);
  }

  saveStore();
  loadSummary();
  toast('Excluído.');
}

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

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
  const item = findIncome(button.dataset.id);
  if (button.dataset.action === 'edit-income') openDialog('income', item);
  if (button.dataset.action === 'delete-income') deleteItem('income', button.dataset.id);
});

$('#expenseList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const { action, id: itemId, parent } = button.dataset;

  if (action === 'edit-expense') openDialog('expense', findExpense(itemId));
  if (action === 'delete-expense') deleteItem('expense', itemId);
  if (action === 'add-sub') openDialog('subexpense', null, itemId);
  if (action === 'edit-sub') openDialog('subexpense', findSub(itemId, parent), parent);
  if (action === 'delete-sub') deleteItem('subexpense', itemId, parent);
});

$('#logoutBtn').classList.add('hidden');
$('#loginView').classList.add('hidden');
$('#app').classList.remove('hidden');
loadSummary();
