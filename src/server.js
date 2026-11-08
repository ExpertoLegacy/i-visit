import './env.js';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { db, normalizeCode, newPassCode, now, addEvent, DB_PATH } from './db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { notifyContact, sendSms, smsConfigured, recentNotifications } from './notify.js';
import { createBackup, backupStatus, backupPath, startBackupSchedule } from './backup.js';
import {
  attachUser,
  requireAuth,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
} from './session.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const requestedPort = Number(process.env.PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 3000;
const SITE_NAME = process.env.SITE_NAME || 'Guard House';
const TZ = process.env.APP_TZ || 'Asia/Manila';
const ROLES = ['admin', 'guard', 'office'];
const PASS_STATUSES = ['unused', 'issued', 'arrived', 'done', 'void'];

const app = express();
app.disable('x-powered-by');
// Only a proxy on this machine may set the client IP; otherwise X-Forwarded-For could dodge the login rate limit.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '256kb' }));
app.use(attachUser);

/* ------------------------------------------------------------------ helpers */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const text = (value, max) => String(value ?? '').trim().slice(0, max);

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

function baseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

function homeFor(role) {
  if (role === 'admin') return '/admin';
  if (role === 'office') return '/scan';
  return '/guard';
}

function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60000;
}

/** ISO timestamp of local midnight for the configured time zone. */
function startOfDayISO(timeZone = TZ) {
  const current = new Date();
  const offset = tzOffsetMinutes(current, timeZone);
  const local = new Date(current.getTime() + offset * 60000);
  const localMidnightUtcMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0);
  return new Date(localMidnightUtcMs - offset * 60000).toISOString();
}

function localDateLabel(timeZone = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const PASS_STATUS_MESSAGE = {
  issued: 'That pass is already issued to a visitor.',
  arrived: 'That pass is already confirmed at an office.',
  done: 'That pass has already been used and checked out.',
  void: 'That pass has been cancelled.',
};

const VISIT_SELECT = `
  SELECT v.id, v.pass_id, v.visitor_name, v.purpose, v.status, v.gate_in_at, v.arrived_at,
         v.checkout_at, v.checkout_note, v.office_id, v.contact_id,
         p.code AS pass_code,
         o.name AS office_name,
         ao.name AS arrived_office_name,
         c.name AS contact_name, c.phone AS contact_phone,
         gu.full_name AS gate_in_by_name, gu.username AS gate_in_by_username,
         au.full_name AS arrived_by_name, au.username AS arrived_by_username,
         cu.full_name AS checkout_by_name, cu.username AS checkout_by_username
  FROM visits v
  JOIN passes p ON p.id = v.pass_id
  JOIN offices o ON o.id = v.office_id
  LEFT JOIN offices ao ON ao.id = v.arrived_office_id
  LEFT JOIN contacts c ON c.id = v.contact_id
  LEFT JOIN users gu ON gu.id = v.gate_in_by
  LEFT JOIN users au ON au.id = v.arrived_by
  LEFT JOIN users cu ON cu.id = v.checkout_by`;

const BATCH_SELECT = `
  SELECT b.id, b.label, b.count, b.created_at,
    (SELECT COUNT(*) FROM passes p WHERE p.batch_id = b.id AND p.status = 'unused') AS unused,
    (SELECT COUNT(*) FROM passes p WHERE p.batch_id = b.id AND p.status = 'issued') AS issued,
    (SELECT COUNT(*) FROM passes p WHERE p.batch_id = b.id AND p.status = 'arrived') AS arrived,
    (SELECT COUNT(*) FROM passes p WHERE p.batch_id = b.id AND p.status = 'done') AS done,
    (SELECT COUNT(*) FROM passes p WHERE p.batch_id = b.id AND p.status = 'void') AS void_count
  FROM batches b`;

const getVisit = (id) => db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(Number(id)) ?? null;
const getBatch = (id) => db.prepare(`${BATCH_SELECT} WHERE b.id = ?`).get(Number(id)) ?? null;

/* --------------------------------------------------------------- live stream */

const streamClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streamClients) {
    try {
      res.write(payload);
    } catch {
      streamClients.delete(res);
    }
  }
}

