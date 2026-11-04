import {
  api,
  esc,
  fmtTime,
  elapsed,
  toast,
  requireRole,
  logout,
  registerServiceWorker,
  normalizeCode,
  openModal,
} from './common.js';

const $ = (selector) => document.querySelector(selector);
const state = { me: null, offices: [], monitor: null, view: 'live', filter: '', refreshTimer: null };

boot();

async function boot() {
  registerServiceWorker();
  state.me = await requireRole(['guard', 'admin']);
  if (!state.me) return;

  $('#userLabel').textContent = state.me.full_name || state.me.username;
  try {
    const meta = await api('/api/me');
    if (meta.site) {
      $('#brandSite').textContent = meta.site;
      document.title = `Live board · ${meta.site}`;
    }
  } catch {
    /* keep defaults */
  }

  const directory = await api('/api/directory');
  state.offices = directory.offices;
  fillOffices();
  bindEvents();
  await refresh();
  connectStream();
  setInterval(refreshElapsed, 20000);
}

function fillOffices() {
  const select = $('#office');
  select.innerHTML = ['<option value="">Select office…</option>']
    .concat(state.offices.map((office) => `<option value="${office.id}">${esc(office.name)}</option>`))
    .join('');
  fillContacts();
}

function fillContacts() {
  const officeId = Number($('#office').value);
  const office = state.offices.find((item) => item.id === officeId);
  const select = $('#contact');
  const contacts = office?.contacts ?? [];
  select.innerHTML = ['<option value="">No specific contact</option>']
    .concat(contacts.map((contact) => `<option value="${contact.id}">${esc(contact.name)}</option>`))
    .join('');
}

function bindEvents() {
  $('#office').addEventListener('change', fillContacts);
  $('#logoutBtn').addEventListener('click', logout);
  $('#issueForm').addEventListener('submit', issuePass);

  $('#viewTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    state.view = button.dataset.view;
    document.querySelectorAll('#viewTabs .tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    renderBoard();
  });

  $('#filter').addEventListener('input', (event) => {
    state.filter = event.target.value.trim().toLowerCase();
    renderBoard();
  });

  $('#code').addEventListener('blur', checkCode);
  $('#board').addEventListener('click', onBoardClick);
}

function setHint(message, kind = '') {
  const hint = $('#codeHint');
  hint.textContent = message;
  hint.className = `hint ${kind}`.trim();
}

async function checkCode() {
  const input = $('#code');
  const code = normalizeCode(input.value);
  if (!code) {
    if (input.value.trim()) setHint('Codes look like GH-XXXX-XXXX.', 'warn');
    return;
  }
  input.value = code;
  try {
    const { pass, visit } = await api('/api/passes/lookup', { method: 'POST', body: { code } });
    if (pass.status === 'unused') setHint('Unused pass — ready to issue.', 'ok');
    else if (visit) setHint(`Already ${pass.status} · ${visit.visitor_name} (${visit.office_name}).`, 'warn');
    else setHint(`This pass is ${pass.status}.`, 'warn');
  } catch (err) {
    setHint(err.message, 'warn');
  }
}

async function issuePass(event) {
  event.preventDefault();
  const button = $('#issueBtn');
  const code = normalizeCode($('#code').value);
  if (!code) {
    setHint('Codes look like GH-XXXX-XXXX.', 'warn');
    $('#code').focus();
    return;
  }
  const officeId = Number($('#office').value);
  if (!officeId) {
    toast('Choose the office being visited.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'Issuing…';
  try {
    const { visit } = await api('/api/issue', {
      method: 'POST',
      body: {
        code,
        visitor_name: $('#visitor').value.trim(),
        office_id: officeId,
        contact_id: $('#contact').value ? Number($('#contact').value) : null,
        purpose: $('#purpose').value.trim(),
      },
    });
    toast(`Pass ${visit.pass_code} issued to ${visit.visitor_name}`, 'success');
    $('#code').value = '';
    $('#visitor').value = '';
    $('#purpose').value = '';
    $('#code').focus();
    setHint('Ready for the next visitor.', 'ok');
    await refresh();
  } catch (err) {
    setHint(err.message, 'warn');
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Issue pass';
  }
}

async function refresh() {
  try {
    state.monitor = await api('/api/monitor');
    renderStats();
    renderBoard();
  } catch (err) {
    if (err.code !== 'auth_required') toast(err.message, 'error');
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refresh, 120);
}

function connectStream() {
  const source = new EventSource('/api/stream');
  const dot = $('#liveDot');

  source.addEventListener('ready', () => {
    dot.classList.add('on');
    dot.classList.remove('off');
  });

  source.addEventListener('visit.updated', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.kind === 'arrive') toast(`${data.visitor_name} reached ${data.office_name}`, 'success');
      if (data.kind === 'void') toast(`Pass ${data.code} was cancelled`, 'info');
    } catch {
      /* ignore malformed payloads */
    }
    scheduleRefresh();
  });

  source.onopen = () => {
    dot.classList.add('on');
    dot.classList.remove('off');
  };
  source.onerror = () => {
    dot.classList.remove('on');
    dot.classList.add('off');
    dot.title = 'Reconnecting to live updates…';
  };
}

