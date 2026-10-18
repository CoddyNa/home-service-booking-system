const { PassThrough: mockPassThrough, Readable: mockReadable, Writable: mockWritable } = require('stream');

const mockState = { object: null, metadata: null, operation: null, record: null, credentialsMissing: false, pgToolVersion: 17, uploadError: false, expiredRows: [], deletedVersions: [] };
jest.mock('../src/config/db', () => ({ pool: { query: jest.fn(async (sql, params = []) => {
  if (sql.includes('SHOW server_version_num')) {
    return { rows: [{ server_version_num: '170011' }] };
  } else if (sql.includes('SELECT b.backup_id,b.s3_key')) {
    return { rows: mockState.expiredRows };
  } else if (sql.includes("INTERVAL '5 minutes'")) {
    return { rows: [], rowCount: 0 };
  } else if (sql.includes('INSERT INTO backup_operations')) {
    mockState.operation = { operation_id: params[0], status: 'running', database_status: 'running', upload_status: 'pending', verification_status: 'pending', files_status: 'not_applicable' };
  } else if (sql.includes('UPDATE backup_operations')) {
    if (mockState.operation) {
      if (sql.includes("status='failed'")) { mockState.operation.status = 'failed'; mockState.operation.error_message = params[1]; }
      if (sql.includes("SET status='complete'")) mockState.operation.status = 'complete';
      if (sql.includes("database_status='complete'")) mockState.operation.database_status = 'complete';
      if (sql.includes("upload_status='running'")) mockState.operation.upload_status = 'running';
      if (sql.includes("upload_status='complete'")) mockState.operation.upload_status = 'complete';
      if (sql.includes("verification_status='running'")) mockState.operation.verification_status = 'running';
      if (sql.includes("verification_status='verified'")) mockState.operation.verification_status = 'verified';
    }
  } else if (sql.includes('INSERT INTO backup_records')) {
    mockState.record = { backup_id: params[0], status: 'running', size_bytes: String(params[1]), checksum: params[2], created_at: new Date().toISOString(), file_name: params[4], encryption_iv: params[5], encryption_tag: params[6], s3_key: params[7], files_status: 'not_applicable', upload_status: 'complete', verification_status: 'running' };
  } else if (sql.includes('SELECT * FROM backup_records')) {
    return { rows: [mockState.record] };
  } else if (sql.startsWith('SELECT backup_id,status,size_bytes,checksum')) {
    return { rows: mockState.record?.status === 'complete' ? [mockState.record] : [] };
  } else if (sql.includes('SELECT operation_id,operation_type,status,database_status')) {
    return { rows: [mockState.operation] };
  } else if (sql.includes('UPDATE backup_records SET status=\'complete\'')) {
    mockState.record.status = 'complete';
  } else if (sql.includes("SET status='expired'")) {
    mockState.expiredRows = mockState.expiredRows.filter((row) => row.backup_id !== params[0]);
  }
  return { rows: [], rowCount: 1 };
}) } }));

jest.mock('@aws-sdk/client-s3', () => {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class HeadObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectsCommand { constructor(input) { this.input = input; } }
  class ListObjectVersionsCommand { constructor(input) { this.input = input; } }
  return {
    GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectVersionsCommand,
    S3Client: class {
      constructor() { this.config = { credentials: async () => { if (mockState.credentialsMissing) throw new Error('credentials not configured'); return { accessKeyId: 'mock', secretAccessKey: 'mock' }; } }; }
      destroy() {}
      async send(command) {
        if (command instanceof HeadObjectCommand) return { ContentLength: mockState.object.length, Metadata: mockState.metadata };
        if (command instanceof GetObjectCommand) return { ContentLength: mockState.object.length, Body: mockReadable.from([mockState.object]) };
        if (command instanceof DeleteObjectCommand) { mockState.object = null; return {}; }
        if (command instanceof ListObjectVersionsCommand) return { Versions: [{ Key: command.input.Prefix, VersionId: 'v1' }, { Key: `${command.input.Prefix}-unrelated`, VersionId: 'bad' }], DeleteMarkers: [{ Key: command.input.Prefix, VersionId: 'delete-marker' }], IsTruncated: false };
        if (command instanceof DeleteObjectsCommand) { mockState.deletedVersions.push(...command.input.Delete.Objects); return { Deleted: command.input.Delete.Objects }; }
      }
    },
  };
});
jest.mock('@aws-sdk/lib-storage', () => ({ Upload: class {
  constructor(options) { this.options = options; }
  async done() {
    if (mockState.uploadError) { this.options.params.Body.destroy(); throw new Error('mock S3 upload failed'); }
    const chunks = []; for await (const chunk of this.options.params.Body) chunks.push(chunk);
    mockState.object = Buffer.concat(chunks); mockState.metadata = this.options.params.Metadata;
    return {};
  }
} }));
jest.mock('child_process', () => ({ spawn: (program, args = []) => {
  const child = new (require('events').EventEmitter)(); child.stderr = new mockPassThrough();
  if (args[0] === '--version') {
    child.stdout = mockReadable.from([Buffer.from(`${String(program).toLowerCase().includes('pg_dump') ? 'pg_dump' : 'pg_restore'} (PostgreSQL) ${mockState.pgToolVersion}.11`) ]); child.stdin = null;
    setImmediate(() => child.emit('close', 0));
  } else if (String(program).toLowerCase().includes('pg_dump')) {
    child.stdout = mockReadable.from([Buffer.from('mock postgres custom archive')]); child.stdin = null;
    setImmediate(() => child.emit('close', 0));
  } else {
    child.stdout = new mockPassThrough();
    child.stdin = new mockWritable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
      child.stdout.end('; PostgreSQL archive\n1; 1259 10 TABLE public users postgres\n'); callback(); setImmediate(() => child.emit('close', 0));
    } });
  }
  return child;
} }));

