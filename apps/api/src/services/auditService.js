// apps/api/src/services/auditService.js
/** Simple audit logging service */
const { pool } = require('../config/db');

async function logEvent({ actorUserId = null, targetUserId = null, eventType, metadata = {}, outcome = 'success' }) {
  const query = `
    INSERT INTO audit_logs (actor_user_id, target_user_id, event_type, metadata, outcome)
    VALUES ($1, $2, $3, $4, $5)
  `;
  const values = [actorUserId, targetUserId, eventType, JSON.stringify(metadata), outcome];
  await pool.query(query, values);
}

module.exports = { logEvent };
