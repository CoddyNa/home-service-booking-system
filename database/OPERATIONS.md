# Database operations

## Apply migrations

Configure `apps/api/.env` with the Supabase Session pooler values, password, and root CA certificate, install PostgreSQL client tools, then run `npm run migrate:supabase` from `apps/api`. Migrations are source-controlled in `database/migrations` and each file is applied transactionally. Migration `003_marketplace.sql` adds marketplace tables and maps legacy `user` role accounts to `customer`; it does not drop or truncate records. The default `npm run migrate` targets Supabase; use `npm run migrate:local` to explicitly target a local database.

For a persistent local development database, run `npm run setup:local-db`. It initializes PostgreSQL under the current Windows user profile, applies every migration, and writes local connection settings to the ignored `.env.local`. Set `DATABASE_TARGET=local` in the API process environment to use it. The app otherwise uses Supabase.

Use the exact session-pooler host and username shown in Supabase Dashboard → Connect. Keep database passwords and encryption keys in the ignored `.env` file.

## Bootstrap the first administrator

Register an account you control, then run `npm run admin:promote -- user@example.com` from `apps/api` while connected to the intended database. The command assigns the admin role and writes an audit record.

The project demo seed has an explicit Supabase target guard: `npm run seed:demo:supabase`. It creates marketplace development accounts with randomly generated passwords and prints newly issued credentials once, plus idempotent demonstration categories, a provider/listing, a booking, a review, and a support ticket. Do not use demo accounts in a public production deployment.

## Amazon S3 encrypted backups

Migration `004_s3_backups.sql` adds S3 object metadata and persisted operation status. Configure `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_S3_PREFIX`, credentials (or a hosting role), and `BACKUP_ENCRYPTION_KEY` on the API only. Admins create a manual encrypted `public` schema logical dump from Backups & restore. AES-256-GCM is applied before upload, with the independent key held outside the database; S3 server-side encryption is also requested. The database records IV, authentication tag, S3 key, object size, SHA-256, status, and expiration. Passwords and other credentials are not included in object metadata.

The API reports success only after it confirms S3 object size/metadata, downloads it, checks SHA-256, decrypts it, and validates the PostgreSQL custom archive using `pg_restore --list`. Temporary files are created with restrictive permissions and removed after use. Long backup status is persisted in `backup_operations`; operations interrupted by API restart are marked failed on startup. A database index prevents two backup jobs from running concurrently.

Retention is seven days by `expires_at`, with an explicit administrator **Clean up expired** action. No timer is configured. Cleanup lists and permanently deletes all versions and delete markers for only expired object keys under the configured application prefix, and skips objects with an active restore or verification operation. It requires `s3:ListBucketVersions` scoped to the prefix plus `s3:DeleteObjectVersion` on the matching object prefix. Configure lifecycle abort of incomplete multipart uploads after one day; that handles uploads left behind if a process is forcibly terminated.

The project has no Supabase Storage or local upload integration, so uploaded files are not backed up and `files_status` is reported as `not_applicable`. Website static assets are in source control/deployed with Vercel. PostgreSQL platform-managed schemas and Supabase Auth internals are outside the selected `public` dump scope.

## Restore

Admins can inspect an archive using Preview; this validates and lists PostgreSQL objects without changing database data. Restore requires a separate `RECOVERY_DATABASE_*` target and typed confirmation. The API rejects the active application database as a restore target and revalidates the S3 object before restoring. Validate table counts, sign-in, 2FA verification, and audit history before directing applications to the recovered database.

Keep the application encryption key separately from S3 and the database. Never configure the active database as the recovery target. Configure/test IAM, bucket policies, lifecycle, backups, and isolated restores operationally; code configuration alone does not verify the live AWS account.
