// scripts/setup-secrets.js
/**
 * Generates a cryptographically secure password pepper and a session secret
 * if they do not already exist in the .env file.
 *
 * Usage: `npm run setup:secrets`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.resolve(__dirname, '..', '.env');
const examplePath = path.resolve(__dirname, '..', '.env.example');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, { encoding: 'utf8' });
  return content.split('\n').reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return acc;
    const [key, ...rest] = trimmed.split('=');
    acc[key] = rest.join('=');
    return acc;
  }, {});
}

function writeEnvFile(filePath, envObj) {
  const lines = Object.entries(envObj).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', { encoding: 'utf8' });
}

function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function main() {
  const env = loadEnvFile(envPath);
  let updated = false;

  if (!env.PASSWORD_PEPPER) {
    env.PASSWORD_PEPPER = generateSecret(32);
    console.log('Generated PASSWORD_PEPPER');
    updated = true;
  }

  if (!env.SESSION_SECRET) {
    env.SESSION_SECRET = generateSecret(48);
    console.log('Generated SESSION_SECRET');
    updated = true;
  }

  if (!env.BACKUP_ENCRYPTION_KEY) {
    env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    console.log('Generated BACKUP_ENCRYPTION_KEY');
    updated = true;
  }

  if (updated) {
    // Preserve any existing keys and add missing ones
    writeEnvFile(envPath, env);
    console.log('.env updated with generated secrets.');
  } else {
    console.log('Both PASSWORD_PEPPER and SESSION_SECRET already exist. No changes made.');
  }
}

main();
