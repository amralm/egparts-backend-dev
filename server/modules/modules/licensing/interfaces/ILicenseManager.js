/**
 * ILicenseManager
 * Defines the contract for the Licensing Module.
 */
class ILicenseManager {
  /**
   * Generates a new License Key for a specific tenant or product.
   */
  async generateKey(tenantId, productId, options = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Activates a license key, binding it to a device or tenant.
   */
  async activate(key, fingerprint) {
    throw new Error('Not implemented');
  }

  /**
   * Revokes a license key.
   */
  async revoke(key, reason) {
    throw new Error('Not implemented');
  }

  /**
   * Registers a specific device/machine fingerprint against a license.
   */
  async registerDevice(key, fingerprint, metadata) {
    throw new Error('Not implemented');
  }

  /**
   * Validates if a license is currently active and valid for a device.
   */
  async validate(key, fingerprint) {
    throw new Error('Not implemented');
  }

  /**
   * Offline License generation (e.g., signed JWT or encrypted blob).
   */
  async generateOfflineLicense(key) {
    throw new Error('Not implemented');
  }
}

module.exports = ILicenseManager;\n