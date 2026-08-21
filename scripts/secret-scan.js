const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.includes('node_modules/') && !file.includes('dist/'));

const serviceRoleMarker = 'InJvbGUiOiJ' + 'zZXJ2aWNlX3JvbGUi';
const rules = [
  { name: 'GitHub personal access token', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'private key', pattern: /-----BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY-----/g },
  { name: 'Supabase service-role JWT', pattern: new RegExp(serviceRoleMarker, 'g') },
  { name: 'inline R2 secret', pattern: /R2_SECRET_ACCESS_KEY\s*=\s*(?!process\.env|\$\{|[/(])[^\s$][^\r\n]*/g },
  { name: 'inline Turnstile secret', pattern: /TURNSTILE_SECRET_KEY\s*=\s*(?!process\.env|\$\{|[/(]|['"]mock_)[^\s$][^\r\n]*/g },
];

const findings = [];
for (const file of tracked) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const rule of rules) {
    if (rule.pattern.test(text)) findings.push(`${file}: ${rule.name}`);
    rule.pattern.lastIndex = 0;
  }
}

if (findings.length) {
  console.error('Secret scan failed:\n' + findings.join('\n'));
  process.exit(1);
}
console.log(`Secret scan passed (${tracked.length} tracked files checked).`);
