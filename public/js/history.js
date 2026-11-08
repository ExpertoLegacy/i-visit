import { api, esc, fmtDateTime, openModal, toast } from './common.js';

const STATUS = {
  at_gate: ['amber', 'Awaiting arrival'],
  at_office: ['blue', 'At office'],
  done: ['green', 'Completed'],
  void: ['red', 'Cancelled'],
};

export async function showVisitActivity(visitId, heading) {
  try {
    const { events } = await api(`/api/visit/${visitId}/events`);
    const items = events.length
      ? events
          .map(
            (event) => `
        <li>
          <time>${fmtDateTime(event.at)}</time>
          <div>
            <div>${esc(event.note || event.type)}</div>
            ${event.actor ? `<div class="who">by ${esc(event.actor)}</div>` : ''}
          </div>
        </li>`,
          )
          .join('')
      : '<li><time></time><div>No activity recorded.</div></li>';
    openModal(heading, `<ul class="timeline">${items}</ul>`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function row(visit) {
  const [tone, label] = STATUS[visit.status] || STATUS.void;
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
      <td class="nowrap">${fmtDateTime(visit.gate_in_at)}</td>
      <td class="nowrap">${fmtDateTime(visit.arrived_at)}</td>
      <td class="nowrap">${fmtDateTime(visit.checkout_at)}<div class="cell-sub">${esc(visit.checkout_note || '')}</div></td>
      <td><span class="chip ${tone}">${label}</span></td>
      <td class="actions"><button class="btn btn-ghost btn-sm" data-history-visit="${visit.id}" data-heading="${esc(`${visit.visitor_name} · ${visit.pass_code}`)}" type="button">Log</button></td>
    </tr>`;
}

/** Renders the search form and results inside `container`. */
export function mountHistory(container, { offices, canExport = false }) {
  const root = document.createElement('div');
  root.className = 'tabview';
  root.innerHTML = `
    <form class="row filter-form" data-history-form>
      <label class="field"><span>From</span><input class="input" name="from" type="date" /></label>
      <label class="field"><span>To</span><input class="input" name="to" type="date" /></label>
      <label class="field grow"><span>Visitor, pass, purpose or contact</span><input class="input" name="q" maxlength="80" placeholder="Search" /></label>
      <label class="field"><span>Office</span><select class="select" name="office_id">
        <option value="">All offices</option>
        ${offices.map((office) => `<option value="${office.id}">${esc(office.name)}</option>`).join('')}
      </select></label>
      <label class="field"><span>Status</span><select class="select" name="status">
        <option value="">Any status</option>
        ${Object.entries(STATUS).map(([value, [, label]]) => `<option value="${value}">${label}</option>`).join('')}
      </select></label>
      <button class="btn btn-primary" type="submit">Search</button>
      <button class="btn btn-ghost" type="reset">Clear</button>
      ${canExport ? '<a class="btn" data-history-export download>Export CSV</a>' : ''}
    </form>
    <div data-history-results><div class="empty">Loading…</div></div>`;
  container.replaceChildren(root);

  const form = root.querySelector('[data-history-form]');
  const results = root.querySelector('[data-history-results]');
  const exportLink = root.querySelector('[data-history-export]');
  let filters = new URLSearchParams();
  let page = 1;

  async function load() {
    try {
      const data = await api(`/api/visits?${filters}&page=${page}`);
      page = data.page;
      if (exportLink) exportLink.href = `/api/visits.csv?${filters}`;
      results.innerHTML = data.total
        ? `
        <div class="panel-head"><span class="sub">${data.total} visit${data.total === 1 ? '' : 's'} found</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Pass</th><th>Visitor</th><th>Office</th><th>Gate in</th><th>Arrived</th><th>Checked out</th><th>Status</th><th></th></tr></thead>
            <tbody>${data.visits.map(row).join('')}</tbody>
          </table>
        </div>
        <div class="row pager">
          <button class="btn btn-sm" data-page="${page - 1}" type="button" ${page <= 1 ? 'disabled' : ''}>Previous</button>
          <span class="muted small">Page ${page} of ${data.pages}</span>
          <button class="btn btn-sm" data-page="${page + 1}" type="button" ${page >= data.pages ? 'disabled' : ''}>Next</button>
        </div>`
        : '<div class="empty"><strong>No visits found</strong>Try a wider date range or fewer filters.</div>';
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function applyForm() {
    filters = new URLSearchParams([...new FormData(form)].filter(([, value]) => String(value).trim()));
    page = 1;
    load();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    applyForm();
  });
  form.addEventListener('reset', () => setTimeout(applyForm));
  results.addEventListener('click', (event) => {
    const pageButton = event.target.closest('[data-page]');
    if (pageButton) {
      page = Number(pageButton.dataset.page);
      load();
      return;
    }
    const logButton = event.target.closest('[data-history-visit]');
    if (logButton) showVisitActivity(logButton.dataset.historyVisit, logButton.dataset.heading);
  });

  load();
}
