const PaymentIntent = require('../../modules/payments/entities/PaymentIntent');
const PaymentRegistry = require('../../modules/payments/providers/PaymentRegistry');
const ManualWalletProvider = require('../../modules/payments/providers/ManualWalletProvider');
const PaymobProvider = require('../../modules/payments/providers/PaymobProvider');
const crypto = require('crypto');

describe('Payment Domain Core & State Machine Tests', () => {
  describe('PaymentIntent Entity', () => {
    test('should construct a valid PaymentIntent and serialize to DB representation', () => {
      const intent = new PaymentIntent({
        id: 'intent-123',
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 15000,
        currency: 'EGP',
        provider: 'paymob',
        metadata: { custom_field: 'value' }
      });

      expect(intent.id).toBe('intent-123');
      expect(intent.status).toBe('created');
      expect(intent.currency).toBe('EGP');
      
      const dbObj = intent.toDatabase();
      expect(dbObj.store_id).toBe('store-456');
      expect(dbObj.order_id).toBe('order-789');
      expect(dbObj.amount_cents).toBe(15000);
      expect(dbObj.status).toBe('created');
      expect(dbObj.metadata.custom_field).toBe('value');
    });

    test('should throw validation errors on missing required construction params', () => {
      expect(() => new PaymentIntent({
        order_id: 'order-789',
        amount_cents: 15000,
        provider: 'paymob'
      })).toThrow('store_id is required');

      expect(() => new PaymentIntent({
        store_id: 'store-456',
        amount_cents: 15000,
        provider: 'paymob'
      })).toThrow('order_id is required');

      expect(() => new PaymentIntent({
        store_id: 'store-456',
        order_id: 'order-789',
        provider: 'paymob'
      })).toThrow('amount_cents must be a valid number');

      expect(() => new PaymentIntent({
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 15000
      })).toThrow('provider is required');
    });

    test('should transition states correctly in the happy path', () => {
      const intent = new PaymentIntent({
        id: 'intent-123',
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 15000,
        provider: 'paymob'
      });

      expect(intent.status).toBe('created');

      intent.transitionToProcessing();
      expect(intent.status).toBe('processing');

      intent.transitionToAuthorized();
      expect(intent.status).toBe('authorized');

      intent.transitionToCaptured();
      expect(intent.status).toBe('captured');
    });

    test('should allow transition to failed from processing or authorized', () => {
      const intentFailedFromProcessing = new PaymentIntent({
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 100,
        provider: 'paymob'
      });
      intentFailedFromProcessing.transitionToProcessing();
      intentFailedFromProcessing.transitionToFailed('Insufficient funds');
      expect(intentFailedFromProcessing.status).toBe('failed');
      expect(intentFailedFromProcessing.metadata.failure_reason).toBe('Insufficient funds');

      const intentFailedFromAuthorized = new PaymentIntent({
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 100,
        provider: 'paymob'
      });
      intentFailedFromAuthorized.transitionToProcessing();
      intentFailedFromAuthorized.transitionToAuthorized();
      intentFailedFromAuthorized.transitionToFailed('Risk check failed');
      expect(intentFailedFromAuthorized.status).toBe('failed');
      expect(intentFailedFromAuthorized.metadata.failure_reason).toBe('Risk check failed');
    });

    test('should allow cancellation from non-terminal states', () => {
      const intent = new PaymentIntent({
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 100,
        provider: 'paymob'
      });
      intent.transitionToCancelled();
      expect(intent.status).toBe('cancelled');
    });

    test('should prevent state transitions from terminal states', () => {
      const intent = new PaymentIntent({
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 100,
        provider: 'paymob'
      });
      intent.transitionToCancelled();

      expect(() => intent.transitionToProcessing()).toThrow('PaymentIntent is in terminal state: cancelled and cannot be modified');
      expect(() => intent.transitionToFailed('some reason')).toThrow('PaymentIntent is in terminal state: cancelled and cannot be modified');
    });

    test('should throw error on invalid transition steps', () => {
      const intent = new PaymentIntent({
        store_id: 'store-456',
        order_id: 'order-789',
        amount_cents: 100,
        provider: 'paymob'
      });

      expect(() => intent.transitionToAuthorized()).toThrow('Invalid state transition: created -> authorized');
      expect(() => intent.transitionToCaptured()).toThrow('Invalid state transition: created -> captured');
    });
  });

  describe('PaymentRegistry', () => {
    test('should contain default registered providers', () => {
      const list = PaymentRegistry.list();
      expect(list).toContain('paymob');
      expect(list).toContain('manual_wallet');
    });

    test('should fetch correct provider instances', () => {
      const paymob = PaymentRegistry.get('paymob');
      expect(paymob).toBeInstanceOf(PaymobProvider);

      const wallet = PaymentRegistry.get('manual_wallet');
      expect(wallet).toBeInstanceOf(ManualWalletProvider);
    });

    test('should throw when getting non-registered provider', () => {
      expect(() => PaymentRegistry.get('stripe')).toThrow('Provider not found: stripe');
    });
  });

  describe('ManualWalletProvider', () => {
    test('should return correct code', () => {
      const provider = new ManualWalletProvider();
      expect(provider.getCode()).toBe('manual_wallet');
    });

    test('should initiate manual wallet payment with store settings', async () => {
      const provider = new ManualWalletProvider();
      const intent = new PaymentIntent({
        id: 'my-intent-id',
        store_id: 'store-a',
        order_id: 'order-b',
        amount_cents: 500,
        provider: 'manual_wallet'
      });

      const storeSettings = {
        vodafone_cash_number: '01099999999',
        payment_screenshot_number: '201099999999'
      };

      const result = await provider.initiatePayment(intent, {}, storeSettings);
      expect(result.provider_reference).toBe('wallet_manual_my-intent-id');
      expect(result.payment_url).toContain('wallet=01099999999');
      expect(result.payment_url).toContain('screenshot=201099999999');
    });

    test('should fallback to defaults when store settings are missing', async () => {
      const provider = new ManualWalletProvider();
      const intent = new PaymentIntent({
        id: 'my-intent-id',
        store_id: 'store-a',
        order_id: 'order-b',
        amount_cents: 500,
        provider: 'manual_wallet'
      });

      const result = await provider.initiatePayment(intent, {}, {});
      expect(result.payment_url).toContain('wallet=01011192994');
      expect(result.payment_url).toContain('screenshot=201122551272');
    });
  });

  describe('PaymobProvider HMAC Verification', () => {
    test('should verify valid Paymob webhook payload correctly', async () => {
      const provider = new PaymobProvider();
      const storeSettings = { hmac_secret: 'my_secret_key' };

      const obj = {
        amount_cents: 1000,
        created_at: '2026-07-01T00:00:00Z',
        currency: 'EGP',
        error_occured: false,
        has_parent_transaction: false,
        id: 123456,
        integration_id: 998877,
        is_3d_secure: true,
        is_auth: false,
        is_capture: true,
        is_refunded: false,
        is_standalone_payment: true,
        is_voided: false,
        order: { id: 776655 },
        owner: 2211,
        pending: false,
        source_data: {
          pan: '1234',
          sub_type: 'card',
          type: 'visa'
        },
        success: true
      };

      const concatFields = [
        obj.amount_cents,
        obj.created_at,
        obj.currency,
        obj.error_occured,
        obj.has_parent_transaction,
        obj.id,
        obj.integration_id,
        obj.is_3d_secure,
        obj.is_auth,
        obj.is_capture,
        obj.is_refunded,
        obj.is_standalone_payment,
        obj.is_voided,
        obj.order?.id,
        obj.owner,
        obj.pending,
        obj.source_data?.pan,
        obj.source_data?.sub_type,
        obj.source_data?.type,
        obj.success
      ].map(v => String(v ?? ''));

      const computedHmac = crypto
        .createHmac('sha512', storeSettings.hmac_secret)
        .update(concatFields.join(''))
        .digest('hex');

      const payload = {
        hmac: computedHmac,
        obj: obj
      };

      const isValid = await provider.verifyWebhook(payload, {}, storeSettings);
      expect(isValid).toBe(true);
    });

    test('should reject payload with invalid hmac', async () => {
      const provider = new PaymobProvider();
      const storeSettings = { hmac_secret: 'my_secret_key' };

      const payload = {
        hmac: 'incorrect_hmac_value_here',
        obj: {
          amount_cents: 100,
          success: true
        }
      };

      const isValid = await provider.verifyWebhook(payload, {}, storeSettings);
      expect(isValid).toBe(false);
    });
  });
});
