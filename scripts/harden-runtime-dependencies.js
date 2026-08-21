const fs = require('fs');
const path = require('path');

// libsignal 6.0.0 logs the complete Signal session object, including key
// material, when closing a session. Patch the installed dependency at build
// time because this code runs inside node_modules and is not part of our repo.
const targets = [
  path.join(__dirname, '..', 'node_modules', 'libsignal', 'src', 'session_record.js'),
  path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'libsignal-node', 'src', 'session_record.js')
];

for (const file of targets) {
  if (!fs.existsSync(file)) continue;

  const source = fs.readFileSync(file, 'utf8');
  const patched = source
    .replace(/console\.info\(\s*["'](?:Closing session|Opening session):["']\s*,\s*session\s*\);?/g, "// Sensitive session material intentionally never logged.")
    .replace(/console\.info\(\s*["']Removing old closed session:["']\s*,\s*oldestSession\s*\);?/g, "// Sensitive session material intentionally never logged.");

  if (patched !== source) {
    fs.writeFileSync(file, patched);
    console.log(`[security] Redacted sensitive libsignal session logging: ${path.relative(process.cwd(), file)}`);
  }
}
