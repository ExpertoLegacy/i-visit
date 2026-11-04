import {
  api,
  esc,
  fmtTime,
  toast,
  requireRole,
  logout,
  registerServiceWorker,
  normalizeCode,
} from './common.js';

const $ = (selector) => document.querySelector(selector);
const state = { me: null, scanner: null, scanning: false, busy: false, recent: [], resetTimer: null };

boot();

async function boot() {
  registerServiceWorker();
  state.me = await requireRole(['office', 'admin']);
  if (!state.me) return;

  $('#staffName').textContent = state.me.full_name || state.me.username;
  $('#officeName').textContent = state.me.office_name || (state.me.role === 'admin' ? 'Administrator' : 'Office');

  $('#logoutBtn').addEventListener('click', logout);
  $('#manualForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = normalizeCode($('#manualCode').value);
    if (!code) {
      toast('Codes look like GH-XXXX-XXXX.', 'error');
      return;
    }
    $('#manualCode').value = '';
    preview(code);
  });

  $('#startBtn').addEventListener('click', startCamera);
  $('#stopBtn').addEventListener('click', stopCamera);
  $('#result').addEventListener('click', onResultClick);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
  });

  if (!window.isSecureContext) {
    $('#cameraHint').textContent = 'Camera capture needs HTTPS on this connection. Type the pass code below instead.';
    $('#startBtn').disabled = true;
  }

  const prefill = new URLSearchParams(window.location.search).get('code');
  if (prefill) preview(normalizeCode(prefill) || prefill);
}

/* ------------------------------------------------------------------ camera */

async function startCamera() {
  if (state.scanning || state.busy) return;
  if (typeof Html5Qrcode === 'undefined') {
    $('#cameraHint').textContent = 'The scanner did not load. Type the pass code below.';
    return;
  }
  try {
    if (!state.scanner) state.scanner = new Html5Qrcode('reader', { verbose: false });
    await state.scanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: (width, height) => {
          const size = Math.floor(Math.min(width, height) * 0.72);
          return { width: size, height: size };
        },
      },
      onScan,
      undefined,
    );
    state.scanning = true;
    $('#startBtn').hidden = true;
    $('#stopBtn').hidden = false;
    $('#cameraHint').textContent = 'Scanning… hold the pass inside the frame.';
  } catch (err) {
    $('#cameraHint').textContent = `Could not start the camera (${err?.message || err}). Type the code below.`;
  }
}

async function stopCamera() {
  if (!state.scanner || !state.scanning) return;
  try {
    await state.scanner.stop();
  } catch {
    /* already stopped */
  }
  state.scanning = false;
  $('#startBtn').hidden = false;
  $('#stopBtn').hidden = true;
}

function extractCode(text) {
  const raw = String(text ?? '').trim();
  try {
    const url = new URL(raw);
    const fromQuery = url.searchParams.get('code');
    if (fromQuery) return normalizeCode(fromQuery) || fromQuery;
  } catch {
    /* not a URL */
  }
  const match = raw.toUpperCase().match(/GH[\s-]*([A-Z0-9]{4})[\s-]*([A-Z0-9]{4})/);
  if (match) return normalizeCode(`GH${match[1]}${match[2]}`);
  return normalizeCode(raw) || raw;
}

function onScan(decodedText) {
  if (state.busy) return;
  const code = extractCode(decodedText);
  if (!code) return;
  state.busy = true;
  stopCamera().then(() => preview(code));
}

/* ------------------------------------------------------------------ results */

async function preview(code) {
  clearTimeout(state.resetTimer);
  state.busy = true;
  $('#result').innerHTML = '<div class="panel empty">Checking pass…</div>';
  try {
    const result = await api('/api/scan', { method: 'POST', body: { code } });
    renderResult(result);
  } catch (err) {
    renderResult({ state: err.data?.state || 'unknown', code, message: err.message });
  }
}

function visitorDetails(visit) {
  return `
    <div class="detail-grid">
      <div><div class="k">Visitor</div><div class="v">${esc(visit.visitor_name)}</div></div>
      <div><div class="k">Pass</div><div class="v mono">${esc(visit.pass_code)}</div></div>
      <div><div class="k">Office to visit</div><div class="v">${esc(visit.office_name)}</div></div>
      <div><div class="k">Contact person</div><div class="v">${esc(visit.contact_name || 'Not set')}</div></div>
      <div><div class="k">Gate-in time</div><div class="v">${fmtTime(visit.gate_in_at)}</div></div>
      <div><div class="k">Purpose</div><div class="v">${esc(visit.purpose || '—')}</div></div>
    </div>`;
}

