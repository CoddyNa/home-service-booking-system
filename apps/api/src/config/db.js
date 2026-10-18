const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
if (process.env.DATABASE_TARGET === 'local' && process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env.local'), override: true });
}

let pool;

if (process.env.NODE_ENV === 'test') {
  // In‑memory PostgreSQL for tests using pg‑mem
  const { newDb } = require('pg-mem');
  const db = newDb();
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'database', 'migrations', '001_init.sql'), 'utf8');
  // pg-mem does not implement PostgreSQL row-level security statements.
  db.public.none(sql.replace(/^\s*ALTER\s+TABLE\s+.+?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*;\s*$/gim, ''));
  const pgMem = db.adapters.createPg();
  pool = new pgMem.Pool();
} else {
  // Production / development configuration (Supabase)
  const ssl = process.env.DATABASE_SSL === 'true'
    ? {
        // Keep certificate and hostname verification enabled. Supabase's CA is
        // downloaded from Database Settings > SSL Configuration.
        rejectUnauthorized: true,
        ...(process.env.PGSSLROOTCERT
          ? {
              ca: fs.readFileSync(
                path.isAbsolute(process.env.PGSSLROOTCERT)
                  ? process.env.PGSSLROOTCERT
                  : path.resolve(__dirname, '..', '..', process.env.PGSSLROOTCERT),
                'utf8',
              ),
            }
          : {}),
      }
    : false;
  pool = new Pool({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT, 10),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    ssl,
  });
}

module.exports = { pool };