function renderStats() {
  const monitor = state.monitor;
  if (!monitor) return;
  const { stats } = monitor;
  $('#stats').innerHTML = `
    <article class="stat">
      <div class="label">Issued today</div>
      <div class="value">${stats.issued_today}</div>
      <div class="foot">All passes handed out today</div>
    </article>
    <article class="stat is-amber">
      <div class="label">Awaiting office</div>
      <div class="value">${stats.awaiting}</div>
      <div class="foot">Visitor has not been scanned in yet</div>
    </article>
    <article class="stat is-blue">
      <div class="label">At office</div>
      <div class="value">${stats.at_office}</div>
      <div class="foot">Arrival confirmed by staff</div>
    </article>
    <article class="stat is-green">
      <div class="label">Completed today</div>
      <div class="value">${stats.completed_today}</div>
      <div class="foot">Checked out at the gate</div>
    </article>`;
}

function matches(visit) {
  if (!state.filter) return true;
  const haystack = [visit.visitor_name, visit.office_name, visit.contact_name, visit.pass_code, visit.purpose]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(state.filter);
}

function statusChip(visit) {
  if (visit.status === 'at_gate') return '<span class="chip amber">Awaiting arrival</span>';
  if (visit.status === 'at_office') return '<span class="chip blue">At office</span>';
  if (visit.status === 'done') return '<span class="chip green">Completed</span>';
  return '<span class="chip red">Cancelled</span>';
}