const service = require('../src/services/backupService');

describe('S3 backup pipeline (AWS mocked)', () => {
  const variables = ['AWS_REGION','AWS_S3_BUCKET','AWS_S3_PREFIX','BACKUP_ENCRYPTION_KEY','DATABASE_HOST','DATABASE_PORT','DATABASE_NAME','DATABASE_USER','DATABASE_PASSWORD','DATABASE_SSL'];
  const original = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    Object.assign(mockState, { object: null, metadata: null, operation: null, record: null, credentialsMissing: false, pgToolVersion: 17, uploadError: false, expiredRows: [], deletedVersions: [] });
    Object.assign(process.env, { AWS_REGION: 'us-east-1', AWS_S3_BUCKET: 'test-private-bucket', AWS_S3_PREFIX: 'loginauth', BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), DATABASE_HOST: 'db.example.test', DATABASE_PORT: '5432', DATABASE_NAME: 'app', DATABASE_USER: 'app', DATABASE_PASSWORD: 'mock-password', DATABASE_SSL: 'false' });
  });
  afterAll(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  test('creates, uploads, downloads, decrypts, checks checksum, and validates a PostgreSQL archive', async () => {
    const { operationId } = await service.createBackup(5);
    for (let i = 0; i < 300; i++) {
      const operation = await service.getOperation(operationId);
      if (operation.status === 'complete') break;
      if (operation.status === 'failed') throw new Error(operation.error_message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const operation = await service.getOperation(operationId);
    expect(operation.status).toBe('complete');
    expect(operation.database_status).toBe('complete');
    expect(operation.upload_status).toBe('complete');
    expect(operation.verification_status).toBe('verified');
    expect(mockState.object).toBeInstanceOf(Buffer);
    expect(mockState.metadata.sha256).toBe(mockState.record.checksum);
    expect(mockState.record.s3_key).toBe(`loginauth/database/${operationId}.dump.enc`);
  });

  test('rejects a corrupted S3 object when verifying it', async () => {
    const { operationId } = await service.createBackup(5);
    for (let i = 0; i < 300; i++) {
      const operation = await service.getOperation(operationId);
      if (operation.status === 'complete') break;
      if (operation.status === 'failed') throw new Error(operation.error_message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    mockState.object = Buffer.from('corrupted encrypted backup');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const verification = await service.verifyBackup(operationId, 5);
    for (let i = 0; i < 100; i++) {
      const operation = await service.getOperation(verification.operationId);
      if (operation.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await service.getOperation(verification.operationId);
    log.mockRestore();
    expect(result.status).toBe('failed');
    expect(result.error_message).toMatch(/size or SHA-256 checksum/);
  });

  test('rejects missing AWS credentials before creating an operation', async () => {
    mockState.credentialsMissing = true;
    await expect(service.createBackup(5)).rejects.toThrow('AWS credentials are unavailable to the backend');
    expect(mockState.operation).toBeNull();
  });

  test('rejects PostgreSQL client tools older than the Supabase server', async () => {
    mockState.pgToolVersion = 16;
    await expect(service.createBackup(5)).rejects.toThrow(/pg_dump version 16 is older than database version 17/);
    expect(mockState.operation).toBeNull();
  });

  test('retention cleanup deletes every version for expired app keys and skips unrelated prefixes', async () => {
    mockState.expiredRows = [
      { backup_id: 'expired', s3_key: 'loginauth/database/expired.dump.enc' },
      { backup_id: 'unrelated', s3_key: 'other-app/database/keep.dump.enc' },
    ];
    const result = await service.cleanupExpired();
    expect(result.deleted).toBe(1);
    expect(mockState.deletedVersions).toEqual([
      { Key: 'loginauth/database/expired.dump.enc', VersionId: 'v1' },
      { Key: 'loginauth/database/expired.dump.enc', VersionId: 'delete-marker' },
    ]);
    expect(mockState.expiredRows.map((row) => row.backup_id)).toEqual(['unrelated']);
  });

  test('records a failed S3 upload without reporting a completed backup', async () => {
    mockState.uploadError = true;
    const { operationId } = await service.createBackup(5);
    for (let i = 0; i < 100; i++) {
      const operation = await service.getOperation(operationId);
      if (operation.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const operation = await service.getOperation(operationId);
    expect(operation.status).toBe('failed');
    expect(operation.error_message).toContain('mock S3 upload failed');
    expect(mockState.object).toBeNull();
  });
});
