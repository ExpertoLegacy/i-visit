// Recovers a locked-out account from the server's own terminal.
// Usage: npm run reset-password            (resets "admin")
//        npm run reset-password -- guard1
import '../src/env.js';
import crypto from 'node:crypto';
import process from 'node:process';
import { db, addEvent } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';

const username = process.argv[2] || 'admin';
const user = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(username);

if (!user) {
  const known = db.prepare('SELECT username FROM users ORDER BY username').all().map((row) => row.username);
  console.error(`No account named "${username}". Accounts: ${known.join(', ')}`);
  process.exit(1);
}

const password = crypto.randomBytes(9).toString('base64url');
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, active = 1 WHERE id = ?').run(hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
addEvent({ type: 'password_reset', note: `${user.username} reset from the server terminal` });

console.log(`Account: ${user.username}`);
console.log(`Temporary password: ${password}`);
console.log('It must be changed at the next sign-in.');
