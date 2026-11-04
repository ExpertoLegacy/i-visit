import {
  api,
  esc,
  fmtDateTime,
  toast,
  requireRole,
  logout,
  registerServiceWorker,
  openModal,
} from './common.js';

const $ = (selector) => document.querySelector(selector);
const state = {
  me: null,
  tab: 'supply',
  offices: [],
  contacts: [],
  users: [],
  batches: [],
  passes: [],
  filter: { batch_id: '', status: '', q: '' },
};

const TABS = [
  ['supply', 'Pass supply'],
  ['passes', 'Pass log'],
  ['offices', 'Offices'],
  ['contacts', 'Contacts'],
  ['accounts', 'Accounts'],
];

const PASS_CHIP = { unused: 'gray', issued: 'amber', arrived: 'blue', done: 'green', void: 'red' };

boot();

async function boot() {
  registerServiceWorker();
  state.me = await requireRole(['admin']);
  if (!state.me) return;

  $('#userLabel').textContent = state.me.full_name || state.me.username;
  $('#logoutBtn').addEventListener('click', logout);
  $('#changePasswordBtn').addEventListener('click', openPasswordModal);
  $('#tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.tab = button.dataset.tab;
    renderTabs();
    render();
  });
  $('#view').addEventListener('submit', onSubmit);
  $('#view').addEventListener('click', onClick);
  $('#view').addEventListener('change', onChange);

  await reloadAll();
  renderTabs();
  render();

  if (state.me.must_change_password) {
    showBanner('This account still uses the seeded admin password. Change it before real use.', openPasswordModal);
  }
}

function showBanner(message, action) {
  const banner = $('#banner');
  banner.innerHTML = `<div class="banner warn"><span>${esc(message)}</span><button class="btn btn-sm" id="bannerAction" type="button">Change password</button></div>`;
  $('#bannerAction')?.addEventListener('click', action);
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(
    ([id, label]) => `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}" type="button">${label}</button>`,
  ).join('');
}

async function reloadAll() {
  await Promise.all([loadOffices(), loadContacts(), loadUsers(), loadBatches(), loadPasses()]);
}

async function loadOffices() {
  state.offices = (await api('/api/offices')).offices;
}
async function loadContacts() {
  state.contacts = (await api('/api/contacts')).contacts;
}
async function loadUsers() {
  state.users = (await api('/api/users')).users;
}
async function loadBatches() {
  state.batches = (await api('/api/batches')).batches;
}
async function loadPasses() {
  const params = new URLSearchParams();
  if (state.filter.batch_id) params.set('batch_id', state.filter.batch_id);
  if (state.filter.status) params.set('status', state.filter.status);
  if (state.filter.q) params.set('q', state.filter.q);
  params.set('limit', '150');
  state.passes = (await api(`/api/passes?${params.toString()}`)).passes;
}

function render() {
  if (state.tab === 'supply') renderSupply();
  else if (state.tab === 'passes') renderPasses();
  else if (state.tab === 'offices') renderOffices();
  else if (state.tab === 'contacts') renderContacts();
  else renderAccounts();
}

/* ----------------------------------------------------------------- supply */

function renderSupply() {
  $('#view').innerHTML = `
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h2>Generate passes</h2></div>
        <form class="form-grid" data-form="batch">
          <label class="field"><span>Batch label</span><input class="input" name="label" maxlength="60" placeholder="e.g. June sheet" /></label>
          <label class="field"><span>How many passes</span><input class="input" name="count" type="number" min="1" max="500" value="50" required /></label>
          <button class="btn btn-primary btn-block" type="submit">Generate &amp; save</button>
        </form>
        <p class="hint" style="margin-top: 10px">Each pass gets a unique code and QR. Print the sheet, cut the tickets, and keep them at the gate.</p>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Print batches</h2><span class="sub">${state.batches.length} batch${state.batches.length === 1 ? '' : 'es'}</span></div>
        ${batchesTable()}
      </section>
    </div>`;
}