function renderResult(result) {
  const node = $('#result');

  if (result.state === 'ready') {
    const visit = result.visit;
    node.innerHTML = `
      <article class="result-card">
        <div class="result-top">
          <div class="result-icon">QR</div>
          <div>
            <div class="result-title">Is this your visitor?</div>
            <div class="result-sub">Confirm only when the person is in front of you.</div>
          </div>
        </div>
        ${(result.warnings || []).map((warning) => `<div class="warning-line">⚠ ${esc(warning)}</div>`).join('')}
        ${visitorDetails(visit)}
        <button class="btn btn-primary btn-lg btn-block" data-action="confirm" data-code="${esc(result.code)}">Confirm arrival</button>
        <button class="btn btn-ghost btn-block" data-action="reset" style="margin-top: 10px">Cancel</button>
      </article>`;
    return;
  }

  const messages = {
    already: {
      tone: 'success',
      icon: '✓',
      title: 'Already confirmed',
      body: (visit) =>
        visit
          ? `Arrival was confirmed at ${fmtTime(visit.arrived_at)}${visit.arrived_by_name ? ` by ${esc(visit.arrived_by_name)}` : ''}.`
          : 'This pass was already confirmed.',
    },
    completed: {
      tone: 'warn',
      icon: '⏱',
      title: 'Visit already completed',
      body: (visit) => (visit ? `This visitor checked out at ${fmtTime(visit.checkout_at)}.` : 'This pass has already been used.'),
    },
    unissued: {
      tone: 'warn',
      icon: '!',
      title: 'Not issued yet',
      body: () => 'The guard house has not issued this pass. Ask the visitor to register at the gate first.',
    },
    void: {
      tone: 'error',
      icon: '×',
      title: 'Pass cancelled',
      body: () => 'This pass was voided. Send the visitor back to the guard house.',
    },
    unknown: {
      tone: 'error',
      icon: '?',
      title: 'Unknown pass',
      body: () => 'This code is not in the system. Check the code or ask the guard house.',
    },
  };

  const info = messages[result.state] || messages.unknown;
  const visit = result.visit;
  node.innerHTML = `
    <article class="result-card ${info.tone}">
      <div class="result-top">
        <div class="result-icon">${info.icon}</div>
        <div>
          <div class="result-title">${info.title}</div>
          <div class="result-sub">${info.body(visit)}</div>
        </div>
      </div>
      ${visit ? visitorDetails(visit) : ''}
      <p class="hint">${esc(result.message || '')}</p>
      <button class="btn btn-block" data-action="reset" style="margin-top: 10px">Scan another pass</button>
    </article>`;
  state.busy = false;
}

async function onResultClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  if (button.dataset.action === 'reset') {
    clearTimeout(state.resetTimer);
    clearResult();
    $('#manualCode').focus();
    return;
  }

  if (button.dataset.action === 'confirm') {
    button.disabled = true;
    button.textContent = 'Confirming…';
    try {
      const data = await api('/api/scan/confirm', { method: 'POST', body: { code: button.dataset.code } });
      showConfirmed(data);
      if (navigator.vibrate) navigator.vibrate(60);
    } catch (err) {
      toast(err.message, 'error');
      if (err.data?.result) renderResult(err.data.result);
      else {
        button.disabled = false;
        button.textContent = 'Confirm arrival';
      }
    }
  }
}

function showConfirmed(data) {
  const visit = data.visit;
  $('#result').innerHTML = `
    <article class="result-card success">
      <div class="result-top">
        <div class="result-icon">✓</div>
        <div>
          <div class="result-title">Arrival confirmed</div>
          <div class="result-sub">${esc(visit.visitor_name)} · ${fmtTime(data.at)}${state.me.office_name ? ` · ${esc(state.me.office_name)}` : ''}</div>
        </div>
      </div>
      ${(data.warnings || []).map((warning) => `<div class="warning-line">⚠ ${esc(warning)}</div>`).join('')}
      <p class="hint">The guard house has been notified.</p>
      <button class="btn btn-primary btn-block" data-action="reset" style="margin-top: 12px">Scan next visitor</button>
    </article>`;

  state.recent.unshift({ name: visit.visitor_name, office: visit.office_name, at: data.at });
  state.recent = state.recent.slice(0, 8);
  renderRecent();
  state.busy = false;

  clearTimeout(state.resetTimer);
  state.resetTimer = setTimeout(() => {
    if (document.querySelector('#result [data-action="reset"]')) {
      clearResult();
      startCamera();
    }
  }, 6000);
}

function renderRecent() {
  const card = $('#recentCard');
  card.hidden = state.recent.length === 0;
  $('#recentList').innerHTML = state.recent
    .map(
      (item) => `<li><span>${esc(item.name)}<span class="muted small"> · ${esc(item.office)}</span></span><span class="muted small">${fmtTime(item.at)}</span></li>`,
    )
    .join('');
}

function clearResult() {
  $('#result').innerHTML = '';
  state.busy = false;
}
