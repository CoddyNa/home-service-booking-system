require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
if (process.env.DATABASE_TARGET === 'local' && process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });
}
const http = require('http');
const app = require('./app');

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const backupService = require('./services/backupService');
backupService.recoverInterruptedOperations()
  .catch((error) => console.error('Could not recover backup operation state:', backupService.safeError(error)))
  .finally(() => server.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`)));
