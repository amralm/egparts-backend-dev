const PaymentProviderInterface = require('../contracts/PaymentProviderInterface');
const axios = require('axios');
const crypto = require('crypto');

/**
 * PaymobProvider
 * Implements the payment provider interface for the Paymob payment gateway.
 */
class PaymobProvider extends PaymentProviderInterface {
  constructor() {
    super();
    this.client = axios.create({ timeout: 10000 });
  }

  getCode() {
    return 'paymob';
  }

  /**
   * Initiates payment via Paymob APIs.
   * Steps:
   * 1. Authenticate to get a token.
   * 2. Register an order.
   * 3. Generate a payment key.
   */
  async initiatePayment(intent, customerData = {}, storeSettings = {}) {
    const { api_key, integration_id, iframe_id } = storeSettings;
    if (!api_key || !integration_id || !iframe_id) {
      throw new Error('Paymob credentials are not configured');
    }

    // Step 1: Authentication
    const authRes = await this.client.post('https://accept.paymob.com/api/auth/tokens', {
      api_key
    });
    const token = authRes.data.token;

    // Step 2: Order Registration
    const orderRes = await this.client.post('https://accept.paymob.com/api/ecommerce/orders', {
      auth_token: token,
      delivery_needed: false,
      amount_cents: intent.amount_cents,
      currency: intent.currency || 'EGP',
      items: []
    });
    const orderId = orderRes.data.id;

    // Split customer name safely
    const name = customerData.name || '';
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || 'User';

    // Step 3: Payment Key Generation
    const keyRes = await this.client.post('https://accept.paymob.com/api/acceptance/payment_keys', {
      auth_token: token,
      amount_cents: intent.amount_cents,
      expiration: 3600,
      order_id: orderId,
      billing_data: {
        first_name: firstName,
        last_name: lastName,
        email: customerData.email || 'customer@egparts.com',
        phone_number: customerData.phone || 'NA',
        apartment: 'NA',
        floor: 'NA',
        street: customerData.address || 'NA',
        building: 'NA',
        shipping_method: 'NA',
        postal_code: 'NA',
        city: customerData.city || 'Cairo',
        country: 'EG',
        state: 'NA'
      },
      currency: intent.currency || 'EGP',
      integration_id: String(integration_id)
    });

    return {
      payment_url: `https://accept.paymob.com/api/acceptance/iframes/${iframe_id}?payment_token=${keyRes.data.token}`,
      provider_reference: String(orderId)
    };
  }

  /**
   * Verifies Webhook HMAC from Paymob.
   * Compares timingSafeEqual computed HMAC from specific fields against req.body.hmac.
   */
  async verifyWebhook(payload = {}, headers = {}, storeSettings = {}) {
    const receivedHmac = payload.hmac;
    const obj = payload.obj;
    const hmacSecret = storeSettings.hmac_secret;

    if (!receivedHmac || !obj || !hmacSecret) {
      return false;
    }

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
      .createHmac('sha512', hmacSecret)
      .update(concatFields.join(''))
      .digest('hex');

    if (computedHmac.length !== receivedHmac.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(computedHmac, 'hex'),
      Buffer.from(receivedHmac, 'hex')
    );
  }

  async capture(providerReference, amountCents, storeSettings) {
    // Paymob transactions can be automatically captured depending on integration type.
    // Return a mocked success for capturing.
    return {
      status: 'captured',
      transaction_id: providerReference
    };
  }

  async refund(providerReference, amountCents, storeSettings) {
    // In a production app, this would hit Paymob's refund endpoint.
    // For now, return the refunded status.
    return {
      status: 'refunded',
      transaction_id: providerReference
    };
  }
}

module.exports = PaymobProvider;
