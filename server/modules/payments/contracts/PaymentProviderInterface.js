/**
 * PaymentProviderInterface
 * Defines the contract/interface that all payment providers must implement.
 */
class PaymentProviderInterface {
  /**
   * Returns the unique provider code (e.g., 'paymob', 'manual_wallet').
   * @returns {string}
   */
  getCode() {
    throw new Error('Method "getCode()" must be implemented.');
  }

  /**
   * Initiates a payment process with the payment provider.
   * @param {PaymentIntent} intent The payment intent entity.
   * @param {object} customerData Customer details (name, email, phone, address, city, etc.).
   * @param {object} storeSettings Decrypted settings/credentials specific to the provider.
   * @returns {Promise<{payment_url: string, provider_reference: string}>}
   */
  async initiatePayment(intent, customerData, storeSettings) {
    throw new Error('Method "initiatePayment()" must be implemented.');
  }

  /**
   * Verifies the webhook payload and signature (e.g. HMAC).
   * @param {object} payload The request body payload.
   * @param {object} headers The request headers.
   * @param {object} storeSettings Decrypted store gateway settings.
   * @returns {Promise<boolean>}
   */
  async verifyWebhook(payload, headers, storeSettings) {
    throw new Error('Method "verifyWebhook()" must be implemented.');
  }

  /**
   * Captures an authorized payment.
   * @param {string} providerReference The provider's transaction or order reference.
   * @param {number} amountCents Amount to capture in cents.
   * @param {object} storeSettings Decrypted store gateway settings.
   * @returns {Promise<{status: string, transaction_id: string}>}
   */
  async capture(providerReference, amountCents, storeSettings) {
    throw new Error('Method "capture()" must be implemented.');
  }

  /**
   * Refunds a captured payment.
   * @param {string} providerReference The provider's transaction or order reference.
   * @param {number} amountCents Amount to refund in cents.
   * @param {object} storeSettings Decrypted store gateway settings.
   * @returns {Promise<{status: string, transaction_id: string}>}
   */
  async refund(providerReference, amountCents, storeSettings) {
    throw new Error('Method "refund()" must be implemented.');
  }
}

module.exports = PaymentProviderInterface;
