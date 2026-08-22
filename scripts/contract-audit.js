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

const middlewareFiles = fs.readdirSync(path.join(root, 'middleware'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => path.join('middleware', file));
files.push(...middlewareFiles);

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

// Parse response object literals instead of checking only one line. This catches
// the exact failure mode that previously escaped review: multiline `{ error }`
// responses hidden inside otherwise valid routes. Logging/query variables named
// `error` are allowed; only an error key inside a res.json object is forbidden.
function findLegacyResponseObjects(text) {
  const hits = [];
  const startPattern = /res\.(?:status\([^)]*\)\.)?json\(\{/g;
  let match;
  while ((match = startPattern.exec(text))) {
    const objectStart = match.index + match[0].length - 1;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let end = objectStart;
    for (; end < text.length; end += 1) {
      const ch = text[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth += 1;
      if (ch === '}' && --depth === 0) break;
    }
    const body = text.slice(objectStart, end + 1);
    if (/\berror\s*:/.test(body)) hits.push(body.slice(0, 180));
    startPattern.lastIndex = Math.max(startPattern.lastIndex, end + 1);
  }
  return hits;
}

const legacyErrorResponses = findLegacyResponseObjects(source);
if (legacyErrorResponses.length) {
  failures.push(`legacy error response objects (${legacyErrorResponses.length})`);
}

if (/message\s*:\s*\{\s*error\s*:/.test(source)) {
  failures.push('legacy rate-limit message objects');
}

// Envelope enforcement: every /api JSON response must be sent through
// sendSuccess()/apiError(). Raw res.json() is allowed only in middleware that
// builds the canonical envelope themselves or the compatibility shim.
const envelopeAllowedMiddleware = new Set([
  'errorHandler.js',
  'apiNotFound.js',
  'responseContract.js'
]);
function findRawJsonSenders() {
  const hits = [];
  const rawPattern = /res\.(?:status\([^)]*\)\.)?json\(/g;
  for (const file of files) {
    if (file.startsWith('middleware') && envelopeAllowedMiddleware.has(path.basename(file))) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    let match;
    while ((match = rawPattern.exec(text))) {
      const line = text.slice(0, match.index).split('\n').length;
      hits.push(`${file}:${line}`);
    }
  }
  return hits;
}

const rawJsonSenders = findRawJsonSenders();
if (rawJsonSenders.length) {
  failures.push(
    `raw res.json() senders bypassing the response contract (${rawJsonSenders.length}): ${rawJsonSenders.join(', ')}`
  );
}

if (failures.length) {
  console.error('Contract audit failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log(`Contract audit passed (${files.length} active runtime files checked).`);
