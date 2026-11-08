import { api, esc, toast } from './common.js';

const minutes = (value) => (value == null ? '—' : `${Math.round(value)} min`);

function shiftDay(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

function tallyCells(item) {
  return `
    <td>${item.total}</td>
    <td>${item.confirmed}</td>
    <td>${item.unconfirmed}</td>
    <td>${item.inside}</td>
    <td>${item.cancelled}</td>
    <td>${minutes(item.avg_wait_minutes)}</td>
    <td>${minutes(item.avg_stay_minutes)}</td>`;
}

const TALLY_HEADS = '<th>Visits</th><th>Confirmed</th><th>Left unconfirmed</th><th>Still inside</th><th>Cancelled</th><th>Avg. gate to office</th><th>Avg. stay</th>';

function table(firstHead, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>${firstHead}</th>${TALLY_HEADS}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function stat(label, value, foot, tone = '') {
  return `<article class="stat ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></article>`;
}

/** Renders the report controls and results inside `container`. */
export async function mountReports(container, { offices }) {
  const { today, site } = await api('/api/me');
  const monthStart = `${today.slice(0, 8)}01`;

  const root = document.createElement('div');
  root.className = 'tabview';
  root.innerHTML = `
    <form class="row filter-form no-print" data-report-form>
      <label class="field"><span>From</span><input class="input" name="from" type="date" value="${monthStart}" required /></label>
      <label class="field"><span>To</span><input class="input" name="to" type="date" value="${today}" required /></label>
      <label class="field grow"><span>Office</span><select class="select" name="office_id">
        <option value="">All offices</option>
        ${offices.map((office) => `<option value="${office.id}">${esc(office.name)}</option>`).join('')}
      </select></label>
      <button class="btn btn-primary" type="submit">Generate</button>
      <button class="btn btn-ghost" data-range="today" type="button">Today</button>
      <button class="btn btn-ghost" data-range="week" type="button">Last 7 days</button>
      <button class="btn btn-ghost" data-range="month" type="button">This month</button>
      <button class="btn" data-print type="button">Print / PDF</button>
      <a class="btn" data-export download>Export CSV</a>
    </form>
    <div class="tabview" data-report-results><div class="empty">Loading…</div></div>`;
  container.replaceChildren(root);

  const form = root.querySelector('[data-report-form]');
  const results = root.querySelector('[data-report-results]');
  const exportLink = root.querySelector('[data-export]');

  async function generate() {
    const params = new URLSearchParams([...new FormData(form)].filter(([, value]) => String(value).trim()));
    try {
      const data = await api(`/api/reports/summary?${params}`);
      exportLink.href = `/api/visits.csv?${params}`;
      const officeName = form.office_id.selectedOptions[0].textContent;
      results.innerHTML = `
        <div class="print-only"><h1>${esc(site)} visitor report</h1><p>${esc(params.get('from'))} to ${esc(params.get('to'))} · ${esc(officeName)}</p></div>
        <section class="stats">
          ${stat('Total visits', data.totals.total, 'Passes issued in this period')}
          ${stat('Confirmed', data.totals.confirmed, 'Scanned in at an office', 'is-green')}
          ${stat('Left unconfirmed', data.totals.unconfirmed, 'Checked out without a scan', 'is-amber')}
          ${stat('Avg. gate to office', minutes(data.totals.avg_wait_minutes), 'From issue to confirmed arrival', 'is-blue')}
          ${stat('Avg. stay', minutes(data.totals.avg_stay_minutes), 'From issue to checkout')}
        </section>
        ${
          data.totals.total === 0
            ? '<section class="panel"><div class="empty"><strong>No visits in this period</strong>Choose a different date range or office.</div></section>'
            : `
        <section class="panel">
          <div class="panel-head"><h2>By office</h2></div>
          ${table('Office', data.by_office.map((item) => `<tr><td class="cell-strong">${esc(item.name)}</td>${tallyCells(item)}</tr>`).join(''))}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>By day</h2></div>
          ${table('Date', data.by_day.map((item) => `<tr><td class="cell-strong nowrap">${esc(item.day)}</td>${tallyCells(item)}</tr>`).join(''))}
        </section>`
        }`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    generate();
  });
  form.addEventListener('click', (event) => {
    if (event.target.closest('[data-print]')) {
      window.print();
      return;
    }
    const range = event.target.closest('[data-range]')?.dataset.range;
    if (!range) return;
    form.from.value = range === 'today' ? today : range === 'week' ? shiftDay(today, -6) : monthStart;
    form.to.value = today;
    generate();
  });

  generate();
}