app.get('/api/stream', requireAuth(['guard', 'admin']), (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`);
  streamClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* closed */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    streamClients.delete(res);
  });
});

/* -------------------------------------------------------------------- pages */

function page(roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (req.user.must_change_password) return res.redirect(`/change-password?next=${encodeURIComponent(req.originalUrl)}`);
    if (roles && !roles.includes(req.user.role)) return res.redirect(homeFor(req.user.role));
    return next();
  };
}

const sendPage = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  return res.redirect(homeFor(req.user.role));
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user.role));
  return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/change-password', (req, res) => {
  if (!req.user) return res.redirect('/login?next=%2Fchange-password');
  return res.sendFile(path.join(PUBLIC_DIR, 'change-password.html'));
});

app.get('/guard', page(['guard', 'admin']), sendPage('guard.html'));
app.get('/scan', page(['office', 'admin']), sendPage('scan.html'));
app.get('/admin', page(['admin']), sendPage('admin.html'));

app.get('/health', (req, res) => {
  res.json({ ok: true, time: now(), tz: TZ, database: path.basename(DB_PATH) });
});

/* --------------------------------------------------------------------- auth */

const loginAttempts = new Map();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_LIMIT = 12;

function attemptKey(req, username) {
  return `${req.ip}|${String(username).toLowerCase()}`;
}

function isBlocked(key) {
  const record = loginAttempts.get(key);
  if (!record) return false;
  if (Date.now() - record.first > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return record.count >= ATTEMPT_LIMIT;
}

function recordFailure(key) {
  const record = loginAttempts.get(key);
  if (record && Date.now() - record.first <= ATTEMPT_WINDOW_MS) record.count += 1;
  else loginAttempts.set(key, { count: 1, first: Date.now() });
}

app.post('/api/login', (req, res) => {
  const body = req.body ?? {};
  const username = text(body.username, 64).toLowerCase();
  const password = String(body.password ?? '');
  if (!username || !password) return sendError(res, 400, 'missing_credentials', 'Enter your username and password.');

  const key = attemptKey(req, username);
  if (isBlocked(key)) return sendError(res, 429, 'too_many_attempts', 'Too many attempts. Try again in a few minutes.');

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    recordFailure(key);
    return sendError(res, 401, 'invalid_credentials', 'Incorrect username or password.');
  }

  loginAttempts.delete(key);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  const token = createSession(user.id);
  setSessionCookie(req, res, token);
  const office = user.office_id ? db.prepare('SELECT name FROM offices WHERE id = ?').get(user.office_id) : null;
  res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      office_id: user.office_id,
      office_name: office?.name ?? null,
      must_change_password: Boolean(user.must_change_password),
    },
    redirect: homeFor(user.role),
  });
});

app.post('/api/logout', (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  res.json({ user: req.user, site: SITE_NAME, tz: TZ, today: localDateLabel() });
});

app.post('/api/me/password', requireAuth(undefined, { allowPasswordChange: true }), (req, res) => {
  const body = req.body ?? {};
  const current = String(body.current_password ?? '');
  const next = String(body.new_password ?? '');
  if (next.length < 8) return sendError(res, 400, 'weak_password', 'New password must be at least 8 characters.');
  if (next === current) return sendError(res, 400, 'same_password', 'Choose a password different from the current one.');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, row.password_hash)) return sendError(res, 400, 'wrong_password', 'Current password is incorrect.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), req.user.id);
  addEvent({ type: 'password_changed', note: `${req.user.username} changed their password`, userId: req.user.id });
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- directory */

app.get('/api/directory', requireAuth(ROLES), (req, res) => {
  const offices = db.prepare('SELECT id, name FROM offices WHERE active = 1 ORDER BY name').all();
  const contacts = db.prepare('SELECT id, office_id, name, phone FROM contacts WHERE active = 1 ORDER BY name').all();
  res.json({
    offices: offices.map((office) => ({ ...office, contacts: contacts.filter((contact) => contact.office_id === office.id) })),
  });
});

/* -------------------------------------------------------------------- guard */

app.post('/api/passes/lookup', requireAuth(['guard', 'admin']), (req, res) => {
  const code = normalizeCode((req.body ?? {}).code);
  if (!code) return sendError(res, 400, 'invalid_code', 'Pass codes look like GH-XXXX-XXXX.');
  const pass = db.prepare('SELECT id, code, status FROM passes WHERE code = ?').get(code);
  if (!pass) return sendError(res, 404, 'unknown_code', 'That pass code is not in the system.');
  const visit = db.prepare(`${VISIT_SELECT} WHERE v.pass_id = ? ORDER BY v.id DESC LIMIT 1`).get(pass.id) ?? null;
  res.json({ pass, visit });
});

app.post('/api/issue', requireAuth(['guard', 'admin']), (req, res) => {
  const body = req.body ?? {};
  const code = normalizeCode(body.code);
  if (!code) return sendError(res, 400, 'invalid_code', 'Pass codes look like GH-XXXX-XXXX.');

  const pass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);
  if (!pass) return sendError(res, 404, 'unknown_code', 'That pass code is not in the system.');
  if (pass.status !== 'unused') {
    return sendError(res, 409, `pass_${pass.status}`, PASS_STATUS_MESSAGE[pass.status] || 'That pass cannot be issued.');
  }

  const visitorName = text(body.visitor_name, 80);
  if (visitorName.length < 2) return sendError(res, 400, 'invalid_visitor', 'Enter the visitor\u2019s full name.');

  const office = db.prepare('SELECT id, name FROM offices WHERE id = ? AND active = 1').get(Number(body.office_id));
  if (!office) return sendError(res, 400, 'invalid_office', 'Choose the office being visited.');

  let contactId = body.contact_id ? Number(body.contact_id) : null;
  if (contactId) {
    const contact = db.prepare('SELECT id, office_id FROM contacts WHERE id = ? AND active = 1').get(contactId);
    if (!contact || contact.office_id !== office.id) {
      return sendError(res, 400, 'invalid_contact', 'That contact person is not assigned to the chosen office.');
    }
  } else {
    contactId = null;
  }

  const purpose = text(body.purpose, 120) || null;
  const at = now();

  db.exec('BEGIN');
  try {
    const claimed = db.prepare("UPDATE passes SET status = 'issued' WHERE id = ? AND status = 'unused'").run(pass.id);
    if (claimed.changes !== 1) {
      db.exec('ROLLBACK');
      return sendError(res, 409, 'pass_taken', 'That pass was just used. Try another one.');
    }
    const inserted = db
      .prepare(
        `INSERT INTO visits (pass_id, visitor_name, office_id, contact_id, purpose, status, gate_in_at, gate_in_by)
         VALUES (?, ?, ?, ?, ?, 'at_gate', ?, ?)`,
      )
      .run(pass.id, visitorName, office.id, contactId, purpose, at, req.user.id);
    const visitId = Number(inserted.lastInsertRowid);
    addEvent({ passId: pass.id, visitId, type: 'issued', note: `Pass issued for ${office.name}`, userId: req.user.id });
    db.exec('COMMIT');
    broadcast('visit.updated', { kind: 'issue', visit_id: visitId, visitor_name: visitorName, code, office_name: office.name, at });
    const visit = getVisit(visitId);
    // Runs in the background so a slow gateway never delays the gate.
    notifyContact(visit, SITE_NAME).catch((err) => console.error('[sms] notification failed:', err.message));
    return res.status(201).json({ visit });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
});

app.post('/api/visit/:id/checkout', requireAuth(['guard', 'admin']), (req, res) => {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(Number(req.params.id));
  if (!visit) return sendError(res, 404, 'not_found', 'Visit not found.');
  if (visit.status === 'done') return sendError(res, 409, 'already_done', 'This visitor is already checked out.');
  if (visit.status === 'void') return sendError(res, 409, 'void', 'This visit was cancelled.');

  const departedUnconfirmed = visit.status === 'at_gate';
  const at = now();

  db.exec('BEGIN');
  try {
    const closed = db
      .prepare("UPDATE visits SET status = 'done', checkout_at = ?, checkout_by = ?, checkout_note = ? WHERE id = ? AND status IN ('at_gate','at_office')")
      .run(at, req.user.id, departedUnconfirmed ? 'Departed without office confirmation' : null, visit.id);
    if (closed.changes !== 1) {
      db.exec('ROLLBACK');
      return sendError(res, 409, 'conflict', 'That visit changed a moment ago. Refresh and try again.');
    }
    db.prepare("UPDATE passes SET status = 'done' WHERE id = ? AND status IN ('issued','arrived')").run(visit.pass_id);
    addEvent({
      passId: visit.pass_id,
      visitId: visit.id,
      type: 'checkout',
      note: departedUnconfirmed ? 'Checked out at the gate without office confirmation' : 'Visitor checked out',
      userId: req.user.id,
    });
    db.exec('COMMIT');
    broadcast('visit.updated', { kind: 'checkout', visit_id: visit.id, visitor_name: visit.visitor_name, at });
    return res.json({ visit: getVisit(visit.id) });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
});

app.get('/api/monitor', requireAuth(['guard', 'admin']), (req, res) => {
  const dayStart = startOfDayISO();
  const active = db.prepare(`${VISIT_SELECT} WHERE v.status IN ('at_gate','at_office') ORDER BY v.gate_in_at DESC`).all();
  const completed = db
    .prepare(`${VISIT_SELECT} WHERE v.status = 'done' AND v.checkout_at >= ? ORDER BY v.checkout_at DESC LIMIT 60`)
    .all(dayStart);

  const stats = {
    issued_today: db.prepare('SELECT COUNT(*) AS total FROM visits WHERE gate_in_at >= ?').get(dayStart).total,
    awaiting: db.prepare("SELECT COUNT(*) AS total FROM visits WHERE status = 'at_gate'").get().total,
    at_office: db.prepare("SELECT COUNT(*) AS total FROM visits WHERE status = 'at_office'").get().total,
    completed_today: db.prepare("SELECT COUNT(*) AS total FROM visits WHERE status = 'done' AND checkout_at >= ?").get(dayStart).total,
  };

  const officeSummary = db
    .prepare(
      `SELECT o.id, o.name,
              COUNT(v.id) AS total,
              SUM(CASE WHEN v.status IN ('at_gate','at_office') THEN 1 ELSE 0 END) AS pending,
              AVG(CASE WHEN v.arrived_at IS NOT NULL THEN (julianday(v.arrived_at) - julianday(v.gate_in_at)) * 1440 END) AS avg_minutes
       FROM offices o
       LEFT JOIN visits v ON v.office_id = o.id AND v.gate_in_at >= ? AND v.status != 'void'
       WHERE o.active = 1
       GROUP BY o.id
       ORDER BY o.name`,
    )
    .all(dayStart);

  res.json({ server_time: now(), tz: TZ, day_start: dayStart, stats, active, completed, officeSummary });
});

app.get('/api/visit/:id/events', requireAuth(ROLES), (req, res) => {
  const visitId = Number(req.params.id);
  const visit = db.prepare('SELECT id, office_id FROM visits WHERE id = ?').get(visitId);
  if (!visit) return sendError(res, 404, 'not_found', 'Visit not found.');
  if (req.user.role === 'office' && req.user.office_id && visit.office_id !== req.user.office_id) {
    return sendError(res, 403, 'forbidden', 'That visit belongs to another office.');
  }
  const events = db
    .prepare(
      `SELECT e.id, e.type, e.note, e.at, COALESCE(u.full_name, u.username) AS actor
       FROM events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.visit_id = ? ORDER BY e.id`,
    )
    .all(visitId);
  res.json({ events });
});

/* -------------------------------------------------------------------- scan */

function resolveScan(code, user) {
  const pass = db.prepare('SELECT id, code, status FROM passes WHERE code = ?').get(code);
  if (!pass) return { state: 'unknown', code };
  const visit = db.prepare(`${VISIT_SELECT} WHERE v.pass_id = ? ORDER BY v.id DESC LIMIT 1`).get(pass.id) ?? null;

  if (pass.status === 'unused') return { state: 'unissued', code: pass.code, pass_id: pass.id };
  if (pass.status === 'void') return { state: 'void', code: pass.code, pass_id: pass.id, visit };
  if (pass.status === 'done') return { state: 'completed', code: pass.code, pass_id: pass.id, visit };
  if (pass.status === 'arrived') return { state: 'already', code: pass.code, pass_id: pass.id, visit };

  const warnings = [];
  if (user.role === 'office' && user.office_id && visit && visit.office_id !== user.office_id) {
    warnings.push(`This pass was issued for ${visit.office_name}. You are confirming from ${user.office_name || 'another office'}.`);
  }
  return { state: 'ready', code: pass.code, pass_id: pass.id, visit, warnings };
}

function parseScanCode(body) {
  return normalizeCode(body?.code);
}

app.post('/api/scan', requireAuth(['office', 'admin']), (req, res) => {
  const code = parseScanCode(req.body);
  if (!code) return sendError(res, 400, 'invalid_code', 'That does not look like a pass code.');
  const result = resolveScan(code, req.user);
  if (result.state === 'unknown') return sendError(res, 404, 'unknown_code', 'This pass is not in the system.', { state: 'unknown' });
  return res.json(result);
});

app.post('/api/scan/confirm', requireAuth(['office', 'admin']), (req, res) => {
  const code = parseScanCode(req.body);
  if (!code) return sendError(res, 400, 'invalid_code', 'That does not look like a pass code.');

  const result = resolveScan(code, req.user);
  const messages = {
    unknown: 'This pass is not in the system.',
    unissued: 'The guard house has not issued this pass yet.',
    void: 'This pass was cancelled.',
    completed: 'This visitor has already checked out.',
    already: 'Arrival was already confirmed for this visit.',
  };
  if (result.state !== 'ready') {
    return sendError(res, result.state === 'unknown' ? 404 : 409, result.state, messages[result.state], { result });
  }

  const visit = result.visit;
  if (!visit) return sendError(res, 409, 'no_visit', 'There is no active visit for this pass.');
  const at = now();

  db.exec('BEGIN');
  try {
    const claimed = db.prepare("UPDATE passes SET status = 'arrived' WHERE id = ? AND status = 'issued'").run(result.pass_id);
    if (claimed.changes !== 1) {
      db.exec('ROLLBACK');
      return sendError(res, 409, 'scan_conflict', 'This pass changed a moment ago. Scan it again.');
    }
    const officeName = req.user.office_name || db.prepare('SELECT name FROM offices WHERE id = ?').get(req.user.office_id)?.name || SITE_NAME;
    db.prepare(
      "UPDATE visits SET status = 'at_office', arrived_at = ?, arrived_by = ?, arrived_office_id = ? WHERE id = ? AND status = 'at_gate'",
    ).run(at, req.user.id, req.user.office_id ?? null, visit.id);
    addEvent({
      passId: result.pass_id,
      visitId: visit.id,
      type: 'arrived',
      note:
        result.warnings.length > 0
          ? `Arrival confirmed at ${officeName} (issued for ${visit.office_name})`
          : `Arrival confirmed at ${officeName}`,
      userId: req.user.id,
    });
    db.exec('COMMIT');
    broadcast('visit.updated', {
      kind: 'arrive',
      visit_id: visit.id,
      visitor_name: visit.visitor_name,
      office_name: officeName,
      at,
    });
    return res.json({ state: 'confirmed', visit: getVisit(visit.id), warnings: result.warnings, at });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
});

/* ------------------------------------------------------------------- admin */

app.get('/api/offices', requireAuth(['admin']), (req, res) => {
  const offices = db.prepare(
    `SELECT o.id, o.name, o.active, o.created_at,
       (SELECT COUNT(*) FROM contacts c WHERE c.office_id = o.id AND c.active = 1) AS contact_count
     FROM offices o ORDER BY o.name`,
  ).all();
  res.json({ offices });
});

app.post('/api/offices', requireAuth(['admin']), (req, res) => {
  const name = text((req.body ?? {}).name, 80);
  if (name.length < 2) return sendError(res, 400, 'invalid_name', 'Office name must be at least 2 characters.');
  const duplicate = db.prepare('SELECT id FROM offices WHERE name = ? COLLATE NOCASE').get(name);
  if (duplicate) return sendError(res, 409, 'duplicate', 'That office already exists.');
  const inserted = db.prepare('INSERT INTO offices (name, active, created_at) VALUES (?, 1, ?)').run(name, now());
  res.status(201).json({ office: db.prepare('SELECT * FROM offices WHERE id = ?').get(Number(inserted.lastInsertRowid)) });
});

app.patch('/api/offices/:id', requireAuth(['admin']), (req, res) => {
  const body = req.body ?? {};
  const office = db.prepare('SELECT * FROM offices WHERE id = ?').get(Number(req.params.id));
  if (!office) return sendError(res, 404, 'not_found', 'Office not found.');
  const name = body.name === undefined ? office.name : text(body.name, 80);
  if (name.length < 2) return sendError(res, 400, 'invalid_name', 'Office name must be at least 2 characters.');
  const active = body.active === undefined ? office.active : body.active ? 1 : 0;
  db.prepare('UPDATE offices SET name = ?, active = ? WHERE id = ?').run(name, active, office.id);
  res.json({ office: db.prepare('SELECT * FROM offices WHERE id = ?').get(office.id) });
});

app.get('/api/contacts', requireAuth(['admin']), (req, res) => {
  const contacts = db.prepare(
    `SELECT c.id, c.office_id, c.name, c.phone, c.active, o.name AS office_name
     FROM contacts c JOIN offices o ON o.id = c.office_id
     ORDER BY o.name, c.name`,
  ).all();
  res.json({ contacts });
});

app.post('/api/contacts', requireAuth(['admin']), (req, res) => {
  const body = req.body ?? {};
  const name = text(body.name, 80);
  const phone = text(body.phone, 32) || null;
  const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(Number(body.office_id));
  if (name.length < 2) return sendError(res, 400, 'invalid_name', 'Contact name must be at least 2 characters.');
  if (!office) return sendError(res, 400, 'invalid_office', 'Choose an office.');
  const inserted = db
    .prepare('INSERT INTO contacts (office_id, name, phone, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(office.id, name, phone, now());
  res.status(201).json({ contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(inserted.lastInsertRowid)) });
});

app.patch('/api/contacts/:id', requireAuth(['admin']), (req, res) => {
  const body = req.body ?? {};
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(req.params.id));
  if (!contact) return sendError(res, 404, 'not_found', 'Contact not found.');
  const name = body.name === undefined ? contact.name : text(body.name, 80);
  const phone = body.phone === undefined ? contact.phone : text(body.phone, 32) || null;
  const active = body.active === undefined ? contact.active : body.active ? 1 : 0;
  const officeId = body.office_id === undefined ? contact.office_id : Number(body.office_id);
  const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(officeId);
  if (!office) return sendError(res, 400, 'invalid_office', 'Choose a valid office.');
  if (name.length < 2) return sendError(res, 400, 'invalid_name', 'Contact name must be at least 2 characters.');
  db.prepare('UPDATE contacts SET office_id = ?, name = ?, phone = ?, active = ? WHERE id = ?').run(office.id, name, phone, active, contact.id);
  res.json({ contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) });
});

app.get('/api/users', requireAuth(['admin']), (req, res) => {
  const users = db.prepare(
    `SELECT u.id, u.username, u.role, u.full_name, u.office_id, o.name AS office_name, u.active,
            u.must_change_password, u.created_at
     FROM users u LEFT JOIN offices o ON o.id = u.office_id
     ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'guard' THEN 1 ELSE 2 END, u.username`,
  ).all();
  res.json({ users });
});

app.post('/api/users', requireAuth(['admin']), (req, res) => {
  const body = req.body ?? {};
  const username = text(body.username, 32).toLowerCase();
  const password = String(body.password ?? '');
  const role = text(body.role, 16);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return sendError(res, 400, 'invalid_username', 'Username: 3–32 characters, letters, numbers, dot, dash or underscore.');
  }
  if (password.length < 8) return sendError(res, 400, 'weak_password', 'Password must be at least 8 characters.');
  if (!['admin', 'guard', 'office'].includes(role)) return sendError(res, 400, 'invalid_role', 'Choose a valid role.');

  let officeId = null;
  if (role === 'office') {
    const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(Number(body.office_id));
    if (!office) return sendError(res, 400, 'invalid_office', 'Office accounts need an office.');
    officeId = office.id;
  }

  if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    return sendError(res, 409, 'duplicate', 'That username is taken.');
  }

  const inserted = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, full_name, office_id, active, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
    )
    .run(username, hashPassword(password), role, text(body.full_name, 80) || null, officeId, now());
  res.status(201).json({ user: db.prepare('SELECT id, username, role, full_name, office_id, active FROM users WHERE id = ?').get(Number(inserted.lastInsertRowid)) });
});

app.patch('/api/users/:id', requireAuth(['admin']), (req, res) => {
  const body = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return sendError(res, 404, 'not_found', 'Account not found.');

  const active = body.active === undefined ? user.active : body.active ? 1 : 0;
  if (user.id === req.user.id && active === 0) return sendError(res, 400, 'self_deactivate', 'You cannot deactivate your own account.');
  if (user.role === 'admin' && active === 0) {
    const remaining = db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(user.id).total;
    if (remaining === 0) return sendError(res, 400, 'last_admin', 'At least one active admin is required.');
  }

  let officeId = body.office_id === undefined ? user.office_id : Number(body.office_id) || null;
  if (user.role === 'office' && !officeId) return sendError(res, 400, 'invalid_office', 'Office accounts need an office.');
  if (officeId) {
    const office = db.prepare('SELECT id FROM offices WHERE id = ?').get(officeId);
    if (!office) return sendError(res, 400, 'invalid_office', 'Choose a valid office.');
    officeId = office.id;
  }

  let mustChange = user.must_change_password;
  if (body.password !== undefined) {
    const password = String(body.password);
    if (password.length < 8) return sendError(res, 400, 'weak_password', 'Password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), user.id);
    mustChange = 1;
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }

  db.prepare('UPDATE users SET full_name = ?, office_id = ?, active = ?, must_change_password = ? WHERE id = ?').run(
    body.full_name === undefined ? user.full_name : text(body.full_name, 80) || null,
    officeId,
    active,
    mustChange,
    user.id,
  );
  if (active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------ pass supply */

app.post('/api/batches', requireAuth(['admin']), (req, res) => {
  const body = req.body ?? {};
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return sendError(res, 400, 'invalid_count', 'Choose between 1 and 500 passes.');
  }
  const label = text(body.label, 60) || `Batch ${localDateLabel()} #${db.prepare('SELECT COUNT(*) AS total FROM batches').get().total + 1}`;
  const createdAt = now();

  db.exec('BEGIN');
  try {
    const batchId = Number(
      db.prepare('INSERT INTO batches (label, count, created_at, created_by) VALUES (?, ?, ?, ?)').run(label, count, createdAt, req.user.id)
        .lastInsertRowid,
    );
    const exists = db.prepare('SELECT 1 AS found FROM passes WHERE code = ?');
    const insertPass = db.prepare('INSERT INTO passes (code, batch_id, status, created_at) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < count; index += 1) {
      let code = newPassCode();
      let tries = 0;
      while (exists.get(code)) {
        code = newPassCode();
        tries += 1;
        if (tries > 20) throw new Error('Could not allocate a unique pass code');
      }
      insertPass.run(code, batchId, 'unused', createdAt);
    }
    db.exec('COMMIT');
    return res.status(201).json({ batch: getBatch(batchId) });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
});

app.get('/api/batches', requireAuth(['admin']), (req, res) => {
  res.json({ batches: db.prepare(`${BATCH_SELECT} ORDER BY b.id DESC`).all() });
});

app.get('/api/passes', requireAuth(['admin']), (req, res) => {
  const where = [];
  const params = [];
  const batchId = req.query.batch_id ? Number(req.query.batch_id) : null;
  if (batchId) {
    where.push('p.batch_id = ?');
    params.push(batchId);
  }
  const status = String(req.query.status || '');
  if (PASS_STATUSES.includes(status)) {
    where.push('p.status = ?');
    params.push(status);
  }
  const query = text(req.query.q, 40).toUpperCase();
  if (query) {
    where.push('p.code LIKE ?');
    params.push(`%${query}%`);
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const passes = db
    .prepare(
      `SELECT p.id, p.code, p.status, p.batch_id, p.created_at, b.label AS batch_label,
              v.id AS visit_id, v.visitor_name, v.status AS visit_status, v.gate_in_at, o.name AS office_name
       FROM passes p
       LEFT JOIN batches b ON b.id = p.batch_id
       LEFT JOIN visits v ON v.id = (SELECT MAX(id) FROM visits WHERE pass_id = p.id)
       LEFT JOIN offices o ON o.id = v.office_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.id DESC
       LIMIT ?`,
    )
    .all(...params, limit);
  res.json({ passes });
});

app.post('/api/passes/:id/void', requireAuth(['admin']), (req, res) => {
  const pass = db.prepare('SELECT * FROM passes WHERE id = ?').get(Number(req.params.id));
  if (!pass) return sendError(res, 404, 'not_found', 'Pass not found.');
  if (!['unused', 'issued'].includes(pass.status)) {
    return sendError(res, 409, 'not_voidable', `A pass that is ${pass.status} cannot be cancelled.`);
  }

  db.exec('BEGIN');
  try {
    const changed = db.prepare("UPDATE passes SET status = 'void' WHERE id = ? AND status IN ('unused','issued')").run(pass.id);
    if (changed.changes !== 1) {
      db.exec('ROLLBACK');
      return sendError(res, 409, 'conflict', 'That pass changed a moment ago.');
    }
    const visit = db.prepare("SELECT id FROM visits WHERE pass_id = ? AND status IN ('at_gate','at_office')").get(pass.id);
    if (visit) {
      db.prepare("UPDATE visits SET status = 'void', checkout_at = ?, checkout_by = ?, checkout_note = ? WHERE id = ?").run(
        now(),
        req.user.id,
        'Pass cancelled',
        visit.id,
      );
    }
    addEvent({ passId: pass.id, visitId: visit?.id, type: 'void', note: text((req.body ?? {}).reason, 120) || 'Pass cancelled', userId: req.user.id });
    db.exec('COMMIT');
    broadcast('visit.updated', { kind: 'void', visit_id: visit?.id ?? null, code: pass.code, at: now() });
    return res.json({ ok: true, pass: db.prepare('SELECT id, code, status FROM passes WHERE id = ?').get(pass.id) });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
});

app.get('/api/qr/:code', requireAuth(ROLES), async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'invalid_code' });
  if (!db.prepare('SELECT id FROM passes WHERE code = ?').get(code)) return res.status(404).json({ error: 'unknown_code' });
  const png = await QRCode.toBuffer(`${baseUrl(req)}/scan?code=${encodeURIComponent(code)}`, {
    type: 'png',
    width: 480,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b1120ff', light: '#ffffffff' },
  });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.end(png);
});

