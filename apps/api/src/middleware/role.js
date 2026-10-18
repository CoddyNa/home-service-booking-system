// apps/api/src/middleware/role.js
const auditService = require('../services/auditService');

/** Middleware to enforce required role(s) for a route */
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session || !req.session.role) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userRole = req.session.role;
    if (allowedRoles.includes(userRole)) {
      return next();
    }
    auditService.logEvent({ actorUserId: req.session.userId, eventType: 'rbac.access_denied', metadata: { path: req.originalUrl, roles: allowedRoles }, outcome: 'denied' }).catch(() => {});
    return res.status(403).json({ error: 'Forbidden: insufficient role' });
  };
}

module.exports = { requireRoles };
