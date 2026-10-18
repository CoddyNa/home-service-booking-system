// apps/api/src/middleware/auth.js
/** Middleware to ensure the request is from an authenticated user */
function ensureAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { ensureAuthenticated };