/* ---------------------------------------------------- visit history, reports */

const VISIT_STATUSES = ['at_gate', 'at_office', 'done', 'void'];
const VISIT_STATUS_LABEL = { at_gate: 'Awaiting arrival', at_office: 'At office', done: 'Completed', void: 'Cancelled' };

/** Returns "YYYY-MM-DD", "" when blank, or null when it is not a real calendar day. */
function parseDay(value) {
  const day = String(value ?? '').trim();
  if (!day) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date ? day : null;
}

/** ISO timestamp of local midnight on a day, optionally a number of days later. */
function localDayStartISO(day, addDays = 0) {
  const [year, month, date] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date + addDays));
  return new Date(utc.getTime() - tzOffsetMinutes(utc, TZ) * 60000).toISOString();
}

function visitFilters(query) {
  const from = parseDay(query.from);
  const to = parseDay(query.to);
  if (from === null || to === null) return { error: 'Dates must be real calendar days.' };
  if (from && to && from > to) return { error: 'The start date is after the end date.' };

  const where = [];
  const params = [];
  if (from) {
    where.push('v.gate_in_at >= ?');
    params.push(localDayStartISO(from));
  }
  if (to) {
    where.push('v.gate_in_at < ?');
    params.push(localDayStartISO(to, 1));
  }
  const officeId = Number(query.office_id);
  if (officeId) {
    where.push('v.office_id = ?');
    params.push(officeId);
  }
  const status = String(query.status || '');
  if (VISIT_STATUSES.includes(status)) {
    where.push('v.status = ?');
    params.push(status);
  }
  const search = text(query.q, 80);
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(`(v.visitor_name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\' OR v.purpose LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

app.get('/api/visits', requireAuth(['guard', 'admin']), (req, res) => {
  const filters = visitFilters(req.query);
  if (filters.error) return sendError(res, 400, 'invalid_filter', filters.error);
  const pageSize = Math.min(Math.max(Number(req.query.page_size) || 25, 1), 100);
  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total FROM visits v
       JOIN passes p ON p.id = v.pass_id
       LEFT JOIN contacts c ON c.id = v.contact_id
       ${filters.clause}`,
    )
    .get(...filters.params);
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const currentPage = Math.min(Math.max(Math.floor(Number(req.query.page)) || 1, 1), pages);
  const visits = db
    .prepare(`${VISIT_SELECT} ${filters.clause} ORDER BY v.gate_in_at DESC, v.id DESC LIMIT ? OFFSET ?`)
    .all(...filters.params, pageSize, (currentPage - 1) * pageSize);
  res.json({ visits, total, page: currentPage, pages });
});

