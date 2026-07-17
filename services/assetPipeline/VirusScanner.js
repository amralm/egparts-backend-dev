'use strict';

/**
 * VirusScanner — Pluggable virus scanning interface.
 *
 * Current implementation: NoopScanner (always passes — safe for Phase 1).
 * Future: Replace NoopScanner with ClamAVScanner, VirusTotalScanner, etc.
 *
 * To upgrade: implement a class with scan(buffer) → Promise<boolean>
 * and swap the export at the bottom. Zero changes elsewhere.
 */

class VirusScanner {
  get name() { throw new Error('Must implement name') }

  /**
   * Scan a file buffer for viruses/malware.
   * @param {Buffer} buffer
   * @returns {Promise<{ clean: boolean, threat?: string }>}
   */
  async scan(buffer) {
    throw new Error('Must implement scan()');
  }
}

class NoopScanner extends VirusScanner {
  get name() { return 'noop' }

  /**
   * Always returns clean. Replace with real scanner in Phase 3.
   */
  async scan(_buffer) {
    return { clean: true };
  }
}

// Future: class ClamAVScanner extends VirusScanner { ... }

module.exports = new NoopScanner();
