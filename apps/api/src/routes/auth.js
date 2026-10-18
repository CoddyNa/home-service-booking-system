// apps/api/src/routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { ensureAuthenticated } = require('../middleware/auth');
const { requireRoles } = require('../middleware/role');
const rateLimit = require('express-rate-limit');
const jsonRateLimit = (_req, res) => res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, handler: jsonRateLimit });
const verificationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, handler: jsonRateLimit });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, handler: jsonRateLimit });

// Registration
router.post('/register', authController.register);

// Login
router.post('/login', loginLimiter, authController.login);

// Logout
router.post('/logout', authController.logout);
router.get('/me', ensureAuthenticated, authController.currentUser);

// 2FA setup (requires authenticated user)
router.post('/2fa/setup', authController.ensureAuthenticated, authController.setup2FA);
router.post('/2fa/verify', verificationLimiter, authController.verify2FA);

// Password reset request
router.post('/password-reset/request', resetLimiter, authController.requestPasswordReset);
// Password reset execution (token + new password)
router.post('/password-reset/confirm', resetLimiter, authController.confirmPasswordReset);

// Administrative access: user management is admin-only; audit history is available to auditors and admins.
router.get('/admin/users', ensureAuthenticated, requireRoles('admin'), authController.listUsers);
router.patch('/admin/users/:id/role', ensureAuthenticated, requireRoles('admin'), authController.updateUserRole);
router.delete('/admin/users/:id', ensureAuthenticated, requireRoles('admin'), authController.deleteUser);
router.get('/admin/audit-logs', ensureAuthenticated, requireRoles('admin', 'auditor'), authController.listAuditLogs);

module.exports = router;
