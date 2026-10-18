const crypto = require('crypto');

function encryptionKey() {
  const source = process.env.TOTP_ENCRYPTION_KEY || process.env.PASSWORD_PEPPER;
  if (!source) throw new Error('TOTP_ENCRYPTION_KEY or PASSWORD_PEPPER must be configured');
  return crypto.createHash('sha256').update(source).digest();
}

function encryptTotpSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptTotpSecret(value) {
  if (!value.startsWith('enc:v1:')) throw new Error('Unsupported TOTP secret format');
  const [, , iv, tag, ciphertext] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { encryptTotpSecret, decryptTotpSecret };
