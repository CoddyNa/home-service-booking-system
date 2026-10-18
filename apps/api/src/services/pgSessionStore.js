const session = require('express-session');
const { pool } = require('../config/db');

class PgSessionStore extends session.Store {
  get(sid, callback) {
    pool.query('SELECT data FROM sessions WHERE sid = $1 AND expires > NOW()', [sid])
      .then(({ rows }) => callback(null, rows[0] ? rows[0].data : null))
      .catch(callback);
  }

  set(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires ? new Date(value.cookie.expires) : new Date(Date.now() + 86400000);
    const userId = value.userId || null;
    pool.query(`INSERT INTO sessions (sid, user_id, expires, data) VALUES ($1, $2, $3, $4)
      ON CONFLICT (sid) DO UPDATE SET user_id = EXCLUDED.user_id, expires = EXCLUDED.expires, data = EXCLUDED.data`,
    [sid, userId, expires, JSON.stringify(value)])
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires ? new Date(value.cookie.expires) : new Date(Date.now() + 86400000);
    pool.query('UPDATE sessions SET expires = $1 WHERE sid = $2', [expires, sid])
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback = () => {}) {
    pool.query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => callback(null))
      .catch(callback);
  }
}

module.exports = PgSessionStore;
