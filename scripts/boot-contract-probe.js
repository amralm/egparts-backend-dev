'use strict';
// Boot + contract probe: starts the real server as a child process against the
// configured environment, waits for liveness, asserts the canonical response
// contract on core public endpoints, then terminates it.
//
// Usage: node scripts/boot-contract-probe.js [--port 5599]
// Exit code 0 = all probes passed.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? Number(process.argv[i + 1]) : 5599;
})();
const BASE = `http://localhost:${PORT}`;
const LOG_FILE = path.join(require('os').tmpdir(), `egparts-boot-${PORT}.log`);

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await request('GET', '/api/health');
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
}

const results = [];
const assert = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
};

function parseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')]
  });
  console.log(`server pid=${child.pid} log=${LOG_FILE}`);

  const up = await waitForHealth();
  if (!up) {
    console.error('Server did not become healthy in time.');
    child.kill('SIGKILL');
    process.exit(1);
  }

  try {
    // 1) Health carries the canonical envelope.
    const health = parseJson((await request('GET', '/api/health')).body);
    assert('health envelope has code/message/requestId/data',
      !!health && health.success === true && typeof health.code === 'string'
        && typeof health.message === 'string' && 'requestId' in health && 'data' in health);

    // 2) Unknown route answers canonically.
    const missing = await request('GET', '/api/__probe_nonexistent__');
    const missingBody = parseJson(missing.body);
    assert('unknown route 404 canonical',
      missing.status === 404 && missingBody?.success === false
        && typeof missingBody.code === 'string' && missingBody.requestId,
      `status=${missing.status}`);

    // 3) Wrong content types are rejected before auth (415 family).
    const xmlProbe = await request('POST', '/api/account/addresses', {
      headers: { 'content-type': 'application/xml', 'x-store-subdomain': 'egparts' },
      body: '{"t":1}'
    });
    assert('xml body rejected 415', xmlProbe.status === 415, `status=${xmlProbe.status}`);

    const textProbe = await request('POST', '/api/account/addresses', {
      headers: { 'content-type': 'text/plain', 'x-store-subdomain': 'egparts' },
      body: '{"title":"probe"}'
    });
    assert('text/plain JSON body rejected 415', textProbe.status === 415, `status=${textProbe.status}`);

    // 4) Anonymous mutations are refused canonically.
    const anonOrder = await request('POST', '/api/orders', {
      headers: {
        'content-type': 'application/json',
        'x-store-subdomain': 'egparts',
        'x-request-id': `probe_${Date.now()}`
      },
      body: JSON.stringify({ items: [], paymentMethod: 'cod', idempotencyKey: `probe-${Date.now()}` })
    });
    const anonBody = parseJson(anonOrder.body);
    assert('anonymous order 401 canonical',
      anonOrder.status === 401 && anonBody?.success === false
        && typeof anonBody.requestId === 'string' && anonBody.data === null,
      `status=${anonOrder.status}`);

    // 5) Public storefront endpoints keep their business contract.
    const methods = parseJson((await request('GET', '/api/payments/methods', {
      headers: { 'x-store-subdomain': 'egparts' }
    })).body);
    const methodIds = (methods?.data?.methods || methods?.methods || []).map((m) => m.id);
    assert('payment methods envelope + ids',
      methods?.success === true && Array.isArray(methodIds)
        && methodIds.every((id) => ['cod', 'card', 'manual_wallet'].includes(id)),
      `ids=${JSON.stringify(methodIds)}`);
  } finally {
    child.kill('SIGKILL');
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\nBOOT PROBE RESULT: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('probe crashed:', err.message);
  process.exit(1);
});
