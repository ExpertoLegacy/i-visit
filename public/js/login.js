import { api, registerServiceWorker, returnPath } from './common.js';

registerServiceWorker();

const form = document.getElementById('loginForm');
const errorNode = document.getElementById('formError');
const submit = document.getElementById('submitBtn');

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
