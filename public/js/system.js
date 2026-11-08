import { api, esc, fmtDateTime, toast } from './common.js';

const SMS_CHIP = { sent: 'green', failed: 'red', pending: 'amber' };
const fileSize = (bytes) => (bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

function backupsPanel(status) {
  const rows = status.backups
    .map(
      (backup) => `
      <tr>
        <td class="cell-strong">${esc(backup.name)}</td>
        <td><span class="chip ${backup.kind === 'daily' ? 'blue' : 'gray'}">${esc(backup.kind)}</span></td>
        <td class="nowrap">${fmtDateTime(backup.created_at)}</td>
        <td>${fileSize(backup.size)}</td>
        <td class="actions"><a class="btn btn-sm" href="/api/backups/${encodeURIComponent(backup.name)}" download>Download</a></td>
      </tr>`,
    )
    .join('');
  return `
    <section class="panel">
      <div class="panel-head">
        <div><h2>Backups</h2><span class="sub">${status.keep ? `One copy a day while the server is running. The last ${status.keep} are kept.` : 'Daily backups are turned off.'}</span></div>
        <button class="btn btn-primary btn-sm" data-backup-now type="button">Back up now</button>
      </div>
      ${status.last_error ? `<div class="warning-line">⚠ The last daily backup failed at ${fmtDateTime(status.last_error.at)}: ${esc(status.last_error.message)}</div>` : ''}
      <p class="hint" style="margin-bottom: 10px">Saved in <span class="mono">${esc(status.directory)}</span>. Copy them to another drive now and then, in case this computer fails.</p>
      ${
        rows
          ? `<div class="table-wrap"><table><thead><tr><th>File</th><th>Type</th><th>Created</th><th>Size</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty">No backups yet.</div>'
      }
    </section>`;
}

function smsPanel(data) {
  const rows = data.notifications
    .map(
      (item) => `
      <tr>
        <td class="nowrap">${fmtDateTime(item.created_at)}</td>
        <td class="cell-strong">${esc(item.recipient || '—')}<div class="cell-sub">${esc(item.phone)}</div></td>
        <td>${esc(item.message)}</td>
        <td><span class="chip ${SMS_CHIP[item.status] || 'gray'}">${esc(item.status)}</span><div class="cell-sub">${esc(item.error || '')}</div></td>
      </tr>`,
    )
    .join('');
  return `
    <section class="panel">
      <div class="panel-head">
        <div><h2>SMS to contact persons</h2><span class="sub">Texts the contact person when a pass is issued for them</span></div>
        <span class="chip ${data.configured ? 'green' : 'gray'}">${data.configured ? 'Connected' : 'Not connected'}</span>
      </div>
      ${
        data.configured
          ? `<form class="row" data-sms-test style="margin-bottom: 14px">
              <label class="field grow"><span>Send a test message to</span><input class="input" name="phone" maxlength="32" placeholder="0917 000 0000" required /></label>
              <button class="btn" type="submit">Send test</button>
            </form>`
          : '<p class="hint" style="margin-bottom: 10px">No SMS gateway is set up, so no texts are sent. Guards can still call the contact using the number on the live board. See “SMS notifications” in the README to connect one.</p>'
      }
      ${
        rows
          ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Message</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty">No messages sent yet.</div>'
      }
    </section>`;
}

/** Renders backup and SMS status inside `container`. */
export async function mountSystem(container) {
  const root = document.createElement('div');
  root.className = 'tabview';
  container.replaceChildren(root);

  async function refresh() {
    try {
      const [backups, sms] = await Promise.all([api('/api/backups'), api('/api/notifications')]);
      root.innerHTML = backupsPanel(backups) + smsPanel(sms);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-backup-now]');
    if (!button) return;
    button.disabled = true;
    try {
      const { backup } = await api('/api/backups', { method: 'POST' });
      toast(`Saved ${backup.name}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    refresh();
  });

  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-sms-test]');
    if (!form) return;
    event.preventDefault();
    try {
      await api('/api/notifications/test', { method: 'POST', body: { phone: form.phone.value } });
      toast('Test message accepted by the gateway', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    refresh();
  });

  await refresh();
}
