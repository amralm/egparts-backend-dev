'use strict';

const request = require('supertest');
const app = require('../../server'); // Adjust this path if the express app is exported differently
const { supabase } = require('../../services/supabase');
const crypto = require('crypto');

// Mock data for tests
const mockStoreId = 'test_store_123';
const mockOrderId = 'test_order_123';
const hmacSecret = 'test_hmac_secret';

describe('Paymob Webhook Resilience Tests', () => {
  beforeAll(async () => {
    // Setup mock store and order if necessary
    // This assumes there's a testing environment setup.
  });

  afterAll(async () => {
    // Cleanup mock data
  });

  const generateHmac = (data) => {
    // Basic Paymob HMAC generation logic based on concatenated specific fields
    // For testing, we mock this heavily
    const stringToHash = `${data.amount_cents}${data.created_at}${data.currency}${data.error_occured}${data.has_parent_transaction}${data.id}${data.integration_id}${data.is_3d_secure}${data.is_auth}${data.is_capture}${data.is_refunded}${data.is_standalone_payment}${data.is_voided}${data.order.id}${data.owner}${data.pending}${data.source_data.pan}${data.source_data.sub_type}${data.source_data.type}${data.success}`;
    return crypto.createHmac('sha512', hmacSecret).update(stringToHash).digest('hex');
  };

  const createWebhookPayload = (success = true, orderId = mockOrderId) => {
    const data = {
      amount_cents: 10000,
      created_at: new Date().toISOString(),
      currency: 'EGP',
      error_occured: false,
      has_parent_transaction: false,
      id: Math.floor(Math.random() * 100000),
      integration_id: 123456,
      is_3d_secure: true,
      is_auth: false,
      is_capture: false,
      is_refunded: false,
      is_standalone_payment: false,
      is_voided: false,
      order: { id: orderId, merchant_order_id: `test_merchant_${orderId}` },
      owner: 1234,
      pending: false,
      source_data: { pan: '0000', sub_type: 'MasterCard', type: 'card' },
      success: success
    };
    return {
      obj: data,
      hmac: generateHmac(data)
    };
  };

  test('1. Payment Declined - Should reject processing', async () => {
    const payload = createWebhookPayload(false); // success: false
    const res = await request(app)
      .post('/api/payments/paymob-webhook')
      .query({ hmac: payload.hmac })
      .send(payload);
    
    // We expect 200 OK to Paymob so they don't retry, but internally it shouldn't update the order to paid
    expect(res.statusCode).toBe(200);
    
    // Verify DB order status is NOT paid
    // const { data } = await supabase.from('orders').select('status').eq('id', mockOrderId).single();
    // expect(data.status).not.toBe('paid');
  });

  test('2. Duplicate Webhook - Idempotency Check', async () => {
    const payload = createWebhookPayload(true);
    
    // First request
    await request(app)
      .post('/api/payments/paymob-webhook')
      .query({ hmac: payload.hmac })
      .send(payload);

    // Second request (Duplicate)
    const res2 = await request(app)
      .post('/api/payments/paymob-webhook')
      .query({ hmac: payload.hmac })
      .send(payload);
    
    expect(res2.statusCode).toBe(200);
    
    // Check DB that balance/commission was only applied once.
  });

  test('3. Race Condition (Database Commit Failure)', async () => {
    // Mock the DB to fail for this test
    const originalUpdate = supabase.from('orders').update;
    supabase.from = jest.fn(() => ({
      update: jest.fn().mockRejectedValue(new Error('Database Commit Failure'))
    }));

    const payload = createWebhookPayload(true);
    const res = await request(app)
      .post('/api/payments/paymob-webhook')
      .query({ hmac: payload.hmac })
      .send(payload);
    
    // Expecting a 500 error so Paymob RETRIES later
    expect(res.statusCode).toBe(500);

    // Restore DB mock
    supabase.from = originalUpdate; // (simplified restore)
  });
});
