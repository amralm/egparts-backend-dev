const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  'server.js',
  ...fs.readdirSync(path.join(root, 'routes'))
    .filter((file) => file.endsWith('.js') && !file.endsWith('.bak'))
    .map((file) => path.join('routes', file)),
  ...fs.readdirSync(path.join(root, 'services'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join('services', file))
];

const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const forbiddenContracts = [
  ['process_secure_checkout_v2', 'removed checkout RPC'],
  ['feature_usage.used', 'removed feature_usage.used column'],
  ['otp.whatsapp.monthly', 'removed legacy OTP feature key'],
  ['main_whatsapp_session', 'legacy singleton session in active runtime'],
  ["supabase.from('feature_usage').select('used')", 'removed feature_usage.used select'],
  ['routes/platform.js.bak', 'backup route file referenced by runtime'],
  ['req.query.search.trim().slice(0, 80).replace(/[,*().]/g', 'unhardened PostgREST search sanitizer']
];

const failures = forbiddenContracts
  .filter(([needle]) => source.includes(needle))
  .map(([, description]) => description);

if (failures.length) {
  console.error('Contract audit failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log(`Contract audit passed (${files.length} active runtime files checked).`);