const minutesBetween = (start, end) => (new Date(end).getTime() - new Date(start).getTime()) / 60000;
const average = (sum, count) => (count ? sum / count : null);

function newTally() {
  return { total: 0, confirmed: 0, unconfirmed: 0, inside: 0, cancelled: 0, waitSum: 0, stayCount: 0, staySum: 0 };
}

function addToTally(tally, visit) {
  tally.total += 1;
  if (visit.status === 'void') tally.cancelled += 1;
  if (visit.status === 'at_gate' || visit.status === 'at_office') tally.inside += 1;
  if (visit.status === 'done' && !visit.arrived_at) tally.unconfirmed += 1;
  if (visit.arrived_at) {
    tally.confirmed += 1;
    tally.waitSum += minutesBetween(visit.gate_in_at, visit.arrived_at);
  }
  if (visit.status === 'done' && visit.checkout_at) {
    tally.stayCount += 1;
    tally.staySum += minutesBetween(visit.gate_in_at, visit.checkout_at);
  }
}

function finishTally({ waitSum, stayCount, staySum, ...counts }) {
  return { ...counts, avg_wait_minutes: average(waitSum, counts.confirmed), avg_stay_minutes: average(staySum, stayCount) };
}

function localDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

app.get('/api/reports/summary', requireAuth(['admin']), (req, res) => {
  const filters = visitFilters(req.query);
  if (filters.error) return sendError(res, 400, 'invalid_filter', filters.error);
  const visits = db.prepare(`${VISIT_SELECT} ${filters.clause} ORDER BY v.gate_in_at`).all(...filters.params);

  const totals = newTally();
  const byOffice = new Map();
  const byDay = new Map();
  for (const visit of visits) {
    addToTally(totals, visit);
    if (!byOffice.has(visit.office_name)) byOffice.set(visit.office_name, newTally());
    addToTally(byOffice.get(visit.office_name), visit);
    const day = localDateTime(visit.gate_in_at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, newTally());
    addToTally(byDay.get(day), visit);
  }

  res.json({
    totals: finishTally(totals),
    by_office: [...byOffice].map(([name, tally]) => ({ name, ...finishTally(tally) })).sort((a, b) => b.total - a.total),
    by_day: [...byDay].map(([day, tally]) => ({ day, ...finishTally(tally) })),
  });
});

