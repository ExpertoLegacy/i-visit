import { api, registerServiceWorker } from './common.js';

registerServiceWorker();

const form = document.getElementById('loginForm');
const errorNode = document.getElementById('formError');
const submit = document.getElementById('submitBtn');

/** The same-site page that sent the user here, so a scanned pass link survives signing in. */
function returnPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next) return null;
  const url = new URL(next, window.location.origin);
  return url.origin === window.location.origin ? url.pathname + url.search + url.hash : null;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorNode.textContent = '';
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: {
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
      },
    });
    window.location.href = returnPath() || data.redirect || '/';
  } catch (err) {
    errorNode.textContent = err.message;
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

document.getElementById('username').focus();
