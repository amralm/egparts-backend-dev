'use strict';
// Boot check: require() every active runtime file so require-time ReferenceErrors,
// bad imports, and circular-dependency crashes surface BEFORE deploy.
// node --check (lint) cannot catch these; a real boot does.
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const dirs = ['routes', 'middleware', 'services', 'utils', 'schemas'];
// server.js is intentionally excluded: requiring it boots the HTTP server,
// starts cron jobs, and never exits. It is covered by a real `npm start`
// smoke test / deploy health check instead.
const files = [];

for (const dir of dirs) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (f.endsWith('.js') && !f.endsWith('.bak')) files.push(path.join(dir, f));
  }
}

let failures = 0;
for (const file of files) {
  try {
    require(path.join(root, file));
  } catch (err) {
    failures += 1;
    console.error(`BOOT FAIL ${file}: ${err.message}`);
  }
}

if (failures) {
  console.error(`Boot check failed (${failures} of ${files.length} files)`);
  process.exit(1);
}
console.log(`Boot check passed (${files.length} runtime files required cleanly).`);
