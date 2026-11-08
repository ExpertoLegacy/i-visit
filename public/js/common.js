export async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (response.status === 401 && path !== '/api/me') {
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (response.status === 403 && data?.error === 'password_change_required') {
    window.location.href = `/change-password?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new Error(data.message);
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.error;
    error.data = data;
    throw error;
  }
  return data;
}

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function elapsed(iso) {
  if (!iso) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function toast(message, kind = 'info') {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s ease';
    setTimeout(() => node.remove(), 220);
  }, 4200);
}

export function openModal(title, bodyHtml, options = {}) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${esc(title)}</h2>
        <button class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.closest('.modal-close')) closeModal();
  });
  document.body.appendChild(backdrop);
  if (options.focus) {
    const field = backdrop.querySelector(options.focus);
    if (field) field.focus();
  }
  return backdrop;
}

export function closeModal() {
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove());
}

export async function requireRole(roles) {
  let user = null;
  try {
    const data = await api('/api/me');
    user = data.user;
  } catch {
    window.location.href = '/login';
    return null;
  }
  if (roles && !roles.includes(user.role)) {
    window.location.href = user.role === 'admin' ? '/admin' : user.role === 'office' ? '/scan' : '/guard';
    return null;
  }
  return user;
}

export async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  window.location.href = '/login';
}

/** The same-site page named by ?next=, so people return to where they were headed. */
export function returnPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next) return null;
  const url = new URL(next, window.location.origin);
  return url.origin === window.location.origin ? url.pathname + url.search + url.hash : null;
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/** Normalize a typed or scanned value to the canonical GH-XXXX-XXXX form. */
export function normalizeCode(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('GH') ? raw.slice(2) : raw;
  if (body.length !== 8) return '';
  return `GH-${body.slice(0, 4)}-${body.slice(4)}`;
}
