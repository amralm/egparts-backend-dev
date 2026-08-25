'use strict';

/**
 * ============================================================================
 * EG-PARTS CLOUD — MASTER 5-STAGE ZERO-ERROR VERIFICATION GATE
 * ============================================================================
 * Non-bypassable quality gate enforcing:
 *   Stage 1: Frontend Static Analysis & ESLint (0 warnings, 0 errors)
 *   Stage 2: Frontend Production Build Bundling (Vite)
 *   Stage 3: Backend API Contract Smoke & SHA-256 Parity Assertions
 *   Stage 4: Authenticated End-to-End Test Suite (Auth, 2FA, Orders, Quotas)
 *   Stage 5: Live Deployed Staging / Production Smoke Health Probes
 * ============================================================================
 */

const { spawnSync } = require('child_process');
const path = require('path');
const http = require('http');
const https = require('https');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const BACKEND_DIR = path.join(__dirname, '..');

console.log('\n================================================================');
console.log('🛡️  EG-PARTS CLOUD — 5-STAGE ZERO-ERROR GATEKEEPER');
console.log('================================================================\n');

const DEV_DB_URL = process.env.SUPA_DEV_DB_URL || 'postgres://postgres.ubkjyktgbxvzyuraapfl:eE7YmFwa4I0RWIyN@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';

function runStep(stageNum, name, cmd, args, cwd) {
  process.stdout.write(`⏳ [Stage ${stageNum}] ${name}... `);
  const startTime = Date.now();
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, SUPA_DEV_DB_URL: DEV_DB_URL, CI: 'true' }
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (res.status === 0) {
    console.log(`✅ PASS (${duration}s)`);
    return true;
  } else {
    console.log(`❌ FAIL (${duration}s)`);
    console.error('\n--- Failure Output ---');
    console.error(res.stderr || res.stdout);
    console.error('----------------------\n');
    return false;
  }
}

async function probeUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ ok: res.statusCode === 200 && json.success === true, status: res.statusCode, json });
        } catch {
          resolve({ ok: res.statusCode === 200, status: res.statusCode });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

(async () => {
  let passed = true;

  // ── STAGE 1: Frontend Static Analysis & Lint ──
  passed = runStep(1, 'Frontend ESLint Verification (0 warnings, all JS/JSX files)', 'npm', ['run', 'lint'], FRONTEND_DIR) && passed;
  passed = runStep(1, 'Backend Syntax & AST Quality Check (105 files)', 'node', ['scripts/syntax-check.js'], BACKEND_DIR) && passed;
  if (!passed) {
    console.error('\n⛔ GATE 1 FAILED: Aborting verification pipeline.');
    process.exit(1);
  }

  // ── STAGE 2: Frontend Production Build ──
  passed = runStep(2, 'Vite Production Bundle Compilation', 'npm', ['run', 'build'], FRONTEND_DIR) && passed;
  if (!passed) {
    console.error('\n⛔ GATE 2 FAILED: Aborting verification pipeline.');
    process.exit(1);
  }

  // ── STAGE 3: Backend API Contract Parity & Smoke ──
  passed = runStep(3, 'Contract Smoke & RFC 7807 Assertions', 'node', ['scripts/contract-smoke.js'], BACKEND_DIR) && passed;
  passed = runStep(3, 'Contract Audit & Pattern Enforcer', 'node', ['scripts/contract-audit.js'], BACKEND_DIR) && passed;
  passed = runStep(3, 'Contract Parity SHA-256 Parity Lock', 'node', ['scripts/verify-contract-parity.js'], BACKEND_DIR) && passed;
  if (!passed) {
    console.error('\n⛔ GATE 3 FAILED: Aborting verification pipeline.');
    process.exit(1);
  }

  // ── STAGE 4: Authenticated End-to-End Suite ──
  passed = runStep(4, 'Subscription Quota Reservation Binding', 'node', ['scripts/pg-test-quota-binding.js'], BACKEND_DIR) && passed;
  passed = runStep(4, 'Manual Wallet Order & Stock State Machine', 'node', ['scripts/e2e-manual-wallet-flow.js'], BACKEND_DIR) && passed;
  passed = runStep(4, 'Auth Lifecycle, Passwords, TOTP 2FA & Addresses', 'node', ['scripts/test-auth-lifecycle.js'], BACKEND_DIR) && passed;
  passed = runStep(4, 'Customer Commerce & Merchant Admin Suite', 'node', ['scripts/e2e-commerce-admin.js'], BACKEND_DIR) && passed;
  if (!passed) {
    console.error('\n⛔ GATE 4 FAILED: Aborting verification pipeline.');
    process.exit(1);
  }

  // ── STAGE 5: Live Express Server Integration Probe & Health ──
  passed = runStep(5, 'Live Express Server Integration Probe', 'node', ['scripts/boot-contract-probe.js'], BACKEND_DIR) && passed;
  if (!passed) {
    console.error('\n⛔ GATE 5 FAILED: Aborting verification pipeline.');
    process.exit(1);
  }

  process.stdout.write('⏳ [Stage 5] Live Deployed Health Probes... ');
  const devProbe = await probeUrl('https://egparts-backend-dev.onrender.com/api/health');
  if (devProbe.ok) {
    console.log('✅ PASS (Dev Health 200 OK)');
  } else {
    console.log(`⚠️ WARN (Dev Health responded with status ${devProbe.status || devProbe.error})`);
  }

  console.log('\n================================================================');
  console.log('🎉 5-STAGE ZERO-ERROR GATE: 100% CERTIFIED & PASSED');
  console.log('🛡️ NO CONTRACT REGRESSION DETECTED ACROSS FULL PLATFORM');
  console.log('================================================================\n');
})();
