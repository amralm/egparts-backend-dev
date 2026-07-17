const PaymentProviderInterface = require('../contracts/PaymentProviderInterface');

/**
 * ManualWalletProvider
 * Implements the payment provider interface for manual cash/wallet checkout transfers (e.g. Vodafone Cash).
 */
class ManualWalletProvider extends PaymentProviderInterface {
  getCode() {
    return 'manual_wallet';
  }

  /**
   * Initiates payment for manual wallet.
   * Note: query storeSettings for `vodafone_cash_number` and `payment_screenshot_number`.
   */
  async initiatePayment(intent, customerData, storeSettings = {}) {
    const walletNumber = storeSettings.vodafone_cash_number || '01011192994';
    const screenshotNumber = storeSettings.payment_screenshot_number || '201122551272';

    return {
      payment_url: `/checkout/manual-wallet?intent_id=${intent.id}&wallet=${encodeURIComponent(walletNumber)}&screenshot=${encodeURIComponent(screenshotNumber)}`,
      provider_reference: `wallet_manual_${intent.id}`
    };
  }

  async verifyWebhook(payload, headers, storeSettings) {
    // Manual wallets don't have webhook verifications from external gateways
    return false;
  }

  async capture(providerReference, amountCents, storeSettings) {
    return {
      status: 'captured',
      transaction_id: providerReference
    };
  }

  async refund(providerReference, amountCents, storeSettings) {
    return {
      status: 'refunded',
      transaction_id: providerReference
    };
  }
}

module.exports = ManualWalletProvider;
