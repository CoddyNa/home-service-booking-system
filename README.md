# Homewise | LoginAuth + Home Service Marketplace

Homewise is a responsive React/Vite website backed by an Express API and Supabase PostgreSQL. It extends the original LoginAuth application with a local home-services marketplace. The existing source directories are `apps/web/` (Vercel frontend root) and `apps/api/` (Render backend root); SQL migrations live in `database/migrations/`.

## Current features

- Account registration, login, logout, session cookies, CSRF protection, Argon2id passwords with unique salts and a server-side pepper, TOTP enrollment/login verification, password reset, and audit logging.
- Marketplace browsing/search by text, category, service area, and price; provider applications and approval; provider service listings and listing review; booking requests/status lifecycle; eligible customer reviews and moderation; notifications; and support tickets with assigned-agent access and private internal notes.
- Admin user, role, backup/restore, provider, listing, category, review, booking, ticket, and audit views. Customers, providers, and support agents have separate server-enforced permissions.
- Encrypted on-demand PostgreSQL backups to private Amazon S3, integrity verification, seven-day expiration metadata and administrator-triggered cleanup, and preview/restore to a separately configured recovery database.

Live payments, service image uploads, email/SMS delivery, scheduled backups, and a public deployment are not configured. No Supabase Storage or user-uploaded file pipeline exists in this repository, so S3 backup currently covers the application database only. The app does not claim those operations are live.

## Run locally on Windows

1. Install Node.js 20+ and PostgreSQL 17 client tools (`psql`, `pg_dump`, `pg_restore`).
2. Copy `apps/api/.env.example` to `apps/api/.env`, fill in the Supabase pooler settings and private secrets, and keep the real `.env` out of Git. The Supabase CA certificate is already included at `apps/api/supabase-root-ca.crt`.
3. Apply the safe, additive schema migrations from PowerShell:

   ```powershell
   cd apps/api
   npm.cmd ci
   npm.cmd run migrate:supabase
   ```

   Migrations preserve existing accounts and records. Migration `003_marketplace.sql` adds the marketplace tables and maps legacy `user` accounts to `customer`.

4. Start the API in one terminal:

   ```powershell
   cd apps/api
   npm.cmd run dev
   ```

5. Start Vite in a second terminal:

   ```powershell
   cd apps/web
   npm.cmd ci
   npm.cmd run dev -- --host 127.0.0.1
   ```

6. Open `http://127.0.0.1:5173`. The API health endpoint is `http://127.0.0.1:5000/api/health`.

For an isolated local PostgreSQL database, run `npm.cmd run setup:local-db` in `apps/api`, then start the API with `$env:DATABASE_TARGET='local'`. This is a development option; the application database remains Supabase by default.

## Supabase migrations and sample data

Keep the Supabase connection string and database password in `apps/api/.env`. Use the Supabase Session pooler host/user shown by the project’s Connect panel, TLS verification, and the supplied root CA file. Run `npm run migrate:supabase` in `apps/api` to apply migrations. The migration runner uses `ON_ERROR_STOP` and a transaction for each migration file. It never drops application tables.

For development/demo accounts and marketplace sample data, run `npm run seed:demo:supabase` in `apps/api`. Newly created passwords are generated randomly and printed once; save them in a password manager. Do not run this seed on a public production deployment.

Create the authentication and backup secrets with `npm run setup:secrets` if they are absent. `PASSWORD_PEPPER`, `SESSION_SECRET`, `BACKUP_ENCRYPTION_KEY`, SMTP credentials, and database passwords are server-only values. Never use a `VITE_` variable for a secret.

## Deploy backend to Render

1. Push the repository to GitHub.
2. In Render, create a Web Service from the repository or use `render.yaml`. Set the Root Directory to `apps/api`, build command to `npm ci`, start command to `npm start`, and health path to `/api/health`.
3. Add the private database, session, pepper, backup encryption, AWS, email, and application URL variables listed in `render.yaml` and `apps/api/.env.example`. Keep `DATABASE_SSL=true` and the trusted CA path. AWS credentials belong in Render only.
4. Set `FRONTEND_URL` and `APP_BASE_URL` to the deployed Vercel origin. A separate recovery database is needed before restore can run. The S3 workflow no longer depends on a persistent Render disk.

## Deploy frontend to Vercel

1. Import the same GitHub repository in Vercel.
2. Set Root Directory to `apps/web`, framework to Vite, build command to `npm run build`, and output directory to `dist`.
3. Set `VITE_API_BASE_URL=/api`. This keeps browser requests same-origin so the secure session cookie can be proxied with the API.
4. Replace `YOUR-RENDER-SERVICE.onrender.com` in `apps/web/vercel.json` with the actual Render service hostname, then redeploy Vercel. The rewrite proxies `/api/*` and `/health` to Render.
5. Set Render’s `FRONTEND_URL` and `APP_BASE_URL` to the actual Vercel website URL.

Vercel and Render deployments require the user’s hosting accounts and service URLs. This repository is prepared for those deployments but has not been publicly deployed.

## Verification

Backend tests: `cd apps/api; npm test -- --runInBand`.

