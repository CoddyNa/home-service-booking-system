// apps/api/src/controllers/authController.js
const { pool } = require('../config/db');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { hashPassword, verifyPassword } = require('../utils/password');
const userService = require('../services/userService');
const auditService = require('../services/auditService');
const { encryptTotpSecret, decryptTotpSecret } = require('../utils/totpSecret');
const emailService = require('../services/emailService');

function emailValue(email) { return String(email || '').trim().toLowerCase(); }
function validCode(code) { return /^\d{6}$/.test(String(code || '')); }
function safeAudit(event) { return auditService.logEvent(event).catch((error) => console.error('Audit logging failed:', error.message)); }
function publicUser(user, role = user.role_name || 'user') {
  return { id: user.id, username: user.username, email: user.email, role, totp_enabled: Boolean(user.totp_enabled) };
}

/** Helper middleware to ensure a user is authenticated via session */
function ensureAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

/** Registration */
async function register(req, res, next) {
  try {
    const { username, password } = req.body;
    const email = emailValue(req.body.email);
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Enter a username.' });
    }
    if (username.trim().length > 80) {
      return res.status(400).json({ error: 'Username must be 80 characters or fewer.' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Enter an email address.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (email.length > 254) {
      return res.status(400).json({ error: 'Email must be 254 characters or fewer.' });
    }
    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters.' });
    }
    if (password.length > 1024) {
      return res.status(400).json({ error: 'Password is too long.' });
    }
    // Check duplicate email
    const existing = await userService.findByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    const passwordCredential = await hashPassword(password);
    const user = await userService.createUser({ username: String(username).trim(), email, password_hash: passwordCredential.hash, password_salt: passwordCredential.salt });
    await safeAudit({ targetUserId: user.id, eventType: 'auth.register', metadata: {}, outcome: 'success' });
    res.status(201).json({ message: 'User created', userId: user.id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    next(err);
  }
}

/** Login */
async function login(req, res, next) {
  try {
    const { password } = req.body;
    const email = emailValue(req.body.email);
    if (!email || typeof password !== 'string' || password.length > 1024) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const user = await userService.findByEmail(email);
    // Generic failure message to avoid user enumeration
    const genericFail = () => res.status(401).json({ error: 'Invalid credentials' });
    if (!user) return genericFail();
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return genericFail();
    if (user.is_active === false) return genericFail();
    if (user.totp_enabled) {
      req.session.pending2faUserId = user.id;
      return res.json({ message: 'Two-factor verification required', requires2FA: true });
    }
    // Session creation
    await establishSession(req, user);
    await safeAudit({ actorUserId: user.id, targetUserId: user.id, eventType: 'auth.login', outcome: 'success' });
    res.json({ message: 'Logged in', csrfToken: req.session.csrfToken, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

function establishSession(req, user) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => {
    if (err) return reject(err);
    req.session.userId = user.id;
    req.session.role = user.role_name || 'user';
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
    resolve();
  }));
}

/** Logout */
function logout(req, res, next) {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('sid', { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.json({ message: 'Logged out' });
  });
}

async function requestPasswordReset(req, res, next) {
  try {
    const email = emailValue(req.body.email);
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await userService.findByEmail(email);
    let token;
    if (user) {
      token = crypto.randomBytes(32).toString('base64url');
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
      await pool.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [user.id, crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 30 * 60 * 1000)]);
      const sent = await emailService.sendPasswordReset(email, token);
      if (process.env.NODE_ENV === 'production' && !sent) {
        await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
        return res.status(503).json({ error: 'Password reset email is temporarily unavailable' });
      }
      await safeAudit({ targetUserId: user.id, eventType: 'auth.password_reset_requested', outcome: 'success' });
    }
    const response = { message: 'If the account exists, reset instructions will be sent.' };
    if (process.env.NODE_ENV !== 'production' && token) response.resetToken = token;
    res.json(response);
  } catch (err) { next(err); }
}

async function confirmPasswordReset(req, res, next) {
  try {
    const { token, password } = req.body;
    if (typeof token !== 'string' || token.length < 32 || typeof password !== 'string' || password.length < 12) return res.status(400).json({ error: 'A valid token and password of at least 12 characters are required' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const found = await pool.query('SELECT id, user_id FROM password_reset_tokens WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW() LIMIT 1', [tokenHash]);
    if (!found.rows[0]) return res.status(400).json({ error: 'Invalid or expired reset token' });
    const passwordCredential = await hashPassword(password);
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query('UPDATE users SET password_hash = $1, password_salt = $2, updated_at = NOW() WHERE id = $3', [passwordCredential.hash, passwordCredential.salt, found.rows[0].user_id]);
      await client.query('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1', [found.rows[0].user_id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [found.rows[0].user_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await safeAudit({ targetUserId: found.rows[0].user_id, eventType: 'auth.password_reset_completed', outcome: 'success' });
    res.json({ message: 'Password updated. Please log in again.' });
  } catch (err) { next(err); }
}

async function setup2FA(req, res, next) {
  try {
    const secret = authenticator.generateSecret();
    const uri = authenticator.keyuri(String(req.session.userId), 'Secure Auth', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 220 });
    await pool.query('INSERT INTO totp_credentials (user_id, secret, enabled) VALUES ($1, $2, FALSE) ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, enabled = FALSE', [req.session.userId, encryptTotpSecret(secret)]);
    res.json({ secret, otpauthUrl: uri, qrCodeDataUrl, message: 'Add this account to your authenticator app, then verify a code.' });
  } catch (err) { next(err); }
}
async function verify2FA(req, res, next) {
  try {
    if (!validCode(req.body.code)) return res.status(400).json({ error: 'Enter the six-digit authenticator code' });
    if (req.session.pending2faUserId) {
      const userId = req.session.pending2faUserId;
      const result = await pool.query('SELECT u.id, u.username, u.email, r.name AS role_name, t.secret, t.enabled AS totp_enabled FROM users u JOIN roles r ON r.id = u.role_id JOIN totp_credentials t ON t.user_id = u.id WHERE u.id = $1 AND u.is_active = TRUE AND t.enabled = TRUE', [userId]);
      const user = result.rows[0];
      if (!user || !authenticator.verify({ token: req.body.code, secret: decryptTotpSecret(user.secret) })) return res.status(401).json({ error: 'Invalid authenticator code' });
      delete req.session.pending2faUserId;
      await establishSession(req, user);
      await safeAudit({ actorUserId: user.id, targetUserId: user.id, eventType: 'auth.login', metadata: { twoFactor: true }, outcome: 'success' });
      return res.json({ message: 'Logged in', csrfToken: req.session.csrfToken, user: publicUser(user, user.role_name) });
    }
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT secret FROM totp_credentials WHERE user_id = $1', [req.session.userId]);
    if (!result.rows[0] || !authenticator.verify({ token: req.body.code, secret: decryptTotpSecret(result.rows[0].secret) })) return res.status(401).json({ error: 'Invalid authenticator code' });
    await pool.query('UPDATE totp_credentials SET enabled = TRUE WHERE user_id = $1', [req.session.userId]);
    await safeAudit({ actorUserId: req.session.userId, targetUserId: req.session.userId, eventType: 'auth.2fa_enabled', outcome: 'success' });
    res.json({ message: 'Two-factor authentication enabled' });
  } catch (err) { next(err); }
}

async function listUsers(req, res, next) {
  try {
    const result = await pool.query('SELECT u.id, u.username, u.email, r.name AS role, u.is_active, u.created_at, u.password_hash, u.password_salt FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.created_at DESC LIMIT 500');
    res.json({ users: result.rows });
  } catch (err) { next(err); }
}

async function currentUser(req, res, next) {
  try {
    const result = await pool.query('SELECT u.id, u.username, u.email, r.name AS role, u.is_active, COALESCE(t.enabled, FALSE) AS totp_enabled FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN totp_credentials t ON t.user_id = u.id WHERE u.id = $1', [req.session.userId]);
    if (!result.rows[0] || !result.rows[0].is_active) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
}

async function deleteUser(req, res, next) {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isSafeInteger(targetId)) return res.status(400).json({ error: 'Invalid user id' });
    if (targetId === Number(req.session.userId)) return res.status(400).json({ error: 'You cannot deactivate your own account' });
    const result = await pool.query('UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND is_active = TRUE RETURNING id, email, username', [targetId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Active user not found' });
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
    await safeAudit({ actorUserId: req.session.userId, targetUserId: targetId, eventType: 'admin.user_deactivated', metadata: { email: result.rows[0].email, username: result.rows[0].username }, outcome: 'success' });
    res.json({ message: 'User deactivated. The account and audit history are retained.' });
  } catch (err) { next(err); }
}

async function updateUserRole(req, res, next) {
  try {
    const role = String(req.body.role || '').toLowerCase();
    if (!['customer', 'provider', 'support_agent', 'staff', 'auditor', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role === 'provider') {
      const approved = await pool.query("SELECT user_id FROM provider_profiles WHERE user_id=$1 AND approval_status='approved'", [req.params.id]);
      if (!approved.rows[0]) return res.status(400).json({ error: 'Approve a provider application before assigning the provider role.' });
    }
    if (Number(req.params.id) === Number(req.session.userId) && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role' });
    const result = await pool.query('UPDATE users SET role_id = (SELECT id FROM roles WHERE name = $1), updated_at = NOW() WHERE id = $2 RETURNING id', [role, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
    await safeAudit({ actorUserId: req.session.userId, targetUserId: Number(req.params.id), eventType: 'admin.role_updated', metadata: { role }, outcome: 'success' });
    res.json({ message: 'Role updated' });
  } catch (err) { next(err); }
}

async function listAuditLogs(req, res, next) {
  try {
    const result = await pool.query('SELECT id, actor_user_id, target_user_id, event_type, metadata, outcome, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 500');
    res.json({ events: result.rows });
  } catch (err) { next(err); }
}

module.exports = {
  register,
  login,
  logout,
  requestPasswordReset,
  confirmPasswordReset,
  setup2FA,
  verify2FA,
  listUsers,
  currentUser,
  deleteUser,
  updateUserRole,
  listAuditLogs,
  ensureAuthenticated,
};