function renderBoard() {
  const monitor = state.monitor;
  const board = $('#board');
  if (!monitor) {
    board.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }

  if (state.view === 'offices') {
    $('#boardTitle').textContent = 'Visits by office';
    $('#boardSub').textContent = 'Today, including average time to reach the office';
    board.innerHTML = renderOfficeSummary(monitor.officeSummary);
    return;
  }

  const isLive = state.view === 'live';
  $('#boardTitle').textContent = isLive ? 'Visitors in the building' : 'Completed today';
  $('#boardSub').textContent = isLive
    ? 'Updates automatically when an office scans a pass'
    : 'Checked out at the guard house today';

  const rows = (isLive ? monitor.active : monitor.completed).filter(matches);
  if (rows.length === 0) {
    board.innerHTML = `<div class="empty"><strong>${isLive ? 'No visitors inside right now' : 'Nothing completed yet'}</strong>${
      isLive ? 'Issue a pass to start tracking a visitor.' : 'Visitors you check out today will appear here.'
    }</div>`;
    return;
  }

  board.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pass</th>
            <th>Visitor</th>
            <th>Office</th>
            <th>Gate in</th>
            <th>Arrived</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((visit) => (isLive ? liveRow(visit) : completedRow(visit))).join('')}
        </tbody>
      </table>
    </div>`;
}

function liveRow(visit) {
  const waitingMinutes = (Date.now() - new Date(visit.gate_in_at).getTime()) / 60000;
  const elapsedClass = visit.status === 'at_gate' && waitingMinutes > 30 ? 'warn' : 'ok';
  return `
    <tr>
      <td><span class="code">${esc(visit.pass_code)}</span></td>
      <td>
        <div class="cell-strong">${esc(visit.visitor_name)}</div>
        <div class="cell-sub">${esc(visit.purpose || 'No purpose noted')}</div>
      </td>
      <td>
        <div class="cell-strong">${esc(visit.office_name)}</div>
        <div class="cell-sub">${esc(visit.contact_name || 'No contact set')}</div>
      </td>
      <td>
        <div>${fmtTime(visit.gate_in_at)}</div>
        <div class="cell-sub elapsed ${elapsedClass}" data-elapsed="${esc(visit.gate_in_at)}">${elapsed(visit.gate_in_at)}</div>
      </td>
      <td>
        <div>${fmtTime(visit.arrived_at)}</div>
        <div class="cell-sub">${esc(visit.arrived_by_name || (visit.arrived_at ? visit.arrived_office_name : 'Not yet scanned'))}</div>
      </td>
      <td>${statusChip(visit)}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-sm" data-action="activity" data-visit="${visit.id}">Log</button>
        <button class="btn btn-sm" data-action="checkout" data-visit="${visit.id}">Check out</button>
      </td>
    </tr>`;
}

function completedRow(visit) {
  return `
    <tr>
      <td><span class="code">${esc(visit.pass_code)}</span></td>
      <td>
        <div class="cell-strong">${esc(visit.visitor_name)}</div>
        <div class="cell-sub">${esc(visit.purpose || 'No purpose noted')}</div>
      </td>
      <td>
        <div class="cell-strong">${esc(visit.office_name)}</div>
        <div class="cell-sub">${esc(visit.contact_name || 'No contact set')}</div>
      </td>
      <td>${fmtTime(visit.gate_in_at)}</td>
      <td>${fmtTime(visit.checkout_at)}<div class="cell-sub">${esc(visit.checkout_note || '')}</div></td>
      <td>${statusChip(visit)}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-sm" data-action="activity" data-visit="${visit.id}">Log</button>
      </td>
    </tr>`;
}

function renderOfficeSummary(summary) {
  if (!summary?.length) return '<div class="empty">No offices yet. Add them in Admin.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Office</th><th>Visitors today</th><th>Still inside</th><th>Average gate → arrival</th></tr>
        </thead>
        <tbody>
          ${summary
            .map(
              (office) => `
            <tr>
              <td class="cell-strong">${esc(office.name)}</td>
              <td>${office.total ?? 0}</td>
              <td>${office.pending ?? 0}</td>
              <td>${office.avg_minutes == null ? '—' : `${Math.round(office.avg_minutes)} min`}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

async function onBoardClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const visitId = Number(button.dataset.visit);
  const visit = [...(state.monitor?.active ?? []), ...(state.monitor?.completed ?? [])].find((item) => item.id === visitId);

  if (button.dataset.action === 'activity') {
    openActivity(visitId, visit);
    return;
  }

  if (button.dataset.action === 'checkout') {
    const label = visit ? `${visit.visitor_name} (${visit.office_name})` : `visit #${visitId}`;
    const unconfirmed = visit?.status === 'at_gate';
    const prompt = unconfirmed
      ? `${label} has not been scanned in at the office. Check out anyway?`
      : `Check out ${label}?`;
    if (!window.confirm(prompt)) return;
    button.disabled = true;
    try {
      await api(`/api/visit/${visitId}/checkout`, { method: 'POST' });
      toast('Visitor checked out', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  }
}

async function openActivity(visitId, visit) {
  try {
    const { events } = await api(`/api/visit/${visitId}/events`);
    const items = events.length
      ? events
          .map(
            (event) => `
        <li>
          <time>${fmtTime(event.at)}</time>
          <div>
            <div>${esc(event.note || event.type)}</div>
            ${event.actor ? `<div class="who">by ${esc(event.actor)}</div>` : ''}
          </div>
        </li>`,
          )
          .join('')
      : '<li><time></time><div>No activity recorded.</div></li>';

    const heading = visit ? `${visit.visitor_name} · ${visit.pass_code}` : `Visit #${visitId}`;
    openModal(heading, `<ul class="timeline">${items}</ul>`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function refreshElapsed() {
  document.querySelectorAll('[data-elapsed]').forEach((node) => {
    node.textContent = elapsed(node.dataset.elapsed);
  });
}
