'use strict';
// Run a Playwright spec against a locally-booted backend server.
// Usage: node scripts/local-e2e.js [--port 5599] [--grep "public API contracts"] [--spec e2e/public-contract.spec.js]
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const PORT = Number(arg('--port', 5599));
const GREP = arg('--grep', 'public API contracts');
const SPEC = arg('--spec', 'e2e/public-contract.spec.js');
const BASE = `http://localhost:${PORT}`;

function waitForHealth(timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await new Promise((res2, rej2) => {
          const req = http.get(`${BASE}/api/health`, { timeout: 4000 }, res2);
          req.on('error', rej2);
          req.on('timeout', () => req.destroy(new Error('timeout')));
        });
        if (res.statusCode === 200) return resolve(true);
      } catch { /* retry */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('server not healthy in time'));
      setTimeout(tick, 1200);
    };
    tick();
  });
}

async function main() {
  const log = fs.openSync(path.join(require('os').tmpdir(), `egparts-local-e2e-${PORT}.log`), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', log, log]
  });
  console.log(`booting server pid=${child.pid} on :${PORT}`);
  let exited = false;
  child.on('exit', () => { exited = true; });

  try {
    await waitForHealth();
    console.log('server healthy — running playwright');
    const r = spawnSync('npx', ['playwright', 'test', SPEC, '--grep', GREP, '--reporter=list'], {
      cwd: path.resolve(__dirname, '..', '..', 'frontend'),
      env: { ...process.env, E2E_BACKEND_URL: BASE, E2E_BASE_URL: 'http://localhost:4173' },
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    console.log(`playwright exit=${r.status}`);
    process.exitCode = r.status ?? 1;
  } finally {
    if (!exited) child.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
