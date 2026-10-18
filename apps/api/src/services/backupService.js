const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Client } = require('pg');
const { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { pool } = require('../config/db');
const auditService = require('./auditService');

function configurationError(message) { const error = new Error(message); error.status = 503; error.expose = true; return error; }
function config() {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION || 'us-east-1';
  if (!bucket) throw configurationError('AWS_S3_BUCKET is not configured');
  const prefix = (process.env.AWS_S3_PREFIX || 'loginauth').replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,99}$/.test(prefix)) throw configurationError('AWS_S3_PREFIX must be a simple application-owned path');
  // The SDK uses the normal credential chain (environment variables or the hosting role).
  return { bucket, region, prefix };
}
function client() { const { region } = config(); return new S3Client({ region }); }
async function validateAwsCredentials() {
  const s3 = client();
  try { await s3.config.credentials(); }
  catch { throw configurationError('AWS credentials are unavailable to the backend'); }
  finally { s3.destroy(); }
}
function encryptionKey() {
  const encoded = process.env.BACKUP_ENCRYPTION_KEY;
  if (!encoded) throw configurationError('BACKUP_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(encoded, /^[a-f0-9]{64}$/i.test(encoded) ? 'hex' : 'base64');
  if (key.length !== 32) throw configurationError('BACKUP_ENCRYPTION_KEY must encode 32 random bytes');
  return key;
}
function executable(name) {
  const configured = process.env[name === 'pg_dump' ? 'PG_DUMP_PATH' : 'PG_RESTORE_PATH'];
  if (configured) return configured;
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'PostgreSQL', '17', 'bin', `${name}.exe`);
  return local && fs.existsSync(local) ? local : name;
}
function pgArgs(program, cfg, extra = []) {
  const args = [...extra, '--host', cfg.host, '--port', String(cfg.port), '--username', cfg.user, '--dbname', cfg.database];
  if (program === 'pg_dump') args.push('--no-owner', '--no-acl', '--format=custom', '--schema=public');
  return args;
}
function pgEnvironment(cfg) {
  const useSsl = cfg.ssl === undefined ? process.env.DATABASE_SSL === 'true' : cfg.ssl;
  return { ...process.env, PGPASSWORD: cfg.password, PGSSLMODE: useSsl ? 'verify-full' : 'prefer' };
}
function start(program, args, env) {
  const child = spawn(executable(program), args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString(); });
  return { child, stderr: () => stderr };
}
async function toolMajorVersion(name) {
  const { child, stderr } = start(name, ['--version'], process.env);
  const chunks = []; child.stdout.on('data', (chunk) => chunks.push(chunk));
  await completed(child, stderr);
  const match = Buffer.concat(chunks).toString('utf8').match(/PostgreSQL\)?\s+(\d+)/i);
  if (!match) throw new Error(`Could not determine ${name} version`);
  return Number(match[1]);
}
async function assertPostgresToolVersions() {
  const result = await pool.query('SHOW server_version_num');
  const serverMajor = Math.floor(Number(result.rows[0]?.server_version_num) / 10000);
  if (!serverMajor) throw configurationError('Could not determine PostgreSQL server version');
  for (const tool of ['pg_dump', 'pg_restore']) {
    const toolMajor = await toolMajorVersion(tool);
    if (toolMajor < serverMajor) throw configurationError(`${tool} version ${toolMajor} is older than database version ${serverMajor}; configure compatible PostgreSQL client tools`);
  }
}
async function completed(child, stderr) {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`PostgreSQL backup tool failed (${code}): ${stderr().trim().slice(0, 400)}`);
}
function databaseConfig(prefix = 'DATABASE') {
  return { host: process.env[`${prefix}_HOST`], port: Number(process.env[`${prefix}_PORT`] || 5432), database: process.env[`${prefix}_NAME`], user: process.env[`${prefix}_USER`], password: process.env[`${prefix}_PASSWORD`] };
}
function supabasePoolerProjectsDiffer(hostA, userA, hostB, userB) {
  if (!/\.pooler\.supabase\.com$/i.test(hostA || '') || !/\.pooler\.supabase\.com$/i.test(hostB || '')) return false;
  const projectRef = (user) => String(user || '').match(/^[^.]+\.([a-z0-9]{8,64})$/i)?.[1]?.toLowerCase();
  const refA = projectRef(userA); const refB = projectRef(userB);
  return Boolean(refA && refB && refA !== refB);
}
function isSameDatabaseConfig(target, source) {
  const sameRoute = target.host.toLowerCase() === source.host.toLowerCase()
    && target.port === source.port && target.database === source.database;
  if (!sameRoute) return false;
  if (target.user === source.user) return true;
  // Supabase's shared session pooler uses a regional hostname for multiple projects;
  // its project-qualified username is the stable tenant identifier.
  return !supabasePoolerProjectsDiffer(target.host, target.user, source.host, source.user);
}
function hasRecoveryDatabaseConfig() {
  const target = databaseConfig('RECOVERY_DATABASE');
  const source = databaseConfig();
  return Boolean(target.host && target.database && target.user && target.password)
    && !isSameDatabaseConfig(target, source);
}
function assertDatabaseConfig(cfg) {
  if (!cfg.host || !cfg.database || !cfg.user || !cfg.password || !Number.isInteger(cfg.port)) throw configurationError('Database connection settings are incomplete');
}
function databaseSsl(prefix) {
  const enabled = prefix === 'RECOVERY_DATABASE' ? process.env.RECOVERY_DATABASE_SSL !== 'false' : process.env.DATABASE_SSL === 'true';
  if (!enabled) return false;
  const certPath = process.env.PGSSLROOTCERT;
  return { rejectUnauthorized: true, ...(certPath ? { ca: fs.readFileSync(path.isAbsolute(certPath) ? certPath : path.resolve(__dirname, '..', '..', certPath), 'utf8') } : {}) };
}
async function assertSeparateRecoveryDatabase(target, source) {
  if (isSameDatabaseConfig(target, source)) {
    throw new Error('Recovery target must be separate from the active database');
  }
  const activeResult = await pool.query('SELECT current_database() AS name, current_user AS db_user, inet_server_addr()::text AS address, inet_server_port() AS port, current_setting(\'server_version_num\') AS version_num');
  const recoveryClient = new Client({ ...target, ssl: databaseSsl('RECOVERY_DATABASE') });
  try {
    await recoveryClient.connect();
    const recoveryResult = await recoveryClient.query('SELECT current_database() AS name, current_user AS db_user, inet_server_addr()::text AS address, inet_server_port() AS port, current_setting(\'server_version_num\') AS version_num');
    const active = activeResult.rows[0]; const recovery = recoveryResult.rows[0];
    const sameServerDatabase = active.name === recovery.name && active.address === recovery.address && Number(active.port) === Number(recovery.port);
    const separateSupabaseProjects = supabasePoolerProjectsDiffer(target.host, target.user, source.host, source.user);
    if (sameServerDatabase && !separateSupabaseProjects) {
      throw new Error('Recovery target resolves to the active application database');
    }
    const activeMajor = Math.floor(Number(active.version_num) / 10000); const recoveryMajor = Math.floor(Number(recovery.version_num) / 10000);
    if (recoveryMajor < activeMajor) throw new Error(`Recovery database version ${recoveryMajor} is older than source version ${activeMajor}`);
  } finally { await recoveryClient.end().catch(() => {}); }
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk)); input.once('error', reject); input.once('end', resolve);
  });
  return hash.digest('hex');
}
async function downloadObject(key, file) {
  const { bucket } = config();
  const response = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error('S3 returned an empty backup object');
  await pipeline(response.Body, fs.createWriteStream(file, { mode: 0o600, flags: 'wx' }));
  return response.ContentLength;
}
async function decryptTo(record, encryptedPath, dumpPath) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.encryption_iv, 'hex'));
  decipher.setAuthTag(Buffer.from(record.encryption_tag, 'hex'));
  await pipeline(fs.createReadStream(encryptedPath), decipher, fs.createWriteStream(dumpPath, { mode: 0o600, flags: 'wx' }));
}
async function verifyRecord(record) {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'auth-backup-'));
  const encrypted = path.join(temp, 'backup.enc'); const dump = path.join(temp, 'backup.dump');
  try {
    const length = await downloadObject(record.s3_key, encrypted);
    const checksum = await hashFile(encrypted);
    if (String(length) !== String(record.size_bytes) || checksum !== record.checksum) throw new Error('Backup size or SHA-256 checksum does not match its recorded metadata');
    await decryptTo(record, encrypted, dump);
    const { child, stderr } = start('pg_restore', ['--list'], pgEnvironment(databaseConfig()));
    const entries = []; child.stdout.on('data', (part) => { if (Buffer.concat(entries).length < 20000) entries.push(part); });
    await Promise.all([pipeline(fs.createReadStream(dump), child.stdin), completed(child, stderr)]);
    return { sizeBytes: Number(length), checksum, objectCount: Buffer.concat(entries).toString('utf8').split(/\r?\n/).filter((line) => line && !line.startsWith(';')).length };
  } finally { await fs.promises.rm(temp, { recursive: true, force: true }); }
}
async function createBackup(initiatedBy) {
  config(); encryptionKey(); assertDatabaseConfig(databaseConfig()); await validateAwsCredentials(); await assertPostgresToolVersions();
  const backupId = crypto.randomUUID();
  const { prefix } = config(); const key = `${prefix}/database/${backupId}.dump.enc`;
  await pool.query(`INSERT INTO backup_operations (operation_id, operation_type, status, initiated_by, database_status, files_status, upload_status, verification_status)
    VALUES ($1, 'backup', 'running', $2, 'running', 'not_applicable', 'pending', 'pending')`, [backupId, initiatedBy]);
  void performBackup(backupId, key, initiatedBy).catch((error) => console.error('Backup job failed:', safeError(error)));
  return { operationId: backupId, status: 'running' };
}
function startOperationHeartbeat(operationId) {
  const timer = setInterval(() => {
    pool.query("UPDATE backup_operations SET updated_at=NOW() WHERE operation_id=$1 AND status='running'", [operationId]).catch(() => {});
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
async function performBackup(backupId, objectKey, initiatedBy) {
  const stopHeartbeat = startOperationHeartbeat(backupId);
  let temp;
  try {
    temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'auth-backup-'));
    const file = path.join(temp, `${backupId}.dump.enc`); const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const cfg = databaseConfig(); const { child, stderr } = start('pg_dump', pgArgs('pg_dump', cfg), pgEnvironment(cfg));
    await Promise.all([pipeline(child.stdout, cipher, fs.createWriteStream(file, { mode: 0o600, flags: 'wx' })), completed(child, stderr)]);
    await pool.query("UPDATE backup_operations SET database_status='complete', upload_status='running' WHERE operation_id=$1", [backupId]);
    const stat = await fs.promises.stat(file); const checksum = await hashFile(file); const { bucket } = config();
    await new Upload({ client: client(), params: { Bucket: bucket, Key: objectKey, Body: fs.createReadStream(file), ContentLength: stat.size, ContentType: 'application/octet-stream', ServerSideEncryption: 'AES256', Metadata: { application: 'loginauth', backupid: backupId, sha256: checksum } }, queueSize: 4, partSize: 8 * 1024 * 1024, leavePartsOnError: false }).done();
    const head = await client().send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (Number(head.ContentLength) !== stat.size || head.Metadata?.sha256 !== checksum || head.Metadata?.backupid !== backupId) throw new Error('Uploaded S3 object did not match the expected size or metadata');
    await pool.query("INSERT INTO backup_records (backup_id,status,size_bytes,checksum,initiated_by,file_name,encryption_iv,encryption_tag,s3_key,files_status,upload_status,verification_status,expires_at) VALUES ($1,'running',$2,$3,$4,$5,$6,$7,$8,'not_applicable','complete','running',NOW()+INTERVAL '7 days')", [backupId, stat.size, checksum, initiatedBy, `${backupId}.dump.enc`, iv.toString('hex'), cipher.getAuthTag().toString('hex'), objectKey]);
    await pool.query("UPDATE backup_operations SET database_status='complete', upload_status='complete', verification_status='running' WHERE operation_id=$1", [backupId]);
    const record = (await pool.query('SELECT * FROM backup_records WHERE backup_id=$1', [backupId])).rows[0];
    const verified = await verifyRecord(record);
    await pool.query("UPDATE backup_records SET verification_status='verified', verified_at=NOW() WHERE backup_id=$1", [backupId]);
    await auditService.logEvent({ actorUserId: initiatedBy, eventType: 'admin.backup_created', metadata: { backupId, sizeBytes: stat.size, checksum, storage: 's3', verification: 'verified', files: 'not_applicable', objectCount: verified.objectCount }, outcome: 'success' });
    await pool.query("UPDATE backup_records SET status='complete' WHERE backup_id=$1", [backupId]);
    await pool.query("UPDATE backup_operations SET status='complete', verification_status='verified' WHERE operation_id=$1", [backupId]);
  } catch (error) {
    await pool.query("UPDATE backup_operations SET status='failed', error_message=$2 WHERE operation_id=$1", [backupId, safeError(error)]).catch(() => {});
    await pool.query("UPDATE backup_records SET status='failed' WHERE backup_id=$1", [backupId]).catch(() => {});
    await auditService.logEvent({ actorUserId: initiatedBy, eventType: 'admin.backup_failed', metadata: { backupId, reason: safeError(error) }, outcome: 'failure' }).catch(() => {});
    if (objectKey) await client().send(new DeleteObjectCommand({ Bucket: config().bucket, Key: objectKey })).catch(() => {});
  } finally { stopHeartbeat(); if (temp) await fs.promises.rm(temp, { recursive: true, force: true }); }
}
function safeError(error) {
  return String(error?.message || 'Backup operation failed')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[database connection]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[aws-key]')
    .replace(/(password|secret|token|credential|access.?key)\s*[:=]\s*[^,\s]+/gi, '$1=[redacted]')
    .slice(0, 300);
}
async function backupRecord(backupId) {
  const result = await pool.query("SELECT backup_id,status,size_bytes,checksum,created_at,file_name,encryption_iv,encryption_tag,s3_key,restored_at,files_status,upload_status,verification_status,expires_at FROM backup_records WHERE backup_id=$1 AND status='complete' AND s3_key IS NOT NULL", [backupId]);
  if (!result.rows[0]) throw new Error('Backup not found');
  return result.rows[0];
}
async function previewBackup(backupId) {
  const record = await backupRecord(backupId); const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'auth-backup-'));
  const encrypted = path.join(temp, 'backup.enc'); const dump = path.join(temp, 'backup.dump');
  try {
    const length = await downloadObject(record.s3_key, encrypted); const checksum = await hashFile(encrypted);
    if (String(length) !== String(record.size_bytes) || checksum !== record.checksum) throw new Error('Backup size or checksum validation failed');
    await decryptTo(record, encrypted, dump);
    const { child, stderr } = start('pg_restore', ['--list'], pgEnvironment(databaseConfig())); const output = [];
    child.stdout.on('data', (chunk) => { if (Buffer.concat(output).length < 16000) output.push(chunk); });
    await Promise.all([pipeline(fs.createReadStream(dump), child.stdin), completed(child, stderr)]);
    const entries = Buffer.concat(output).toString('utf8').split(/\r?\n/).filter((line) => line && !line.startsWith(';'));
    await pool.query("UPDATE backup_records SET verification_status='verified', verified_at=NOW() WHERE backup_id=$1", [backupId]);
    return { backupId, sizeBytes: Number(record.size_bytes), checksum: record.checksum, objectCount: entries.length, entries: entries.slice(0,30) };
  } finally { await fs.promises.rm(temp, { recursive: true, force: true }); }
}
async function verifyBackup(backupId, initiatedBy) {
  await backupRecord(backupId);
  const operationId = crypto.randomUUID();
  await pool.query("INSERT INTO backup_operations (operation_id,operation_type,status,initiated_by,backup_id,database_status,files_status,upload_status,verification_status) VALUES ($1,'verify','running',$2,$3,'complete','not_applicable','complete','running')", [operationId, initiatedBy, backupId]);
  void performVerification(backupId, operationId, initiatedBy).catch((error) => console.error('Backup verification failed:', safeError(error)));
  return { backupId, operationId, status: 'running' };
}
async function performVerification(backupId, operationId, initiatedBy) {
  const stopHeartbeat = startOperationHeartbeat(operationId);
  try {
    const record = await backupRecord(backupId); const result = await verifyRecord(record);
    await pool.query("UPDATE backup_records SET verification_status='verified',verified_at=NOW() WHERE backup_id=$1", [backupId]);
    await auditService.logEvent({ actorUserId: initiatedBy, eventType: 'admin.backup_verified', metadata: { backupId, operationId, sizeBytes: result.sizeBytes, checksum: result.checksum, objectCount: result.objectCount }, outcome: 'success' });
    await pool.query("UPDATE backup_operations SET status='complete',verification_status='verified' WHERE operation_id=$1", [operationId]);
  } catch (error) {
    await pool.query("UPDATE backup_operations SET status='failed',error_message=$2 WHERE operation_id=$1", [operationId, safeError(error)]).catch(() => {});
    await auditService.logEvent({ actorUserId: initiatedBy, eventType: 'admin.backup_verification_failed', metadata: { backupId, operationId, reason: safeError(error) }, outcome: 'failure' }).catch(() => {});
    throw error;
  } finally { stopHeartbeat(); }
}
async function restoreToRecovery(backupId, initiatedBy) {
  const operationId = crypto.randomUUID();
  await pool.query("INSERT INTO backup_operations (operation_id,operation_type,status,initiated_by,backup_id,database_status,files_status,upload_status,verification_status) VALUES ($1,'restore','running',$2,$3,'running','not_applicable','complete','verified')", [operationId, initiatedBy, backupId]);
  void performRestore(backupId, operationId, initiatedBy).catch((error) => console.error('Restore job failed:', safeError(error)));
  return { backupId, operationId, status: 'running' };
}
async function performRestore(backupId, operationId, initiatedBy) {
  const stopHeartbeat = startOperationHeartbeat(operationId);
  let temp;
  try {
    await assertPostgresToolVersions();
    const record = await backupRecord(backupId);
    await verifyRecord(record);
    const target = databaseConfig('RECOVERY_DATABASE'); assertDatabaseConfig(target); const source = databaseConfig();
    await assertSeparateRecoveryDatabase(target, source);
    temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'auth-restore-')); const encrypted = path.join(temp, 'backup.enc'); const dump = path.join(temp, 'backup.dump');
    await downloadObject(record.s3_key, encrypted); await decryptTo(record, encrypted, dump);
    const { child, stderr } = start('pg_restore', pgArgs('pg_restore', target, ['--clean','--if-exists','--no-owner','--no-acl','--exit-on-error']), pgEnvironment({ ...target, ssl: process.env.RECOVERY_DATABASE_SSL !== 'false' }));
    await Promise.all([pipeline(fs.createReadStream(dump), child.stdin), completed(child, stderr)]);
    await pool.query('UPDATE backup_records SET restored_at=NOW() WHERE backup_id=$1', [backupId]);
    await auditService.logEvent({ actorUserId: initiatedBy, eventType: 'admin.backup_restored_to_recovery', metadata: { backupId, operationId, database: target.database }, outcome: 'success' });
    await pool.query("UPDATE backup_operations SET status='complete',database_status='complete' WHERE operation_id=$1", [operationId]);
  } catch (error) {
    await pool.query("UPDATE backup_operations SET status='failed',error_message=$2 WHERE operation_id=$1", [operationId, safeError(error)]).catch(() => {});
    await auditService.logEvent({ actorUserId: initiatedBy, eventType: 'admin.backup_restore_failed', metadata: { backupId, operationId, reason: safeError(error) }, outcome: 'failure' }).catch(() => {});
    throw error;
  } finally { stopHeartbeat(); if (temp) await fs.promises.rm(temp, { recursive: true, force: true }); }
}
async function getOperation(operationId) {
  await markStaleOperations(operationId);
  const result = await pool.query('SELECT operation_id,operation_type,status,database_status,files_status,upload_status,verification_status,error_message,created_at,updated_at FROM backup_operations WHERE operation_id=$1', [operationId]);
  if (!result.rows[0]) throw new Error('Backup operation not found'); return result.rows[0];
}
async function listOperations() {
  await markStaleOperations();
  const result = await pool.query('SELECT operation_id,operation_type,status,database_status,files_status,upload_status,verification_status,error_message,created_at,updated_at FROM backup_operations ORDER BY created_at DESC LIMIT 20');
  return result.rows;
}
async function markStaleOperations(operationId) {
  await pool.query("UPDATE backup_operations SET status='failed',error_message='Backup worker stopped before operation completed',updated_at=NOW() WHERE status IN ('queued','running') AND updated_at < NOW()-INTERVAL '5 minutes' AND ($1::text IS NULL OR operation_id=$1)", [operationId || null]);
  await pool.query("UPDATE backup_records SET status='failed' WHERE status='running' AND backup_id IN (SELECT operation_id FROM backup_operations WHERE status='failed') AND created_at < NOW()-INTERVAL '5 minutes'");
}
async function listBackups() {
  const result = await pool.query("SELECT backup_id,created_at,status,size_bytes,checksum,restored_at,files_status,upload_status,verification_status,expires_at FROM backup_records WHERE s3_key IS NOT NULL ORDER BY created_at DESC LIMIT 100");
  return result.rows;
}
async function cleanupExpired() {
  const { bucket, prefix } = config();
  const { rows } = await pool.query("SELECT b.backup_id,b.s3_key FROM backup_records b WHERE b.expires_at<=NOW() AND b.status='complete' AND b.s3_key LIKE $1 AND (b.restored_at IS NULL OR b.restored_at<NOW()-INTERVAL '1 hour') AND NOT EXISTS (SELECT 1 FROM backup_operations o WHERE o.backup_id=b.backup_id AND o.operation_type IN ('restore','verify') AND o.status IN ('queued','running'))", [`${prefix}/database/%`]);
  let deleted = 0;
  for (const row of rows) {
    if (!row.s3_key.startsWith(`${prefix}/database/`)) continue;
    await permanentlyDeleteObjectVersions(bucket, row.s3_key);
    await pool.query("UPDATE backup_records SET status='expired' WHERE backup_id=$1", [row.backup_id]); deleted++;
  }
  return { deleted };
}
async function permanentlyDeleteObjectVersions(bucket, objectKey) {
  const s3 = client(); let keyMarker; let versionIdMarker;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: objectKey, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker, MaxKeys: 1000 }));
    const versions = [...(page.Versions || []), ...(page.DeleteMarkers || [])]
      .filter((item) => item.Key === objectKey)
      .map((item) => ({ Key: item.Key, VersionId: item.VersionId }));
    if (versions.length) {
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: versions, Quiet: true } }));
      if (result.Errors?.length) throw new Error('S3 could not delete every expired backup version');
    }
    keyMarker = page.NextKeyMarker; versionIdMarker = page.NextVersionIdMarker;
    if (!page.IsTruncated) break;
    if (!keyMarker && !versionIdMarker) throw new Error('S3 returned an invalid version-list pagination marker');
  } while (true);
}
async function recoverInterruptedOperations() {
  await pool.query("UPDATE backup_operations SET status='failed',error_message='Backup worker stopped before operation completed',updated_at=NOW() WHERE status IN ('queued','running') AND updated_at < NOW()-INTERVAL '5 minutes'");
  await pool.query("UPDATE backup_records SET status='failed' WHERE status='running' AND created_at < NOW()-INTERVAL '5 minutes'");
}
module.exports = { createBackup, getOperation, listOperations, previewBackup, verifyBackup, restoreToRecovery, listBackups, cleanupExpired, recoverInterruptedOperations, safeError, isSameDatabaseConfig, hasRecoveryDatabaseConfig };
