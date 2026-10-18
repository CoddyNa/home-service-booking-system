require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });
const crypto = require('crypto');
const { pool } = require('../src/config/db');
const { hashPassword } = require('../src/utils/password');

const accounts = [
  { username: 'Demo Administrator', email: 'demo.admin@example.test', role: 'admin' },
  { username: 'Demo Staff', email: 'demo.staff@example.test', role: 'staff' },
  { username: 'Demo Auditor', email: 'demo.auditor@example.test', role: 'auditor' },
  { username: 'Demo User', email: 'demo.user@example.test', role: 'user' },
];

async function main() {
  if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DATABASE_HOST)) throw new Error('Demo seed is restricted to a local development database.');
  const issued = [];
  for (const account of accounts) {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [account.email]);
    if (existing.rows[0]) {
      await pool.query('UPDATE users SET role_id = (SELECT id FROM roles WHERE name = $1), is_active = TRUE, updated_at = NOW() WHERE id = $2', [account.role, existing.rows[0].id]);
      continue;
    }
    const password = `D3mo-${crypto.randomBytes(18).toString('base64url')}!`;
    const credential = await hashPassword(password);
    await pool.query('INSERT INTO users (username, email, password_hash, password_salt, role_id) VALUES ($1, $2, $3, $4, (SELECT id FROM roles WHERE name = $5))', [account.username, account.email, credential.hash, credential.salt, account.role]);
    issued.push({ email: account.email, role: account.role, password });
  }
  if (issued.length) {
    console.log('New demo account credentials (shown once; store securely):');
    issued.forEach((item) => console.log(`${item.role}: ${item.email} / ${item.password}`));
  } else console.log('Demo users already exist; roles were refreshed. Passwords were not changed.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
