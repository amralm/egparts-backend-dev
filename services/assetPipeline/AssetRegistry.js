'use strict';

const AssetPolicy = require('./policies/AssetPolicy');

/**
 * AssetRegistry — Policy registry for the Asset Pipeline.
 *
 * Responsibilities:
 * - Holds all registered policies by name.
 * - Provides validated policy lookup with clear errors.
 * - Ships with all core policies pre-registered.
 *
 * To add a new policy:
 *   1. Create MyPolicy extends AssetPolicy in policies/
 *   2. registry.register(require('./policies/MyPolicy'))
 *   Done.
 */
class AssetRegistry {
  constructor() {
    this._policies = new Map();
  }

  /**
   * Register a policy instance.
   * @param {AssetPolicy} policy — singleton instance
   */
  register(policy) {
    if (!(policy instanceof AssetPolicy)) {
      throw new Error(`[AssetRegistry] Policy must extend AssetPolicy. Got: ${typeof policy}`);
    }
    if (!policy.name) {
      throw new Error('[AssetRegistry] Policy must have a name.');
    }
    this._policies.set(policy.name, policy);
  }

  /**
   * Validate that a policy name is registered.
   * Throws a clear error — no ambiguous fallbacks.
   * @param {string} name
   */
  validatePolicy(name) {
    if (!name || typeof name !== 'string') {
      throw Object.assign(new Error('UNKNOWN_POLICY: policy name is required'), {
        code: 'UNKNOWN_POLICY',
        statusCode: 400,
      });
    }
    if (!this._policies.has(name)) {
      const available = [...this._policies.keys()].join(', ');
      throw Object.assign(
        new Error(`UNKNOWN_POLICY: '${name}' is not a registered policy. Available: ${available}`),
        { code: 'UNKNOWN_POLICY', statusCode: 400 }
      );
    }
  }

  /**
   * Get a validated policy instance.
   * @param {string} name
   * @returns {AssetPolicy}
   */
  getPolicy(name) {
    this.validatePolicy(name);
    return this._policies.get(name);
  }

  /**
   * List all registered policy names.
   * @returns {string[]}
   */
  listPolicies() {
    return [...this._policies.keys()];
  }
}

// ─── Singleton with all core policies registered ─────────────────────────────
const registry = new AssetRegistry();

registry.register(require('./policies/ProductPolicy'));
registry.register(require('./policies/BannerPolicy'));
registry.register(require('./policies/LogoPolicy'));
registry.register(require('./policies/CategoryPolicy'));
registry.register(require('./policies/AvatarPolicy'));
registry.register(require('./policies/ReceiptPolicy'));
registry.register(require('./policies/DocumentPolicy'));

module.exports = registry;
