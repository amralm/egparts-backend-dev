'use strict';

/**
 * ============================================================================
 * EG-PARTS CLOUD — MASTER E2E & CONTRACT VERIFICATION SUITE
 * ============================================================================
 * Runs automated contract assertions, schema validations, quota checks,
 * and lifecycle tests to guarantee Zero-Error platform stability.
 * ============================================================================
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('\n========================================================');
console.log('🚀 RUNNING EG-PARTS CLOUD ZERO-ERROR TEST SUITE');
console.log('========================================================\n');

// Load environment credentials for Dev DB testing if available
const env = { ...process.env };
const devDbUrl = 'postgres://postgres.ubkjyktgbxvzyuraapfl:eE7YmFwa4I0RWIyN@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
if (!env.SUPA_DEV_DB_URL) {
  env.SUPA_DEV_DB_URL = devDbUrl;
}

const testScripts = [
  { name: '1. Syntax & Code Integrity Check', file: 'syntax-check.js' },
  { name: '2. Unified Contract Smoke & Schema Assertions', file: 'contract-smoke.js' },
  { name: '3. Subscription Limits & Quota Reservation Binding', file: 'pg-test-quota-binding.js' }
];

let allPassed = true;

for (const test of testScripts) {
  process.stdout.write(`⏳ Running ${test.name}... `);
  const scriptPath = path.join(__dirname, test.file);
  const result = spawnSync('node', [scriptPath], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env
  });

  if (result.status === 0) {
    console.log('✅ PASS');
  } else {
    console.log('❌ FAIL');
    console.error(result.stderr || result.stdout);
    allPassed = false;
  }
}

console.log('\n========================================================');
if (allPassed) {
  console.log('🎉 ALL AUTOMATED CONTRACT & E2E TESTS PASSED (100%)');
  console.log('🛡️ ZERO CONTRACT REGRESSION DETECTED');
} else {
  console.log('⚠️ TEST FAILURES DETECTED — REVIEW DETAILS ABOVE');
}
console.log('========================================================\n');

process.exit(allPassed ? 0 : 1);
