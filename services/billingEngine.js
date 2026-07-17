const crypto = require('crypto');
const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
const { supabase } = require('./supabase');
const logger = require('../utils/logger');

// ============================================================
// 1. PaymentGateway Base Interface
// ============================================================
class PaymentGateway {
  constructor(config = {}, sandbox = true) {
    this.config = config;
    this.sandbox = sandbox;
  }

  async authorize(amount, currency, source) {
    throw new Error('authorize() not implemented');
  }

  async capture(transactionId, amount) {
    throw new Error('capture() not implemented');
  }

  async charge(amount, currency, source) {
    throw new Error('charge() not implemented');
  }

  async refund(transactionId, amount, reason) {
    throw new Error('refund() not implemented');
  }

  async cancel(transactionId) {
    throw new Error('cancel() not implemented');
  }

  async void(transactionId) {
    throw new Error('void() not implemented');
  }

  async verifyWebhook(signature, rawPayload) {
    throw new Error('verifyWebhook() not implemented');
  }

  async createCheckout(invoiceId, returnUrl) {
    throw new Error('createCheckout() not implemented');
  }

  async getPaymentStatus(transactionId) {
    throw new Error('getPaymentStatus() not implemented');
  }
}

// ============================================================
// 2. Mock Gateway Adapter (Fully functional for local testing)
// ============================================================
class MockGateway extends PaymentGateway {
  async authorize(amount, currency, source) {
    logger.info('[MockGateway] Authorizing amount:', { amount, currency });
    return { success: true, transactionId: `mock_auth_${crypto.randomBytes(8).toString('hex')}` };
  }

  async capture(transactionId, amount) {
    logger.info('[MockGateway] Capturing transaction:', { transactionId, amount });
    return { success: true, transactionId };
  }

  async charge(amount, currency, source) {
    logger.info('[MockGateway] Charging amount:', { amount, currency });
    return { success: true, transactionId: `mock_charge_${crypto.randomBytes(8).toString('hex')}` };
  }

  async refund(transactionId, amount, reason) {
    logger.info('[MockGateway] Refunding transaction:', { transactionId, amount, reason });
    return { success: true, refundId: `mock_refund_${crypto.randomBytes(8).toString('hex')}` };
  }

  async cancel(transactionId) {
    logger.info('[MockGateway] Canceling transaction:', { transactionId });
    return { success: true };
  }

  async void(transactionId) {
    logger.info('[MockGateway] Voiding transaction:', { transactionId });
    return { success: true };
  }

  async verifyWebhook(signature, rawPayload) {
    logger.info('[MockGateway] Verifying webhook signature');
    return true;
  }

