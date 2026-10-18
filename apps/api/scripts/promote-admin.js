require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
if (process.env.NODE_ENV !== 'production') require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env.local'), override: true });
const { pool } = require('../src/config/db');

async function promote() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('Usage: npm run admin:promote -- <registered-email>');
  const result = await pool.query(`UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'admin'), updated_at = NOW()
    WHERE lower(email) = $1 RETURNING id`, [email]);
  if (!result.rows[0]) throw new Error('No registered user found for that email');
  await pool.query(`INSERT INTO audit_logs (actor_user_id, target_user_id, event_type, metadata, outcome)
    VALUES (NULL, $1, 'admin.bootstrap', $2, 'success')`, [result.rows[0].id, JSON.stringify({ method: 'operator_cli' })]);
  console.log('Administrator role assigned.');
}

promote().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
