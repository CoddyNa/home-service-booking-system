const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const marketplaceRoutes = require('./routes/marketplace');
const { requireRoles } = require('./middleware/role');
const backupService = require('./services/backupService');
const PgSessionStore = require('./services/pgSessionStore');

const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://unpkg.com'],
      'img-src': ["'self'", 'data:'],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json({ limit: '16kb' }));

const session = require('express-session');

// Session configuration – secret loaded from env, secure cookies in production
app.use(session({
  name: 'sid',
  secret: process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? undefined : 'local-development-session-secret-change-me'),
  resave: false,
  saveUninitialized: false,
  store: process.env.NODE_ENV === 'test' ? undefined : new PgSessionStore(),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  },
}));

// CORS – allow frontend origin (configured via env)
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// Rate limiting – basic example (adjust as needed)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' }),
});
app.use('/api/', apiLimiter);

app.get('/api/csrf-token', (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  res.json({ csrfToken: req.session.csrfToken });
});
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session && req.session.csrfToken;
  const provided = req.get('X-CSRF-Token');
  if (typeof expected !== 'string' || typeof provided !== 'string') return res.status(403).json({ error: 'Invalid CSRF token' });
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) return res.status(403).json({ error: 'Invalid CSRF token' });
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.get('/api/admin/backups', require('./middleware/auth').ensureAuthenticated, requireRoles('admin'), async (req, res, next) => {
  try {
    const recoveryConfigured = backupService.hasRecoveryDatabaseConfig();
    res.json({ backups: await backupService.listBackups(), operations: await backupService.listOperations(), recoveryConfigured, filesBackupAvailable: false });
  } catch (error) { next(error); }
});
app.post('/api/admin/backups', require('./middleware/auth').ensureAuthenticated, requireRoles('admin'), async (req, res, next) => {
  try {
    const backup = await backupService.createBackup(req.session.userId);
    res.status(202).json({ backup });
  } catch (error) { next(error); }
});
app.get('/api/admin/backups/operations/:id', require('./middleware/auth').ensureAuthenticated, requireRoles('admin'), async (req, res, next) => {
  try { res.json({ operation: await backupService.getOperation(req.params.id) }); } catch (error) { next(error); }
});
app.post('/api/admin/backups/cleanup', require('./middleware/auth').ensureAuthenticated, requireRoles('admin'), async (req, res, next) => {
  try {
    const result = await backupService.cleanupExpired();
    await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_retention_cleanup', metadata: result, outcome: 'success' });
    res.json(result);
  } catch (error) {
    await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_retention_cleanup', metadata: { reason: backupService.safeError(error) }, outcome: 'failure' }).catch(() => {});
    next(error);
  }
});
app.post('/api/admin/backups/:id/preview', require('./middleware/auth').ensureAuthenticated, requireRoles('admin'), async (req, res, next) => {
  try { res.json({ preview: await backupService.previewBackup(req.params.id) }); } catch (error) {
    await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_preview_failed', metadata: { backupId: req.params.id, reason: backupService.safeError(error) }, outcome: 'failure' }).catch(() => {});
    next(error);
  }
});
app.post('/api/admin/backups/:id/verify', require('./middleware/auth').ensureAuthenticated, requireRoles('admin'), async (req, res, next) => {
  try {
    const result = await backupService.verifyBackup(req.params.id, req.session.userId);
    await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_verification_started', metadata: { backupId: result.backupId, operationId: result.operationId }, outcome: 'success' }).catch(() => {});
    res.status(202).json({ verification: result });
  } catch (error) {
    await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_verification_failed', metadata: { backupId: req.params.id, reason: backupService.safeError(error) }, outcome: 'failure' }).catch(() => {});
    next(error);
  }
});
app.post('/api/admin/backups/:id/restore', require('./middleware/auth').ensureAuthenticated, requireRoles('admin'), async (req, res, next) => {
  try {
    if (req.body.confirmation !== `RESTORE ${req.params.id}`) {
      await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_restore_failed', metadata: { backupId: req.params.id, reason: 'Confirmation did not match' }, outcome: 'failure' });
      return res.status(400).json({ error: 'Restore confirmation does not match' });
    }
    const result = await backupService.restoreToRecovery(req.params.id, req.session.userId);
    await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_restore_started', metadata: { backupId: result.backupId, operationId: result.operationId }, outcome: 'success' }).catch(() => {});
    res.status(202).json({ operationId: result.operationId, status: result.status, message: 'Restore started for the separate recovery database. The active application database will not be changed.' });
  } catch (error) {
    await require('./services/auditService').logEvent({ actorUserId: req.session.userId, eventType: 'admin.backup_restore_failed', metadata: { backupId: req.params.id, reason: backupService.safeError(error) }, outcome: 'failure' }).catch(() => {});
    next(error);
  }
});

// Simple health‑check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling (avoid leaking stack traces)
app.use((err, req, res, next) => {
  console.error('API request failed:', backupService.safeError(err));
  const status = err.status || 500;
  const message = err.expose || err.status === 403 ? err.message : 'Internal Server Error';
  res.status(status).json({ error: message });
});

module.exports = app;
