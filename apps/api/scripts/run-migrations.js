// apps/api/scripts/run-migrations.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const apiDir = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(apiDir, '.env') });
const requestedTarget = process.argv[2];
const target = requestedTarget || 'supabase';
if (!['local', 'supabase'].includes(target)) throw new Error('Migration target must be local or supabase');
if (target === 'local') {
  if (!fs.existsSync(path.join(apiDir, '.env.local'))) throw new Error('Local DB settings are missing; run npm run setup:local-db first');
  require('dotenv').config({ path: path.join(apiDir, '.env.local'), override: true });
}

function run() {
  const migrationsDir = path.resolve(__dirname, '..', '..', '..', 'database', 'migrations');
  const sqlFiles = fs.readdirSync(migrationsDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  const required = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing database configuration: ${missing.join(', ')}`);
  const localPsql = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'PostgreSQL', '17', 'bin', 'psql.exe');
  const psqlExecutable = process.env.PSQL_PATH || (localPsql && fs.existsSync(localPsql) ? localPsql : 'psql');
  for (const name of sqlFiles) {
  const sqlFile = path.join(migrationsDir, name);
  console.log(`Running ${target} migration:`, sqlFile);
  const result = spawnSync(psqlExecutable, [
    '--host', process.env.DATABASE_HOST,
    '--port', process.env.DATABASE_PORT,
    '--username', process.env.DATABASE_USER,
    '--dbname', process.env.DATABASE_NAME,
    '--set', 'ON_ERROR_STOP=1',
    '--single-transaction',
    '--file', sqlFile,
  ], {
    stdio: 'inherit',
    env: { ...process.env, PGPASSWORD: process.env.DATABASE_PASSWORD, PGSSLMODE: process.env.DATABASE_SSL === 'true' ? 'verify-full' : 'prefer' },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  }
}

run();