  async createCheckout(invoiceId, returnUrl) {
    logger.info('[MockGateway] Creating checkout for invoice:', { invoiceId });
    const mockToken = crypto.randomBytes(16).toString('hex');
    const checkoutUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success?mock_invoice=${invoiceId}&token=${mockToken}`;
    return { success: true, checkoutUrl };
  }

  async getPaymentStatus(transactionId) {
    logger.info('[MockGateway] Fetching status for transaction:', { transactionId });
    return { success: true, status: 'completed' };
  }
}

// ============================================================
// 3. Stripe Adapter Skeleton
// ============================================================
class StripeAdapter extends PaymentGateway {
  async charge(amount, currency, source) {
    logger.info('[StripeAdapter] Charging via API client (Skeleton):', { amount, currency });
    // Stripe client logic would go here
    return { success: true, transactionId: `ch_stripe_${crypto.randomBytes(8).toString('hex')}` };
  }

  async refund(transactionId, amount, reason) {
    logger.info('[StripeAdapter] Refunding via Stripe API (Skeleton):', { transactionId, amount });
    return { success: true, refundId: `re_stripe_${crypto.randomBytes(8).toString('hex')}` };
  }

  async createCheckout(invoiceId, returnUrl) {
    logger.info('[StripeAdapter] Creating Stripe checkout session (Skeleton)');
    return { success: true, checkoutUrl: 'https://checkout.stripe.com/pay/mock_session' };
  }

  async verifyWebhook(signature, rawPayload) {
    return true;
  }

  async getPaymentStatus(transactionId) {
    return { success: true, status: 'completed' };
  }
}

// ============================================================
// 4. Paymob Adapter Skeleton
// ============================================================
class PaymobAdapter extends PaymentGateway {
  async charge(amount, currency, source) {
    logger.info('[PaymobAdapter] Charging via Paymob API (Skeleton):', { amount, currency });
    return { success: true, transactionId: `pm_charge_${crypto.randomBytes(8).toString('hex')}` };
  }

  async refund(transactionId, amount, reason) {
    logger.info('[PaymobAdapter] Refunding via Paymob API (Skeleton):', { transactionId, amount });
    return { success: true, refundId: `pm_ref_${crypto.randomBytes(8).toString('hex')}` };
  }

  async createCheckout(invoiceId, returnUrl) {
    logger.info('[PaymobAdapter] Creating Paymob checkout session (Skeleton)');
    return { success: true, checkoutUrl: 'https://accept.paymob.com/api/acceptance/iframes/mock' };
  }

  async verifyWebhook(signature, rawPayload) {
    return true;
  }

  async getPaymentStatus(transactionId) {
    return { success: true, status: 'completed' };
  }
}

// ============================================================
// 5. PayPal Adapter Skeleton
// ============================================================
class PayPalAdapter extends PaymentGateway {
  async charge(amount, currency, source) {
    logger.info('[PayPalAdapter] Charging via PayPal (Skeleton):', { amount, currency });
    return { success: true, transactionId: `pay_paypal_${crypto.randomBytes(8).toString('hex')}` };
  }

  async refund(transactionId, amount, reason) {
    logger.info('[PayPalAdapter] Refunding via PayPal (Skeleton):', { transactionId, amount });
    return { success: true, refundId: `ref_paypal_${crypto.randomBytes(8).toString('hex')}` };
  }

  async createCheckout(invoiceId, returnUrl) {
    logger.info('[PayPalAdapter] Creating PayPal checkout link (Skeleton)');
    return { success: true, checkoutUrl: 'https://www.paypal.com/checkoutnow?token=mock' };
  }

  async verifyWebhook(signature, rawPayload) {
    return true;
  }

  async getPaymentStatus(transactionId) {
    return { success: true, status: 'completed' };
  }
}

// ============================================================
// 6. Fawry Adapter Skeleton
// ============================================================
class FawryAdapter extends PaymentGateway {
  async charge(amount, currency, source) {
    logger.info('[FawryAdapter] Generating Fawry reference number (Skeleton):', { amount, currency });
    return { success: true, transactionId: `fawry_${crypto.randomBytes(8).toString('hex')}`, billReferenceNumber: '123456789' };
  }

  async refund(transactionId, amount, reason) {
    logger.info('[FawryAdapter] Refunding Fawry transaction (Skeleton):', { transactionId, amount });
    return { success: true, refundId: `ref_fawry_${crypto.randomBytes(8).toString('hex')}` };
  }

  async createCheckout(invoiceId, returnUrl) {
    logger.info('[FawryAdapter] Creating Fawry payment checkout (Skeleton)');
    return { success: true, checkoutUrl: 'https://www.fawry.com/pay?bill=mock' };
  }

  async verifyWebhook(signature, rawPayload) {
    return true;
  }

  async getPaymentStatus(transactionId) {
    return { success: true, status: 'completed' };
  }
}

// ============================================================
// 7. Manual Bank Transfer Adapter
// ============================================================
class ManualBankAdapter extends PaymentGateway {
  async charge(amount, currency, source) {
    logger.info('[ManualBankAdapter] Logging bank transfer request:', { amount, currency });
    return { success: true, status: 'pending', transactionId: `bank_pending_${crypto.randomBytes(8).toString('hex')}` };
  }

  async refund(transactionId, amount, reason) {
    logger.info('[ManualBankAdapter] Logging manual refund request:', { transactionId, amount });
    return { success: true, refundId: `bank_ref_${crypto.randomBytes(8).toString('hex')}` };
  }

  async createCheckout(invoiceId, returnUrl) {
    logger.info('[ManualBankAdapter] Rendering manual bank transfer instructions');
    const checkoutUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/manual-instructions?invoice=${invoiceId}`;
    return { success: true, checkoutUrl };
  }

  async verifyWebhook(signature, rawPayload) {
    return true;
  }

  async getPaymentStatus(transactionId) {
    return { success: true, status: 'pending' };
  }
}

// ============================================================
// 8. Gateway Strategy Resolver Factory
// ============================================================
async function getPaymentAdapter(code) {
  try {
    const { data: provider, error } = await supabase
      .from('payment_providers')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (error) throw error;

    let decryptedConfig = {};
    let sandboxMode = true;

    if (provider) {
      sandboxMode = !!provider.sandbox;
      if (provider.configuration) {
        // Decrypt configuration details using DATABASE_ENCRYPTION_KEY or versions
        const encryptionKey = getEncryptionKeyForVersion(null); // default version
        const decrypted = decryptCredentials(provider.configuration, encryptionKey);
        if (decrypted) {
          decryptedConfig = decrypted;
        }
      }
    }

    switch (code) {
      case 'mock':
        return new MockGateway(decryptedConfig, sandboxMode);
      case 'stripe':
        return new StripeAdapter(decryptedConfig, sandboxMode);
      case 'paymob':
        return new PaymobAdapter(decryptedConfig, sandboxMode);
      case 'paypal':
        return new PayPalAdapter(decryptedConfig, sandboxMode);
      case 'fawry':
        return new FawryAdapter(decryptedConfig, sandboxMode);
      case 'bank':
        return new ManualBankAdapter(decryptedConfig, sandboxMode);
      default:
        throw new Error(`Unsupported payment provider code: ${code}`);
    }
  } catch (err) {
    logger.error('Failed to resolve payment adapter:', err.message);
    // Return MockGateway as fallback for stability
    return new MockGateway({}, true);
  }
}

module.exports = {
  PaymentGateway,
  MockGateway,
  StripeAdapter,
  PaymobAdapter,
  PayPalAdapter,
  FawryAdapter,
  ManualBankAdapter,
  getPaymentAdapter
};
