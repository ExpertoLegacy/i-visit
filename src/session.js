import crypto from 'node:crypto';
import { db, now } from './db.js';

const COOKIE_NAME = 'gh_sid';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function parseCookies(header = '') {
  const jar = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      jar[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[key] = part.slice(index + 1).trim();
    }
  }
  return jar;
}

function isSecure(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return req.secure || forwarded === 'https';
}

function cookieFlags(req) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isSecure(req)) flags.push('Secure');
  return flags.join('; ');
}

export function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieFlags(req)}; Max-Age=${Math.floor(SESSION_MS / 1000)}`);
}

export function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags(req)}; Max-Age=0`);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, now(), expiresAt);
  return token;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function attachUser(req, res, next) {
  req.user = null;
  req.sessionToken = null;
  try {
    const token = parseCookies(req.headers.cookie).gh_sid;
    if (!token) return next();
    const row = db
      .prepare(
        `SELECT s.token, s.expires_at, u.id, u.username, u.role, u.full_name, u.office_id, u.active, u.must_change_password,
                o.name AS office_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN offices o ON o.id = u.office_id
         WHERE s.token = ?`,
      )
      .get(token);
    if (!row) return next();
    if (row.expires_at <= now()) {
      destroySession(token);
      return next();
    }
    if (!row.active) return next();
    req.sessionToken = row.token;
    req.user = {
      id: row.id,
      username: row.username,
      role: row.role,
      full_name: row.full_name,
      office_id: row.office_id,
      office_name: row.office_name,
      must_change_password: Boolean(row.must_change_password),
    };
  } catch (err) {
    console.error('[session] failed to resolve session:', err.message);
  }
  return next();
}

export function requireAuth(roles, { allowPasswordChange = false } = {}) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'auth_required', message: 'Please sign in again.' });
    if (req.user.must_change_password && !allowPasswordChange) {
      return res.status(403).json({ error: 'password_change_required', message: 'Change your password to continue.' });
    }
    if (roles && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'Your account cannot do that.' });
    }
    return next();
  };
}
