// apps/api/src/utils/password.js
const crypto = require('crypto');
const argon2 = require('argon2');
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

// Load pepper once (do not expose it)
const PEPPER = process.env.PASSWORD_PEPPER || '';
if (!PEPPER) {
  if (process.env.NODE_ENV === 'production') throw new Error('PASSWORD_PEPPER must be configured in production');
  console.warn('WARNING: PASSWORD_PEPPER is not set. Password hashing will be insecure.');
}
if (process.env.NODE_ENV === 'production' && PEPPER.length < 32) throw new Error('PASSWORD_PEPPER must contain at least 32 characters');

/**
 * Pre‑hash the raw password with HMAC‑SHA‑256 using the server‑side pepper.
 * Returns a Buffer (32 bytes) which will be fed to Argon2.
 */
function prehash(password) {
  return crypto.createHmac('sha256', PEPPER).update(password).digest();
}

/**
 * Hash a raw password using the pepper + Argon2id.
 * Returns the encoded Argon2 hash string (includes salt and parameters).
 */
async function hashPassword(rawPassword) {
  const pre = prehash(rawPassword);
  const salt = crypto.randomBytes(16);
  // Argon2 recommended parameters (tuned for modern servers)
  const hash = await argon2.hash(pre, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16, // 64 MB
    timeCost: 3,
    hashLength: 32,
    parallelism: 1,
    salt,
  });
  return { hash, salt: salt.toString('base64') };
}

/**
 * Verify a raw password against a stored Argon2 hash.
 */
async function verifyPassword(rawPassword, storedHash) {
  const pre = prehash(rawPassword);
  try {
    return await argon2.verify(storedHash, pre, { type: argon2.argon2id });
  } catch (e) {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
};
