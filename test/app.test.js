// End-to-end tests. Each run starts the real server on a free port with a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADMIN_START = 'first-admin-pass';
const ADMIN_NEW = 'second-admin-pass';

let server;
let base;
let port;
let tempDir;
let smsServer;
let admin;
let guard;
let registrar;
let cashier;
let office;
let contact;
let codes;
const smsReceived = [];
let smsStatus = 200;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });

const childEnv = () => ({ ...process.env, DB_PATH: path.join(tempDir, 'app.db'), BACKUP_DIR: path.join(tempDir, 'backups') });

/** A signed-in (or anonymous) HTTP client that keeps its session cookie. */
async function client(username, password) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return {
      status: res.status,
      location: res.headers.get('location'),
      headers: res.headers,
      json: type.includes('json') ? await res.json() : null,
      text: type.includes('json') ? null : new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()),
    };
  };
  if (username) {
    const login = await call('POST', '/api/login', { username, password });
    assert.equal(login.status, 200, `login ${username}`);
  }
  return call;
}

async function issue(code, visitor, extra = {}) {
  const res = await guard('POST', '/api/issue', { code, visitor_name: visitor, office_id: office.id, ...extra });
  assert.equal(res.status, 201, `issue ${code}`);
  return res.json.visit;
}

async function waitFor(condition) {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('timed out waiting for condition');
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardhouse-test-'));
  smsServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      smsReceived.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = smsStatus;
      res.end('{}');
    });
  });
  await new Promise((resolve) => smsServer.listen(0, resolve));

  port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...childEnv(),
      PORT: String(port),
      SEED_DEMO: '1',
      ADMIN_PASSWORD: ADMIN_START,
      SMS_URL: `http://localhost:${smsServer.address().port}/send`,
      SMS_AUTH_HEADER: 'Bearer test-token',
      SMS_EXTRA: 'sender=GUARD',
    },
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${base}/health`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  guard = await client('guard1', 'guard123');
  registrar = await client('registrar1', 'office123');
  cashier = await client('cashier1', 'office123');
});

after(async () => {
  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  smsServer.close();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a new admin must change the password before doing anything else', async () => {
  admin = await client('admin', ADMIN_START);
  const blocked = await admin('GET', '/api/users');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'password_change_required');

  const page = await admin('GET', '/admin');
  assert.equal(page.location, '/change-password?next=%2Fadmin');
  assert.equal((await admin('GET', '/change-password')).status, 200);

  const same = await admin('POST', '/api/me/password', { current_password: ADMIN_START, new_password: ADMIN_START });
  assert.equal(same.json.error, 'same_password');

  const wrong = await admin('POST', '/api/me/password', { current_password: 'not-the-password', new_password: ADMIN_NEW });
  assert.equal(wrong.json.error, 'wrong_password');

  assert.equal((await admin('POST', '/api/me/password', { current_password: ADMIN_START, new_password: ADMIN_NEW })).status, 200);
  assert.equal((await admin('GET', '/api/users')).status, 200);
  assert.equal((await admin('GET', '/admin')).status, 200);
});

test('a new staff account is held at the password page too', async () => {
  const { json } = await admin('GET', '/api/directory');
  office = json.offices.find((item) => item.name === 'Registrar');
  contact = office.contacts[0];
  assert.equal((await admin('POST', '/api/users', { username: 'guard9', password: 'temporary-pass', role: 'guard' })).status, 201);
  const fresh = await client('guard9', 'temporary-pass');
  assert.equal((await fresh('GET', '/api/monitor')).status, 403);
  assert.match((await fresh('GET', '/guard')).location, /^\/change-password/);
});

test('roles are enforced', async () => {
  const anon = await client();
  assert.equal((await anon('GET', '/api/monitor')).status, 401);
  assert.equal((await anon('GET', '/api/visits')).status, 401);
  assert.equal((await registrar('POST', '/api/issue', {})).status, 403);
  assert.equal((await guard('POST', '/api/scan/confirm', {})).status, 403);
  assert.equal((await guard('GET', '/api/users')).status, 403);
  assert.equal((await registrar('GET', '/api/visits')).status, 403);
  assert.equal((await guard('GET', '/api/visits.csv')).status, 403);
  assert.equal((await guard('GET', '/api/reports/summary')).status, 403);
  assert.equal((await guard('GET', '/api/backups')).status, 403);
  assert.equal((await guard('GET', '/api/notifications')).status, 403);
});

test('a signed-out pass link keeps its code through login', async () => {
  const anon = await client();
  assert.equal((await anon('GET', '/scan?code=GH-AAAA-BBBB')).location, '/login?next=%2Fscan%3Fcode%3DGH-AAAA-BBBB');
});

test('passes print and move through issue, arrival and checkout', async () => {
  const batch = await admin('POST', '/api/batches', { count: 12, label: 'Tests' });
  assert.equal(batch.status, 201);
  const { passes } = (await admin('GET', `/api/passes?batch_id=${batch.json.batch.id}`)).json;
  codes = passes.map((pass) => pass.code);
  assert.equal(codes.length, 12);

  const print = await admin('GET', `/print/${batch.json.batch.id}`);
  assert.equal(print.text.match(/class="ticket"/g).length, 12);

  const visit = await issue(codes[0].toLowerCase(), 'Maria Santos', { purpose: 'Enrollment' });
  assert.equal((await guard('POST', '/api/issue', { code: codes[0], visitor_name: 'Other', office_id: office.id })).status, 409);
  assert.equal((await registrar('POST', '/api/scan', { code: codes[0] })).json.state, 'ready');
  assert.equal((await registrar('POST', '/api/scan/confirm', { code: codes[0] })).json.state, 'confirmed');
  assert.equal((await registrar('POST', '/api/scan/confirm', { code: codes[0] })).status, 409);
  assert.equal((await guard('GET', '/api/monitor')).json.stats.at_office, 1);
  assert.equal((await guard('POST', `/api/visit/${visit.id}/checkout`, {})).json.visit.status, 'done');
  assert.equal((await guard('POST', `/api/visit/${visit.id}/checkout`, {})).status, 409);
  assert.equal((await guard('POST', '/api/issue', { code: codes[0], visitor_name: 'Again', office_id: office.id })).status, 409);
});

test('edge cases at the gate and office', async () => {
  const unscanned = await issue(codes[1], 'Left Early');
  assert.match((await guard('POST', `/api/visit/${unscanned.id}/checkout`, {})).json.visit.checkout_note, /without/i);

  await issue(codes[2], 'Wrong Office');
  assert.equal((await cashier('POST', '/api/scan', { code: codes[2] })).json.warnings.length, 1);

  const { passes } = (await admin('GET', `/api/passes?q=${codes[3]}`)).json;
  await admin('POST', `/api/passes/${passes[0].id}/void`, { reason: 'lost' });
  assert.equal((await registrar('POST', '/api/scan/confirm', { code: codes[3] })).status, 409);

  assert.equal((await registrar('POST', '/api/scan', { code: 'GH-ZZZZ-ZZZZ' })).status, 404);
  assert.equal((await registrar('POST', '/api/scan', { code: 'x' })).status, 400);
  assert.equal((await guard('POST', '/api/issue', { code: codes[4], visitor_name: 'Bad Office', office_id: { a: 1 } })).status, 400);
});

test('malformed JSON is a client error', async () => {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
});

test('history searches by name, office, status and date, with paging', async () => {
  const { today } = (await guard('GET', '/api/me')).json;
  const byName = (await guard('GET', '/api/visits?q=maria')).json;
  assert.equal(byName.total, 1);
  assert.equal(byName.visits[0].visitor_name, 'Maria Santos');
  assert.equal((await guard('GET', `/api/visits?q=${codes[1]}`)).json.total, 1);
  assert.equal((await guard('GET', '/api/visits?q=%25')).json.total, 0, 'a % is searched literally');
  assert.equal((await guard('GET', '/api/visits?status=done')).json.total, 2);
  assert.equal((await guard('GET', `/api/visits?office_id=${office.id}&from=${today}&to=${today}`)).json.total, 3);
  assert.equal((await guard('GET', '/api/visits?from=2020-01-01&to=2020-01-31')).json.total, 0);

  const paged = (await guard('GET', '/api/visits?page_size=2&page=2')).json;
  assert.equal(paged.page, 2);
  assert.equal(paged.pages, 2);
  assert.equal(paged.visits.length, 1);

  assert.equal((await guard('GET', '/api/visits?from=2026-02-31')).status, 400);
  assert.equal((await guard('GET', '/api/visits?from=2026-02-01&to=2026-01-01')).status, 400);
});

test('reports total the visits for a period', async () => {
  const { today } = (await admin('GET', '/api/me')).json;
  const { totals, by_office: byOffice, by_day: byDay } = (await admin('GET', `/api/reports/summary?from=${today}&to=${today}`)).json;
  assert.equal(totals.total, 3);
  assert.equal(totals.confirmed, 1);
  assert.equal(totals.unconfirmed, 1);
  assert.equal(totals.inside, 1);
  assert.equal(byOffice[0].name, 'Registrar');
  assert.deepEqual(byDay.map((item) => [item.day, item.total]), [[today, 3]]);
  assert.equal((await admin('GET', '/api/reports/summary?from=2020-01-01&to=2020-01-02')).json.totals.total, 0);
});

test('CSV export is quoted and neutralises spreadsheet formulas', async () => {
  await issue(codes[5], '=HYPERLINK("http://x","click")');
  const csv = await admin('GET', '/api/visits.csv?q=HYPERLINK&from=2026-01-01');
  assert.match(csv.headers.get('content-disposition'), /visits_2026-01-01\.csv/);
  assert.equal(csv.text.charCodeAt(0), 0xfeff);
  const [header, row] = csv.text.slice(1).split('\r\n');
  assert.match(header, /^Pass,Visitor,Office/);
  assert.ok(row.includes(`"'=HYPERLINK(""http://x"",""click"")"`), row);
});

test('the contact person gets an SMS and the visit log records it', async () => {
  smsReceived.length = 0;
  const visit = await issue(codes[6], 'Pedro Reyes', { contact_id: contact.id, purpose: 'Records' });
  await waitFor(() => smsReceived.length === 1);
  assert.equal(smsReceived[0].auth, 'Bearer test-token');
  assert.equal(smsReceived[0].body.to, contact.phone);
  assert.equal(smsReceived[0].body.sender, 'GUARD');
  assert.match(smsReceived[0].body.message, /Pedro Reyes is on the way to Registrar/);

  let events = [];
  for (let i = 0; i < 50 && !events.some((event) => event.type === 'notified'); i += 1) {
    events = (await guard('GET', `/api/visit/${visit.id}/events`)).json.events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(events.some((event) => event.type === 'notified'));
});

test('a failing SMS gateway never blocks issuing a pass', async () => {
  smsStatus = 500;
  smsReceived.length = 0;
  await issue(codes[7], 'Gateway Down', { contact_id: contact.id });
  await waitFor(() => smsReceived.length === 1);
  smsStatus = 200;
  let recent = [];
  for (let i = 0; i < 50 && recent[0]?.status !== 'failed'; i += 1) {
    recent = (await admin('GET', '/api/notifications')).json.notifications;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(recent[0].status, 'failed');
  assert.match(recent[0].error, /500/);
});

test('backups run daily, on demand, and hold no live sessions', async () => {
  const status = (await admin('GET', '/api/backups')).json;
  assert.ok(status.backups.some((backup) => backup.kind === 'daily'), 'daily backup taken at startup');

  const created = await admin('POST', '/api/backups');
  assert.equal(created.status, 201);
  const { name } = created.json.backup;

  const download = await fetch(`${base}/api/backups/${name}`);
  assert.equal(download.status, 401, 'download needs sign-in');
  assert.equal((await admin('GET', `/api/backups/${name}`)).status, 200);
  assert.equal((await admin('GET', '/api/backups/..%2Fapp.db')).status, 404);

  const copy = new DatabaseSync(path.join(tempDir, 'backups', name), { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM visits').get().n > 0);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();
});

test('the recovery script issues a temporary password that must be changed', async () => {
  const output = execFileSync(process.execPath, ['--no-warnings', 'scripts/reset-password.mjs', 'guard9'], { cwd: ROOT, env: childEnv(), encoding: 'utf8' });
  const temporary = output.match(/Temporary password: (\S+)/)[1];
  const recovered = await client('guard9', temporary);
  assert.equal((await recovered('GET', '/api/me')).json.user.must_change_password, true);
  assert.equal((await recovered('GET', '/api/monitor')).status, 403);

  assert.throws(() => execFileSync(process.execPath, ['--no-warnings', 'scripts/reset-password.mjs', 'nobody'], { cwd: ROOT, env: childEnv(), stdio: 'pipe' }));
});

test('spoofed X-Forwarded-For cannot dodge the login rate limit', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((item) => item.family === 'IPv4' && !item.internal);
  if (!lan) return t.skip('needs a non-loopback network address');
  const attempt = (headers = {}) =>
    fetch(`http://${lan.address}:${port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'cashier1', password: 'wrong-password' }),
    }).then((res) => res.status);
  let last;
  for (let i = 0; i < 13; i += 1) last = await attempt();
  assert.equal(last, 429);
  assert.equal(await attempt({ 'x-forwarded-for': '203.0.113.77' }), 429);
});
