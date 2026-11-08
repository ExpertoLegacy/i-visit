import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { db, DB_PATH } from './db.js';

export const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups'));

const keepSetting = process.env.BACKUP_KEEP ? Number(process.env.BACKUP_KEEP) : 14;
/** How many daily and how many manual copies to retain. 0 turns off daily backups and pruning. */
export const BACKUP_KEEP = Number.isInteger(keepSetting) && keepSetting >= 0 ? keepSetting : 14;

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const NAME_PATTERN = /^guardhouse-\d{4}-\d{2}-\d{2}(-manual-\d{6})?\.db$/;
const isManual = (name) => name.includes('-manual-');

let lastError = null;

/** Local ["YYYY-MM-DD", "HH:MM:SS"] in the configured time zone. */
function localStamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: process.env.APP_TZ || 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .format(new Date())
    .split(' ');
}

function backupNames() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((name) => NAME_PATTERN.test(name));
}

function prune() {
  if (BACKUP_KEEP === 0) return;
  for (const manual of [true, false]) {
    const names = backupNames()
      .filter((name) => isManual(name) === manual)
      .sort()
      .reverse();
    for (const name of names.slice(BACKUP_KEEP)) fs.rmSync(path.join(BACKUP_DIR, name), { force: true });
  }
}

function describe(name) {
  const stat = fs.statSync(path.join(BACKUP_DIR, name));
  return { name, kind: isManual(name) ? 'manual' : 'daily', size: stat.size, created_at: stat.mtime.toISOString() };
}

/** Writes a consistent copy of the live database. Safe while the server is running. */
export function createBackup(kind = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const [day, time] = localStamp();
  const name = kind === 'manual' ? `guardhouse-${day}-manual-${time.replaceAll(':', '')}.db` : `guardhouse-${day}.db`;
  const target = path.join(BACKUP_DIR, name);
  const temp = `${target}.tmp`;
  fs.rmSync(temp, { force: true });
  db.prepare('VACUUM INTO ?').run(temp);

  // A copy must not carry working sign-ins; restoring one simply asks everyone to sign in again.
  const copy = new DatabaseSync(temp);
  try {
    copy.exec('DELETE FROM sessions; VACUUM');
  } finally {
    copy.close();
  }

  fs.renameSync(temp, target);
  prune();
  return describe(name);
}

function runDailyBackup() {
  const [day] = localStamp();
  try {
    if (!fs.existsSync(path.join(BACKUP_DIR, `guardhouse-${day}.db`))) {
      createBackup('daily');
      console.log(`[backup] daily copy saved to ${BACKUP_DIR}`);
    }
    lastError = null;
  } catch (err) {
    lastError = { at: new Date().toISOString(), message: err.message };
    console.error('[backup] daily backup failed:', err.message);
  }
}

/** Takes one copy per day while the server is up, so a PC switched off at night still gets backed up. */
export function startBackupSchedule() {
  if (BACKUP_KEEP === 0) return;
  runDailyBackup();
  setInterval(runDailyBackup, CHECK_INTERVAL_MS).unref();
}

export function backupStatus() {
  return {
    directory: BACKUP_DIR,
    keep: BACKUP_KEEP,
    last_error: lastError,
    backups: backupNames()
      .map(describe)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
  };
}

/** Absolute path of a backup, or null if the name is not an existing backup file. */
export function backupPath(name) {
  if (!NAME_PATTERN.test(String(name))) return null;
  const file = path.join(BACKUP_DIR, name);
  return fs.existsSync(file) ? file : null;
}