function batchesTable() {
  if (!state.batches.length) {
    return '<div class="empty"><strong>No batches yet</strong>Generate a batch, then print the sheet.</div>';
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Batch</th><th>Created</th><th>Passes</th><th>Unused</th><th>Issued</th><th>Arrived</th><th>Done</th><th>Void</th><th></th></tr>
        </thead>
        <tbody>
          ${state.batches
            .map(
              (batch) => `
            <tr>
              <td class="cell-strong">${esc(batch.label)}</td>
              <td class="muted nowrap">${fmtDateTime(batch.created_at)}</td>
              <td>${batch.count}</td>
              <td>${batch.unused}</td>
              <td>${batch.issued}</td>
              <td>${batch.arrived}</td>
              <td>${batch.done}</td>
              <td>${batch.void_count}</td>
              <td class="actions"><button class="btn btn-sm" data-action="print" data-batch="${batch.id}" type="button">Print</button></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

/* ----------------------------------------------------------------- passes */

function officeOptions(selected, includeBlank = true) {
  return (includeBlank ? '<option value="">All offices</option>' : '')
    .concat(state.offices.map((office) => `<option value="${office.id}" ${Number(selected) === office.id ? 'selected' : ''}>${esc(office.name)}</option>`))
    .join('');
}

function renderPasses() {
  const batchOptions = ['<option value="">All batches</option>']
    .concat(state.batches.map((batch) => `<option value="${batch.id}" ${Number(state.filter.batch_id) === batch.id ? 'selected' : ''}>${esc(batch.label)}</option>`))
    .join('');

  const statusOptions = ['', 'unused', 'issued', 'arrived', 'done', 'void']
    .map((status) => `<option value="${status}" ${state.filter.status === status ? 'selected' : ''}>${status ? status[0].toUpperCase() + status.slice(1) : 'Any status'}</option>`)
    .join('');

  const rows = state.passes.length
    ? state.passes
        .map(
          (pass) => `
      <tr>
        <td><span class="code">${esc(pass.code)}</span></td>
        <td><span class="chip ${PASS_CHIP[pass.status] || 'gray'}">${esc(pass.status)}</span></td>
        <td>${esc(pass.batch_label || '—')}</td>
        <td>${esc(pass.visitor_name || '—')}<div class="cell-sub">${esc(pass.office_name || '')}</div></td>
        <td class="nowrap">${pass.gate_in_at ? fmtDateTime(pass.gate_in_at) : '—'}</td>
        <td class="actions">
          ${['unused', 'issued'].includes(pass.status) ? `<button class="btn btn-danger btn-sm" data-action="void" data-pass="${pass.id}" data-code="${esc(pass.code)}" type="button">Cancel</button>` : ''}
        </td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="6"><div class="empty">No passes match these filters.</div></td></tr>';

  $('#view').innerHTML = `
    <form class="panel row" data-form="passfilter">
      <label class="field grow"><span>Batch</span><select class="select" name="batch_id">${batchOptions}</select></label>
      <label class="field grow"><span>Status</span><select class="select" name="status">${statusOptions}</select></label>
      <label class="field grow"><span>Code search</span><input class="input" name="q" value="${esc(state.filter.q)}" placeholder="GH-…" /></label>
      <button class="btn" type="submit">Apply</button>
    </form>
    <section class="panel">
      <div class="panel-head"><h2>Pass log</h2><span class="sub">${state.passes.length} pass${state.passes.length === 1 ? '' : 'es'} shown</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Code</th><th>Status</th><th>Batch</th><th>Latest visit</th><th>Gate in</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

/* ---------------------------------------------------------------- offices */

function renderOffices() {
  const rows = state.offices.length
    ? state.offices
        .map(
          (office) => `
      <tr class="${office.active ? '' : 'inactive'}">
        <td class="cell-strong">${esc(office.name)}</td>
        <td>${office.contact_count}</td>
        <td><span class="chip ${office.active ? 'green' : 'gray'}">${office.active ? 'Active' : 'Inactive'}</span></td>
        <td class="actions">
          <button class="btn btn-ghost btn-sm" data-action="rename-office" data-id="${office.id}" data-name="${esc(office.name)}" type="button">Rename</button>
          <button class="btn btn-sm" data-action="toggle-office" data-id="${office.id}" data-active="${office.active}" type="button">${office.active ? 'Deactivate' : 'Activate'}</button>
        </td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="4"><div class="empty"><strong>No offices yet</strong>Add the offices visitors can be sent to.</div></td></tr>';

  $('#view').innerHTML = `
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h2>Add office</h2></div>
        <form class="form-grid" data-form="office">
          <label class="field"><span>Office name</span><input class="input" name="name" maxlength="80" placeholder="e.g. Registrar" required /></label>
          <button class="btn btn-primary btn-block" type="submit">Add office</button>
        </form>
        <p class="hint" style="margin-top: 10px">Deactivated offices cannot be chosen when issuing a pass.</p>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Offices</h2><span class="sub">${state.offices.length} total</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Contacts</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    </div>`;
}

/* --------------------------------------------------------------- contacts */

function renderContacts() {
  const rows = state.contacts.length
    ? state.contacts
        .map(
          (contact) => `
      <tr class="${contact.active ? '' : 'inactive'}">
        <td class="cell-strong">${esc(contact.name)}</td>
        <td>${esc(contact.office_name)}</td>
        <td>${esc(contact.phone || '—')}</td>
        <td><span class="chip ${contact.active ? 'green' : 'gray'}">${contact.active ? 'Active' : 'Inactive'}</span></td>
        <td class="actions">
          <button class="btn btn-sm" data-action="toggle-contact" data-id="${contact.id}" data-active="${contact.active}" type="button">${contact.active ? 'Deactivate' : 'Activate'}</button>
        </td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5"><div class="empty"><strong>No contact persons yet</strong>Add the staff visitors ask for.</div></td></tr>';

  $('#view').innerHTML = `
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h2>Add contact person</h2></div>
        <form class="form-grid" data-form="contact">
          <label class="field"><span>Office</span><select class="select" name="office_id" required>${officeOptions('', false).replace('<option value="">All offices</option>', '<option value="">Select office…</option>')}</select></label>
          <label class="field"><span>Name</span><input class="input" name="name" maxlength="80" placeholder="e.g. Ms. Cruz" required /></label>
          <label class="field"><span>Phone <span class="muted small">(optional)</span></span><input class="input" name="phone" maxlength="32" placeholder="0917 000 0000" /></label>
          <button class="btn btn-primary btn-block" type="submit">Add contact</button>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Contact persons</h2><span class="sub">${state.contacts.length} total</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Office</th><th>Phone</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    </div>`;
}

/* --------------------------------------------------------------- accounts */

function renderAccounts() {
  const rows = state.users.length
    ? state.users
        .map(
          (user) => `
      <tr class="${user.active ? '' : 'inactive'}">
        <td class="cell-strong">${esc(user.username)}<div class="cell-sub">${esc(user.full_name || 'No name set')}</div></td>
        <td><span class="chip ${user.role === 'admin' ? 'blue' : user.role === 'guard' ? 'amber' : 'gray'}">${esc(user.role)}</span></td>
        <td>${esc(user.office_name || '—')}</td>
        <td><span class="chip ${user.active ? 'green' : 'gray'}">${user.active ? 'Active' : 'Inactive'}</span></td>
        <td class="actions">
          <button class="btn btn-ghost btn-sm" data-action="reset-password" data-id="${user.id}" data-username="${esc(user.username)}" type="button">Reset password</button>
          ${user.id === state.me.id ? '' : `<button class="btn btn-sm" data-action="toggle-user" data-id="${user.id}" data-active="${user.active}" type="button">${user.active ? 'Deactivate' : 'Activate'}</button>`}
        </td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5"><div class="empty">No accounts yet.</div></td></tr>';

  $('#view').innerHTML = `
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h2>Add account</h2></div>
        <form class="form-grid" data-form="user">
          <label class="field"><span>Username</span><input class="input" name="username" maxlength="32" placeholder="e.g. guard2" required /></label>
          <label class="field"><span>Full name</span><input class="input" name="full_name" maxlength="80" placeholder="e.g. Juan Dela Cruz" /></label>
          <label class="field"><span>Role</span>
            <select class="select" name="role" id="userRole" required>
              <option value="guard">Guard</option>
              <option value="office">Office staff</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <label class="field" id="userOfficeField" hidden><span>Office</span><select class="select" name="office_id" disabled>${officeOptions('', false).replace('<option value="">All offices</option>', '<option value="">Select office…</option>')}</select></label>
          <label class="field"><span>Temporary password</span><input class="input" name="password" type="text" minlength="8" placeholder="At least 8 characters" required /></label>
          <button class="btn btn-primary btn-block" type="submit">Create account</button>
        </form>
        <p class="hint" style="margin-top: 10px">New accounts are asked to change this password after signing in.</p>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Accounts</h2><span class="sub">${state.users.length} total</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Account</th><th>Role</th><th>Office</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    </div>`;

  syncRoleField();
}

function syncRoleField() {
  const roleSelect = $('#userRole');
  const field = $('#userOfficeField');
  if (!roleSelect || !field) return;
  const isOffice = roleSelect.value === 'office';
  field.hidden = !isOffice;
  const select = field.querySelector('select');
  select.disabled = !isOffice;
  select.required = isOffice;
}

/* ----------------------------------------------------------------- events */

async function onSubmit(event) {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const kind = form.dataset.form;

  try {
    if (kind === 'batch') {
      const batch = await api('/api/batches', {
        method: 'POST',
        body: { label: String(data.get('label') || '').trim(), count: Number(data.get('count')) },
      });
      toast(`Batch created with ${batch.batch.count} passes`, 'success');
      await Promise.all([loadBatches(), loadPasses()]);
      render();
      return;
    }

    if (kind === 'passfilter') {
      state.filter = {
        batch_id: String(data.get('batch_id') || ''),
        status: String(data.get('status') || ''),
        q: String(data.get('q') || '').trim(),
      };
      await loadPasses();
      render();
      return;
    }

    if (kind === 'office') {
      await api('/api/offices', { method: 'POST', body: { name: String(data.get('name') || '') } });
      toast('Office added', 'success');
      await loadOffices();
      render();
      return;
    }

    if (kind === 'contact') {
      await api('/api/contacts', {
        method: 'POST',
        body: {
          office_id: Number(data.get('office_id')),
          name: String(data.get('name') || ''),
          phone: String(data.get('phone') || ''),
        },
      });
      toast('Contact person added', 'success');
      await Promise.all([loadContacts(), loadOffices()]);
      render();
      return;
    }

    if (kind === 'user') {
      await api('/api/users', {
        method: 'POST',
        body: {
          username: String(data.get('username') || ''),
          full_name: String(data.get('full_name') || ''),
          role: String(data.get('role') || ''),
          office_id: data.get('office_id') ? Number(data.get('office_id')) : null,
          password: String(data.get('password') || ''),
        },
      });
      toast('Account created', 'success');
      await loadUsers();
      render();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function onClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;

  try {
    if (action === 'print') {
      window.open(`/print/${button.dataset.batch}`, '_blank', 'noopener');
      return;
    }

    if (action === 'void') {
      if (!window.confirm(`Cancel pass ${button.dataset.code}? This cannot be undone.`)) return;
      await api(`/api/passes/${button.dataset.pass}/void`, { method: 'POST', body: { reason: 'Cancelled by admin' } });
      toast(`Pass ${button.dataset.code} cancelled`, 'success');
      await Promise.all([loadPasses(), loadBatches()]);
      render();
      return;
    }

    if (action === 'rename-office') {
      const name = window.prompt('Office name', button.dataset.name);
      if (!name || name.trim() === button.dataset.name) return;
      await api(`/api/offices/${button.dataset.id}`, { method: 'PATCH', body: { name: name.trim() } });
      toast('Office renamed', 'success');
      await loadOffices();
      render();
      return;
    }

    if (action === 'toggle-office') {
      const active = button.dataset.active === '1';
      await api(`/api/offices/${button.dataset.id}`, { method: 'PATCH', body: { active: !active } });
      toast(active ? 'Office deactivated' : 'Office activated', 'success');
      await loadOffices();
      render();
      return;
    }

    if (action === 'toggle-contact') {
      const active = button.dataset.active === '1';
      await api(`/api/contacts/${button.dataset.id}`, { method: 'PATCH', body: { active: !active } });
      toast(active ? 'Contact deactivated' : 'Contact activated', 'success');
      await loadContacts();
      render();
      return;
    }

    if (action === 'toggle-user') {
      const active = button.dataset.active === '1';
      await api(`/api/users/${button.dataset.id}`, { method: 'PATCH', body: { active: !active } });
      toast(active ? 'Account deactivated' : 'Account activated', 'success');
      await loadUsers();
      render();
      return;
    }

    if (action === 'reset-password') {
      const password = window.prompt(`New password for ${button.dataset.username} (at least 8 characters)`);
      if (!password) return;
      await api(`/api/users/${button.dataset.id}`, { method: 'PATCH', body: { password } });
      toast('Password reset. The user must change it after signing in.', 'success');
      return;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function onChange(event) {
  if (event.target.id === 'userRole') syncRoleField();
}

/* --------------------------------------------------------- own password */

function openPasswordModal() {
  const modal = openModal(
    'Change password',
    `<form class="form-grid" id="passwordForm">
      <label class="field"><span>Current password</span><input class="input" type="password" name="current_password" required /></label>
      <label class="field"><span>New password</span><input class="input" type="password" name="new_password" minlength="8" required /></label>
      <label class="field"><span>Repeat new password</span><input class="input" type="password" name="confirm_password" minlength="8" required /></label>
      <p class="form-error" id="passwordError"></p>
      <button class="btn btn-primary btn-block" type="submit">Save password</button>
    </form>`,
    { focus: 'input[name="current_password"]' },
  );

  modal.querySelector('#passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const errorNode = form.querySelector('#passwordError');
    errorNode.textContent = '';
    if (form.new_password.value !== form.confirm_password.value) {
      errorNode.textContent = 'The new passwords do not match.';
      return;
    }
    try {
      await api('/api/me/password', {
        method: 'POST',
        body: { current_password: form.current_password.value, new_password: form.new_password.value },
      });
      toast('Password updated', 'success');
      $('#banner').innerHTML = '';
      state.me.must_change_password = false;
      modal.remove();
    } catch (err) {
      errorNode.textContent = err.message;
    }
  });
}
