const backupService = require('../src/services/backupService');

describe('S3 backup configuration guards', () => {
  const original = { AWS_S3_BUCKET: process.env.AWS_S3_BUCKET, BACKUP_ENCRYPTION_KEY: process.env.BACKUP_ENCRYPTION_KEY };
  const databaseEnv = Object.fromEntries(['DATABASE_HOST','DATABASE_NAME','DATABASE_USER','DATABASE_PASSWORD'].map((key) => [key, process.env[key]]));
  afterEach(() => {
    if (original.AWS_S3_BUCKET === undefined) delete process.env.AWS_S3_BUCKET; else process.env.AWS_S3_BUCKET = original.AWS_S3_BUCKET;
    if (original.BACKUP_ENCRYPTION_KEY === undefined) delete process.env.BACKUP_ENCRYPTION_KEY; else process.env.BACKUP_ENCRYPTION_KEY = original.BACKUP_ENCRYPTION_KEY;
    for (const [key, value] of Object.entries(databaseEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  test('identifies identical recovery and active database settings', () => {
    const endpoint = { host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.projectref00000001' };
    expect(backupService.isSameDatabaseConfig({ ...endpoint }, { ...endpoint })).toBe(true);
  });

  test('allows distinct Supabase projects on a shared regional pooler only with project-qualified users', () => {
    const common = { host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres' };
    expect(backupService.isSameDatabaseConfig({ ...common, user: 'postgres.projectref00000001' }, { ...common, user: 'postgres.projectref00000002' })).toBe(false);
    expect(backupService.isSameDatabaseConfig({ ...common, user: 'postgres' }, { ...common, user: 'postgres' })).toBe(true);
  });

  test('does not treat a different role on the same ordinary database route as a separate recovery database', () => {
    const common = { host: 'db.example.test', port: 5432, database: 'postgres' };
    expect(backupService.isSameDatabaseConfig({ ...common, user: 'recovery_role' }, { ...common, user: 'app_role' })).toBe(true);
  });

  test('refuses to start when the S3 bucket is not configured', async () => {
    delete process.env.AWS_S3_BUCKET;
    await expect(backupService.createBackup(1)).rejects.toThrow('AWS_S3_BUCKET is not configured');
  });

  test('refuses to start when application encryption key is missing', async () => {
    process.env.AWS_S3_BUCKET = 'example-private-bucket';
    delete process.env.BACKUP_ENCRYPTION_KEY;
    await expect(backupService.createBackup(1)).rejects.toThrow('BACKUP_ENCRYPTION_KEY is not configured');
  });

  test('refuses to start when the database connection is incomplete', async () => {
    process.env.AWS_S3_BUCKET = 'example-private-bucket';
    process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    for (const key of ['DATABASE_HOST','DATABASE_NAME','DATABASE_USER','DATABASE_PASSWORD']) delete process.env[key];
    await expect(backupService.createBackup(1)).rejects.toThrow('Database connection settings are incomplete');
  });
});
