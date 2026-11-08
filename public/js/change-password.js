import { api, logout, returnPath } from './common.js';

const $ = (id) => document.getElementById(id);
const leave = () => {
  window.location.href = returnPath() || '/';
};

$('logoutBtn').addEventListener('click', logout);
$('backBtn').addEventListener('click', leave);

api('/api/me')
  .then(({ user }) => {
    if (!user.must_change_password) return;
    $('intro').textContent = 'You must set your own password before continuing.';
    $('backBtn').hidden = true;
  })
  .catch(() => {
    window.location.href = '/login?next=%2Fchange-password';
  });

$('passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('formError').textContent = '';
  if ($('next').value !== $('repeat').value) {
    $('formError').textContent = 'The new passwords do not match.';
    return;
  }
  $('submitBtn').disabled = true;
  try {
    await api('/api/me/password', { method: 'POST', body: { current_password: $('current').value, new_password: $('next').value } });
    leave();
  } catch (err) {
    $('formError').textContent = err.message;
    $('submitBtn').disabled = false;
  }
});

$('current').focus();
