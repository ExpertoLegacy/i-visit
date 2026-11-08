import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './passwords.js';

export const DB_PATH = path.resolve(process.env.DB_PATH || path.join('data', 'app.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

export const now = () => new Date().toISOString();

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function newPassCode() {
  let body = '';
  for (let i = 0; i < 8; i += 1) body += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `GH-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Accepts "GH-7K2M-9QX4", "gh 7k2m 9qx4" or "7K2M9QX4" and returns the canonical code. */
export function normalizeCode(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('GH') ? raw.slice(2) : raw;
  if (body.length !== 8) return null;
  return `GH-${body.slice(0, 4)}-${body.slice(4)}`;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS offices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','guard','office')),
    full_name TEXT,
    office_id INTEGER REFERENCES offices(id),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    batch_id INTEGER REFERENCES batches(id),
    status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','issued','arrived','done','void')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_id INTEGER NOT NULL REFERENCES passes(id),
    visitor_name TEXT NOT NULL,
    office_id INTEGER NOT NULL REFERENCES offices(id),
    contact_id INTEGER REFERENCES contacts(id),
    purpose TEXT,
    status TEXT NOT NULL CHECK (status IN ('at_gate','at_office','done','void')),
    gate_in_at TEXT NOT NULL,
    gate_in_by INTEGER REFERENCES users(id),
    arrived_at TEXT,
    arrived_by INTEGER REFERENCES users(id),
    arrived_office_id INTEGER REFERENCES offices(id),
    checkout_at TEXT,
    checkout_by INTEGER REFERENCES users(id),
    checkout_note TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_id INTEGER REFERENCES passes(id),
    visit_id INTEGER REFERENCES visits(id),
    type TEXT NOT NULL,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER REFERENCES visits(id),
    recipient TEXT,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
  CREATE INDEX IF NOT EXISTS idx_visits_gate_in ON visits(gate_in_at);
  CREATE INDEX IF NOT EXISTS idx_events_visit ON events(visit_id);
  CREATE INDEX IF NOT EXISTS idx_passes_batch ON passes(batch_id);
  CREATE INDEX IF NOT EXISTS idx_passes_status ON passes(status);
`);

export function addEvent({ passId, visitId, type, note, userId }) {
  db.prepare('INSERT INTO events (pass_id, visit_id, type, note, user_id, at) VALUES (?, ?, ?, ?, ?, ?)').run(
    passId ?? null,
    visitId ?? null,
    type,
    note ?? null,
    userId ?? null,
    now(),
  );
}

const DEFAULT_OFFICES = ['Registrar', "Principal's Office", 'Cashier', 'Guidance Office', 'Supply Office'];

function seed() {
  const officeCount = db.prepare('SELECT COUNT(*) AS total FROM offices').get().total;
  if (officeCount === 0) {
    const insert = db.prepare('INSERT INTO offices (name, active, created_at) VALUES (?, 1, ?)');
    for (const name of DEFAULT_OFFICES) insert.run(name, now());
    console.log(`[seed] added ${DEFAULT_OFFICES.length} sample offices (edit them in Admin)`);
  }

  const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare(
      `INSERT INTO users (username, password_hash, role, full_name, active, must_change_password, created_at)
       VALUES (?, ?, 'admin', 'System Administrator', 1, 1, ?)`,
    ).run('admin', hashPassword(password), now());
    console.log('[seed] admin account created');
    console.log(`[seed]   username: admin`);
    console.log(`[seed]   password: ${password}${process.env.ADMIN_PASSWORD ? '' : '  (change it in Admin > Change password)'}`);
  }

  if (process.env.SEED_DEMO === '1') seedDemo();
}

function seedDemo() {
  const addUser = (username, password, role, fullName, officeName) => {
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return;
    const office = officeName ? db.prepare('SELECT id FROM offices WHERE name = ?').get(officeName) : null;
    db.prepare(
      `INSERT INTO users (username, password_hash, role, full_name, office_id, active, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
    ).run(username, hashPassword(password), role, fullName, office?.id ?? null, now());
    console.log(`[seed] demo ${role} account: ${username} / ${password}`);
  };

  addUser('guard1', 'guard123', 'guard', 'Guard on duty', null);
  addUser('registrar1', 'office123', 'office', 'Registrar staff', 'Registrar');
  addUser('cashier1', 'office123', 'office', 'Cashier staff', 'Cashier');

  const contactCount = db.prepare('SELECT COUNT(*) AS total FROM contacts').get().total;
  if (contactCount === 0) {
    const registrar = db.prepare('SELECT id FROM offices WHERE name = ?').get('Registrar');
    const cashier = db.prepare('SELECT id FROM offices WHERE name = ?').get('Cashier');
    const insert = db.prepare('INSERT INTO contacts (office_id, name, phone, active, created_at) VALUES (?, ?, ?, 1, ?)');
    if (registrar) insert.run(registrar.id, 'Ms. Cruz', '0917 000 0001', now());
    if (cashier) insert.run(cashier.id, 'Mr. Santos', '0917 000 0002', now());
  }

  const batchCount = db.prepare('SELECT COUNT(*) AS total FROM batches').get().total;
  if (batchCount === 0) {
    const createdAt = now();
    const batchId = Number(
      db.prepare('INSERT INTO batches (label, count, created_at) VALUES (?, ?, ?)').run('Demo sheet', 24, createdAt).lastInsertRowid,
    );
    const insertPass = db.prepare('INSERT INTO passes (code, batch_id, status, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 24; i += 1) insertPass.run(newPassCode(), batchId, 'unused', createdAt);
    console.log('[seed] demo print batch with 24 unused passes');
  }
}

seed();
