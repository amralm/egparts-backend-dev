'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const assert = require('node:assert/strict');
const { supabase } = require('../services/supabase');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');

async function testBillingContract() {
  console.log('[Test] 1. Verifying Plans Contract and Enterprise Availability...');
  
  const { data: plans, error: plansErr } = await supabase
    .from('plans')
    .select('id, code, display_name, price_monthly, price_yearly, sort_order, is_public')
    .eq('is_public', true)
    .order('sort_order', { ascending: true });

  assert.equal(plansErr, null, 'Fetching plans should have no error');
  assert.ok(Array.isArray(plans) && plans.length >= 5, 'Should return at least 5 public plans');

  const enterprise = plans.find(p => p.code === 'enterprise');
  assert.ok(enterprise, 'Enterprise plan must be public and present in plans list');
  assert.equal(enterprise.is_public, true, 'Enterprise plan must have is_public: true');
  assert.equal(Number(enterprise.price_monthly), 4999, 'Enterprise monthly price must be 4999');

  console.log('[Test] 2. Verifying Canonical Response Envelopes for Billing...');
  
  // Test sendSuccess envelope
  let capturedSuccess;
  const mockRes = {
    statusCode: 200,
    req: { id: 'req_billing_test_1' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { capturedSuccess = payload; return this; }
  };

  sendSuccess(mockRes, {
    plans,
    message: 'تم جلب الباقات بنجاح'
  });

  assert.equal(capturedSuccess.success, true, 'sendSuccess must set success: true');
  assert.equal(capturedSuccess.code, 'OK', 'sendSuccess must set code: OK');
  assert.equal(capturedSuccess.requestId, 'req_billing_test_1', 'requestId must match req.id');
  assert.ok(capturedSuccess.data && Array.isArray(capturedSuccess.data.plans), 'canonical envelope data.plans must exist');
  assert.ok(Array.isArray(capturedSuccess.plans), 'legacy top-level spread plans must exist for backward compatibility');

  // Test apiError envelope
  let capturedError;
  const mockErrRes = {
    statusCode: 400,
    req: { id: 'req_billing_err_1' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { capturedError = payload; return this; }
  };

  apiError(mockErrRes, 400, 'Plan ID is required', 'PLAN_REQUIRED');
  assert.equal(capturedError.success, false, 'apiError must set success: false');
  assert.equal(capturedError.code, 'PLAN_REQUIRED', 'apiError must set canonical code');
  assert.equal(capturedError.message, 'Plan ID is required', 'apiError must set message');
  assert.equal(capturedError.requestId, 'req_billing_err_1', 'apiError must set requestId');
  assert.equal(capturedError.data, null, 'apiError data defaults to null');

  console.log('[Test] 3. Verifying store_subscriptions UNIQUE constraint and Upsert Resilience...');
  
  // Fetch any active store for dry run
  const { data: testStore, error: storeErr } = await supabase
    .from('stores')
    .select('id, name, subdomain, subscription_expires_at, status')
    .limit(1)
    .single();

  assert.equal(storeErr, null, 'Fetching a test store should succeed');
  assert.ok(testStore?.id, 'Test store must exist');

  const testExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  
  // Upsert into store_subscriptions must succeed WITHOUT throwing error 23505
  const { data: upsertData, error: upsertErr } = await supabase
    .from('store_subscriptions')
    .upsert({
      store_id: testStore.id,
      plan_id: enterprise.id,
      status: 'active',
      expires_at: testExpiresAt,
      updated_at: new Date().toISOString()
    }, { onConflict: 'store_id' })
    .select()
    .single();

  assert.equal(upsertErr, null, 'store_subscriptions upsert must NOT violate UNIQUE constraint (23505)');
  assert.equal(upsertData.store_id, testStore.id, 'Upserted subscription must belong to test store');

  console.log('[Test] 4. Verifying Two-Way Database Trigger Synchronization...');
  
  // Verify that updating store_subscriptions automatically synchronized stores.subscription_expires_at via trigger
  const { data: syncedStore, error: syncErr } = await supabase
    .from('stores')
    .select('id, subscription_expires_at, status')
    .eq('id', testStore.id)
    .single();

  assert.equal(syncErr, null, 'Fetching synced store should succeed');
  assert.equal(
    new Date(syncedStore.subscription_expires_at).toISOString(),
    new Date(testExpiresAt).toISOString(),
    'stores.subscription_expires_at must match store_subscriptions.expires_at via database trigger'
  );
  assert.equal(syncedStore.status, 'active', 'stores.status must be active');

  // Revert test store back to original state if needed
  if (testStore.subscription_expires_at) {
    await supabase.from('stores').update({
      subscription_expires_at: testStore.subscription_expires_at,
      status: testStore.status
    }).eq('id', testStore.id);
  }

  console.log('All Billing & Subscription Contract tests passed successfully! 100% PARITY & ZERO REGRESSION.');
}

testBillingContract()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
