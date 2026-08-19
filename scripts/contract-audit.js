const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  'server.js',
  'routes/orders.js',
  'routes/limits.js',
  'routes/platform.js',
  'routes/account.js',
  'services/accountService.js',
  'services/policyEngine.js',
  'services/whatsappPoolService.js'
];

const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const forbiddenContracts = [
  ['process_secure_checkout_v2', 'removed checkout RPC'],
  ['feature_usage.used', 'removed feature_usage.used column'],
  ['otp.whatsapp.monthly', 'removed legacy OTP feature key'],
  ['main_whatsapp_session', 'legacy singleton session in active runtime']
];

const failures = forbiddenContracts
  .filter(([needle]) => source.includes(needle))
  .map(([, description]) => description);

if (failures.length) {
  console.error('Contract audit failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log(`Contract audit passed (${files.length} active runtime files checked).`);
