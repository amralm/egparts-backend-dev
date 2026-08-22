'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [];
for (const dir of ['routes', 'middleware', 'services', 'schemas', 'utils']) {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) continue;
  for (const file of fs.readdirSync(base)) {
    if (file.endsWith('.js')) files.push(path.join(base, file));
  }
}
files.push(path.join(root, 'server.js'));

const failures = files.filter((file) => {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return result.status !== 0;
});

if (failures.length) {
  console.error(`Syntax check failed for ${failures.length} files:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Syntax check passed (${files.length} runtime files).`);