Frontend lint/build: `cd apps/web; npm run lint; npm run build`.

Check the latest task report for exact test results. Local tests use mocked AWS calls; a successful local build does not mean an AWS upload, Vercel deploy, or Render deploy has completed.

## Manual Amazon S3 backups

The backend uses AWS SDK for JavaScript v3 and the normal AWS credential chain. It writes only under the configured `AWS_S3_PREFIX/database/` path. Archives contain the PostgreSQL `public` application schema, use AES-256-GCM application encryption before upload, and use S3 SSE-S3 at rest. The backend checks S3 object size and metadata, downloads the object, checks SHA-256, decrypts it, and validates it with `pg_restore --list` before reporting success. Creation, verification, and recovery run as background operations whose status persists in Supabase; interrupted jobs are marked failed after their worker heartbeat expires. AWS credentials and the encryption key never go to the browser.

1. In AWS Console, select `us-east-1` and create a general-purpose bucket. Try `loginauth-backups`; S3 bucket names are globally unique, so if unavailable choose a unique variant such as `loginauth-backups-<your-random-suffix>` and use that exact name in `AWS_S3_BUCKET`.
2. Keep **Block all public access** enabled, disable ACLs, enable default encryption (SSE-S3), and require HTTPS/TLS in the bucket policy. The bucket is private; the app does not issue public URLs.
   Add this TLS-only statement to the bucket policy (replace `BUCKET_NAME`, and merge it with any other required statements):

   ```json
   {
     "Sid": "DenyInsecureTransport",
     "Effect": "Deny",
     "Principal": "*",
     "Action": "s3:*",
     "Resource": ["arn:aws:s3:::BUCKET_NAME", "arn:aws:s3:::BUCKET_NAME/*"],
     "Condition": { "Bool": { "aws:SecureTransport": "false" } }
   }
   ```
3. Create a dedicated IAM user/access key for the Render API (or a hosting role if available). Do not use the AWS root user or administrator permissions. Use a resource-scoped policy such as the following, replacing `BUCKET_NAME`. Restrict `ListBucket` to the prefix.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:ListBucketVersions"], "Resource": "arn:aws:s3:::BUCKET_NAME", "Condition": { "StringLike": { "s3:prefix": ["loginauth/database/*"] } } },
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], "Resource": "arn:aws:s3:::BUCKET_NAME/loginauth/database/*" }
     ]
   }
   ```

4. For local API development, set `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_S3_PREFIX`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` in the ignored `apps/api/.env`. The same keys are configured as private Render environment values. Never set them in Vercel or any `VITE_` variable. `AWS_SESSION_TOKEN` is optional for temporary AWS credentials. Keep `BACKUP_ENCRYPTION_KEY` generated independently with `npm run setup:secrets`; back it up securely outside S3 and outside the database.
5. Apply `database/migrations/004_s3_backups.sql` using `npm run migrate:supabase` before deploying the new API. Render's Node native runtime includes `postgresql-client`; the API checks `pg_dump` and `pg_restore` versions against the connected database and refuses to start a backup if the client major version is too old. Confirm `pg_dump --version` and `pg_restore --version` in the Render shell; Supabase is currently PostgreSQL 17, so use client major 17 or newer. If needed, set backend-only `PG_DUMP_PATH` and `PG_RESTORE_PATH` to compatible binaries.
6. Sign in as an administrator, open **Backups & restore**, then choose **Create backup now**. The button polls persisted operation status; success appears only after archive verification. Choose **Verify** to repeat the object, checksum, decryption, and archive checks.
7. To test recovery safely, configure a separate isolated `RECOVERY_DATABASE_*` target, inspect with **Preview**, then select **Restore to recovery** and type the requested confirmation. The active database is rejected as a target. Validate the recovered schema/data before using it for an actual recovery. Do not treat this as a live production rollback.
8. Backups receive an expiration timestamp seven days after creation. There is no scheduler: an administrator must choose **Clean up expired**. This removes eligible expired objects, all their versions and delete markers, and skips backups being verified or restored. The IAM identity needs `s3:ListBucketVersions` and `s3:DeleteObjectVersion` for this cleanup. Add an S3 lifecycle rule to abort incomplete multipart uploads after 1 day so a terminated Render process cannot leave partial multipart data indefinitely. If you configure automatic object expiration separately, review current and noncurrent version timing carefully and verify it in AWS; this project enforces the seven-day eligibility date through the manual cleanup action.

No Supabase Storage or local-upload subsystem is present in this project. Therefore service images or user files are not part of the backup; the dashboard explicitly reports files as `not_applicable`. Static website assets are in source control and deployed with Vercel. If file uploads are added, implement a separate paginated/streamed copy pipeline and file manifest before claiming file backup coverage.

The deployment operator must verify bucket public-access blocking, encryption, TLS policy, IAM restrictions, Render environment values, and a real successful backup/restore drill. AWS charges may include S3 storage, requests, and data transfer; seven-day deletion is manual unless an S3 lifecycle rule is configured and verified.

## Database operations

See [`database/OPERATIONS.md`](database/OPERATIONS.md) for safe migration, administrator bootstrap, demo data, encrypted backups, and recovery instructions.
