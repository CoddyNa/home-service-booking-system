// apps/api/src/services/userService.js
const { pool } = require('../config/db');

/** Find a user record by email */
async function findByEmail(email) {
  const res = await pool.query('SELECT u.*, r.name AS role_name, COALESCE(t.enabled, FALSE) AS totp_enabled FROM users u LEFT JOIN roles r ON r.id = u.role_id LEFT JOIN totp_credentials t ON t.user_id = u.id WHERE u.email = $1', [email]);
  return res.rows[0];
}

/** Create a new user */
async function createUser({ username, email, password_hash, password_salt }) {
  // Assign default role 'user'
  const roleRes = await pool.query("SELECT id FROM roles WHERE name = 'customer' LIMIT 1");
  const roleId = roleRes.rows[0] ? roleRes.rows[0].id : null;
  const insertText = `
    INSERT INTO users (username, email, password_hash, password_salt, role_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    RETURNING id, username, email, role_id`;
  const values = [username, email, password_hash, password_salt, roleId];
  const result = await pool.query(insertText, values);
  return result.rows[0];
}

module.exports = {
  findByEmail,
  createUser,
};
