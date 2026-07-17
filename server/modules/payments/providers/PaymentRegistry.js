const PaymobProvider = require('./PaymobProvider');
const ManualWalletProvider = require('./ManualWalletProvider');

/**
 * PaymentRegistry
 * Manages the registration and lookup of payment providers.
 */
class PaymentRegistry {
  constructor() {
    this.providers = new Map();
  }

  /**
   * Registers a payment provider.
   * @param {PaymentProviderInterface} provider
   */
  register(provider) {
    if (!provider || typeof provider.getCode !== 'function') {
      throw new Error('Invalid provider. Must implement PaymentProviderInterface.');
    }
    this.providers.set(provider.getCode(), provider);
  }

  /**
   * Gets a registered provider by its unique code.
   * @param {string} code Unique provider code (e.g. 'paymob', 'manual_wallet').
   * @returns {PaymentProviderInterface}
   */
  get(code) {
    const provider = this.providers.get(code);
    if (!provider) {
      throw new Error(`Provider not found: ${code}`);
    }
    return provider;
  }

  /**
   * Lists the codes of all registered providers.
   * @returns {string[]}
   */
  list() {
    return Array.from(this.providers.keys());
  }
}

const registry = new PaymentRegistry();

// Register the default payment providers
registry.register(new PaymobProvider());
registry.register(new ManualWalletProvider());

module.exports = registry;