/** Quotes a CSV cell and stops spreadsheet apps from running visitor-entered text as a formula. */
function csvCell(value) {
  let cell = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

app.get('/api/visits.csv', requireAuth(['admin']), (req, res) => {
  const filters = visitFilters(req.query);
  if (filters.error) return sendError(res, 400, 'invalid_filter', filters.error);
  const visits = db.prepare(`${VISIT_SELECT} ${filters.clause} ORDER BY v.gate_in_at, v.id`).all(...filters.params);
  const header = ['Pass', 'Visitor', 'Office', 'Contact person', 'Purpose', 'Status', 'Gate in', 'Arrived', 'Confirmed by', 'Checked out', 'Note', 'Issued by'];
  const rows = visits.map((visit) => [
    visit.pass_code,
    visit.visitor_name,
    visit.office_name,
    visit.contact_name,
    visit.purpose,
    VISIT_STATUS_LABEL[visit.status],
    localDateTime(visit.gate_in_at),
    localDateTime(visit.arrived_at),
    visit.arrived_by_name || visit.arrived_by_username,
    localDateTime(visit.checkout_at),
    visit.checkout_note,
    visit.gate_in_by_name || visit.gate_in_by_username,
  ]);
  const range = [parseDay(req.query.from), parseDay(req.query.to)].filter(Boolean).join('_to_') || 'all';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="visits_${range}.csv"`);
  // The byte order mark makes Excel read names with accents or ñ correctly.
  res.send(`﻿${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`);
});

/* ------------------------------------------------- backups and notifications */

app.get('/api/backups', requireAuth(['admin']), (req, res) => {
  res.json(backupStatus());
});

app.post('/api/backups', requireAuth(['admin']), (req, res) => {
  const backup = createBackup('manual');
  addEvent({ type: 'backup', note: `Backup ${backup.name} created`, userId: req.user.id });
  res.status(201).json({ backup });
});

app.get('/api/backups/:name', requireAuth(['admin']), (req, res) => {
  const file = backupPath(req.params.name);
  if (!file) return sendError(res, 404, 'not_found', 'Backup not found.');
  addEvent({ type: 'backup_download', note: `Backup ${req.params.name} downloaded`, userId: req.user.id });
  return res.download(file);
});

app.get('/api/notifications', requireAuth(['admin']), (req, res) => {
  res.json({ configured: smsConfigured(), notifications: recentNotifications() });
});

app.post('/api/notifications/test', requireAuth(['admin']), async (req, res) => {
  if (!smsConfigured()) return sendError(res, 409, 'not_configured', 'No SMS gateway is set up yet.');
  const phone = text((req.body ?? {}).phone, 32);
  if (phone.length < 7) return sendError(res, 400, 'invalid_phone', 'Enter a phone number to test with.');
  const result = await sendSms({ recipient: 'Test message', phone, message: `${SITE_NAME}: test message from the visitor system.` });
  if (!result.ok) return sendError(res, 502, 'send_failed', `The gateway did not accept it: ${result.error}`);
  return res.json({ ok: true });
});

/* ------------------------------------------------------------------- print */

app.get('/print/:batchId', page(['admin']), (req, res) => {
  const batch = getBatch(Number(req.params.batchId));
  if (!batch) return res.status(404).send(errorPage('Print batch not found'));
  const passes = db.prepare('SELECT code FROM passes WHERE batch_id = ? ORDER BY id').all(batch.id);
  const tickets = passes
    .map(
      (pass) => `
      <div class="ticket">
        <div class="t-head"><span class="t-site">${esc(SITE_NAME)}</span><span class="t-kind">Visitor pass</span></div>
        <img class="t-qr" src="/api/qr/${encodeURIComponent(pass.code)}" alt="${esc(pass.code)}" loading="lazy" />
        <div class="t-code">${esc(pass.code)}</div>
        <div class="t-note">Present this pass at the gate. Scan it at the office you are visiting.</div>
      </div>`,
    )
    .join('');

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(SITE_NAME)} · print ${esc(batch.label)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif; color: #0b1120; background: #f1f5f9; }
  .bar { display: flex; gap: 12px; align-items: center; padding: 12px 18px; background: #0b1120; color: #e6edf7; position: sticky; top: 0; z-index: 2; }
  .bar h1 { font-size: 15px; margin: 0; font-weight: 650; }
  .bar .meta { color: #8fa3bf; font-size: 13px; }
  .bar .spacer { flex: 1; }
  .bar a, .bar button { font: inherit; font-size: 13px; border-radius: 8px; border: 1px solid #33425c; background: #1c2942; color: #e6edf7; padding: 7px 12px; text-decoration: none; cursor: pointer; }
  .bar button.primary { background: #3ddc97; color: #06251a; border-color: #3ddc97; font-weight: 650; }
  .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; padding: 8mm; background: #fff; max-width: 210mm; margin: 0 auto; }
  .ticket { border: 1px dashed #94a3b8; border-radius: 3mm; padding: 3.5mm; height: 62mm; display: flex; flex-direction: column; align-items: center; justify-content: space-between; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .t-head { display: flex; justify-content: space-between; width: 100%; font-size: 2.6mm; letter-spacing: .06em; text-transform: uppercase; color: #475569; }
  .t-site { font-weight: 700; color: #0b1120; }
  .t-qr { width: 33mm; height: 33mm; }
  .t-code { font-family: ui-monospace, Consolas, monospace; font-size: 4.2mm; font-weight: 700; letter-spacing: .04em; }
  .t-note { font-size: 2.5mm; line-height: 1.35; color: #64748b; }
  .empty { padding: 40px; text-align: center; color: #475569; }
  @media print {
    body { background: #fff; }
    .bar { display: none; }
    .sheet { padding: 0; max-width: none; gap: 5mm; }
  }
</style>
</head>
<body>
<div class="bar">
  <h1>${esc(batch.label)}</h1>
  <span class="meta">${passes.length} passes</span>
  <span class="spacer"></span>
  <a href="/admin#supply">Back to admin</a>
  <button class="primary" onclick="window.print()">Print sheet</button>
</div>
${passes.length ? `<div class="sheet">${tickets}</div>` : '<p class="empty">This batch has no passes.</p>'}
</body>
</html>`);
});

/* ------------------------------------------------------------------ errors */

function errorPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(SITE_NAME)}</title><link rel="stylesheet" href="/app.css"></head>
  <body class="app"><main class="wrap"><section class="panel"><h1>${esc(message)}</h1>
  <p class="muted">Return to <a href="/">the dashboard</a>.</p></section></main></body></html>`;
}

app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.toLowerCase().endsWith('.html')) return res.status(404).send(errorPage('Page not found'));
  return next();
});

app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'ignore', maxAge: 0 }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found', message: 'Unknown endpoint.' });
  return res.status(404).send(errorPage('Page not found'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Client errors raised by middleware, such as malformed JSON or an oversized body.
  if (err.status >= 400 && err.status < 500 && !res.headersSent) {
    if (req.path.startsWith('/api/')) return sendError(res, err.status, 'bad_request', 'The request could not be read.');
    return res.status(err.status).send(errorPage('Bad request'));
  }
  console.error('[error]', req.method, req.path, err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
  return res.status(500).send(errorPage('Something went wrong'));
});

const server = app.listen(PORT, () => {
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : PORT;
  console.log('');
  console.log(`  ${SITE_NAME} - QR monitoring`);
  console.log(`  http://localhost:${listeningPort}`);
  console.log(`  database: ${DB_PATH}`);
  console.log(`  timezone: ${TZ}`);
  if (process.env.SEED_DEMO === '1') console.log('  demo data loaded (guard1/guard123, registrar1/office123, cashier1/office123)');
  console.log('');
  startBackupSchedule();
});
