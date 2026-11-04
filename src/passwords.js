import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;
const PREFIX = 'scrypt';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== PREFIX || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length === 0) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r: R, p: P, maxmem: MAX_MEM });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
