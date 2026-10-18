$ErrorActionPreference = 'Stop'

$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\PostgreSQL\17'
$bin = Join-Path $installRoot 'bin'
$dataDir = Join-Path $env:LOCALAPPDATA 'SecureAuth\PostgreSQL\17\data'
$logFile = Join-Path (Split-Path $dataDir -Parent) 'postgres.log'
$envFile = Join-Path $PSScriptRoot '..\.env.local'
$passwordFile = Join-Path $env:TEMP ('secure-auth-pg-' + [guid]::NewGuid().ToString('N') + '.txt')

foreach ($tool in @('initdb.exe', 'pg_ctl.exe', 'createdb.exe', 'psql.exe')) {
  if (-not (Test-Path (Join-Path $bin $tool))) { throw "PostgreSQL client/server tool missing: $tool" }
}
$dataParent = Split-Path $dataDir -Parent
New-Item -ItemType Directory -Force -Path $dataParent | Out-Null
$localSettings = @{}
if (Test-Path $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { $localSettings[$Matches[1]] = $Matches[2] }
  }
  if ($localSettings.DATABASE_HOST -ne '127.0.0.1' -or $localSettings.DATABASE_PORT -ne '5433' -or $localSettings.DATABASE_NAME -ne 'secure_auth_dev') {
    throw 'apps/api/.env.local exists with custom settings; refusing to change it.'
  }
  $password = $localSettings.DATABASE_PASSWORD
  if (-not $password) { throw 'Local database password is missing from apps/api/.env.local.' }
} else {
  $randomBytes = New-Object byte[] 32
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $rng.GetBytes($randomBytes)
  $password = [BitConverter]::ToString($randomBytes).Replace('-', '')
  $rng.Dispose()
}
try {
  if (-not (Test-Path (Join-Path $dataDir 'PG_VERSION'))) {
    if (Test-Path $dataDir) { throw "Data directory already exists but is not initialized: $dataDir" }
    Set-Content -LiteralPath $passwordFile -Value $password -NoNewline -Encoding ascii
    & (Join-Path $bin 'initdb.exe') --username=postgres --auth=scram-sha-256 --pwfile=$passwordFile --encoding=UTF8 --pgdata=$dataDir
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed.' }
  }

  $port = 5433
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if (-not $listener) {
    & (Join-Path $bin 'pg_ctl.exe') --pgdata=$dataDir --log=$logFile --options="-h 127.0.0.1 -p $port" start
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the local PostgreSQL development server.' }
  }

  $env:PGPASSWORD = $password
  $databaseCheck = & (Join-Path $bin 'psql.exe') --host=127.0.0.1 --port=$port --username=postgres --dbname=postgres --tuples-only --no-align --command="SELECT 1 FROM pg_database WHERE datname = 'secure_auth_dev'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to the local PostgreSQL development server.' }
  if ($databaseCheck -ne '1') {
    & (Join-Path $bin 'createdb.exe') --host=127.0.0.1 --port=$port --username=postgres --owner=postgres secure_auth_dev
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local development database.' }
  }

  if (-not (Test-Path $envFile)) {
    @(
      'DATABASE_HOST=127.0.0.1'
      "DATABASE_PORT=$port"
      'DATABASE_NAME=secure_auth_dev'
      'DATABASE_USER=postgres'
      "DATABASE_PASSWORD=$password"
      'DATABASE_SSL=false'
    ) | Set-Content -LiteralPath $envFile -Encoding ascii
  }
  Write-Output 'Local PostgreSQL is running on 127.0.0.1:5433; applying the project migration.'
  Push-Location $PSScriptRoot\..
  try { npm run migrate; if ($LASTEXITCODE -ne 0) { throw 'Local database migration failed.' } }
  finally { Pop-Location }
  Write-Output 'Local database setup complete. Its credentials are stored in the ignored apps/api/.env.local file.'
}
finally {
  Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
