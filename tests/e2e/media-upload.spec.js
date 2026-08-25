'use strict';

/**
 * E2E Integration Tests — Asset Pipeline
 *
 * These tests run against the REAL pipeline components:
 * - Real AssetPolicy classes
 * - Real MagicBytesValidator
 * - Real ImageProcessor (sharp)
 * - Real FileFingerprint
 * - Real AssetRegistry + validatePolicy
 * - Real StorageService.getPublicUrl() / generateSignedUrl()
 *
 * MOCKED:
 * - StorageService.upload() / delete() → in-memory, no real R2 calls
 * - subscriptionLimitService.reserveFeatureUsage() → always returns true
 * - subscriptionLimitService.commitFeatureUsage() → noop
 * - subscriptionLimitService.rollbackFeatureUsage() → noop
 *
 * Run: node tests/e2e/media-upload.spec.js
 */

require('dotenv').config();

const assert  = require('assert').strict;
const sharp   = require('sharp');
const path    = require('path');

// ─── Load real pipeline components ───────────────────────────────────────────
const registry        = require('../../services/assetPipeline/AssetRegistry');
const MagicBytes      = require('../../services/assetPipeline/MagicBytesValidator');
const FileFingerprint = require('../../services/assetPipeline/FileFingerprint');
const ImageProcessor  = require('../../services/assetPipeline/ImageProcessor');
const StorageService  = require('../../services/assetPipeline/StorageService');

// ─── Mock storage provider (in-memory) ───────────────────────────────────────
const uploadedKeys = new Map();  // key → buffer

const MockProvider = {
  name: 'mock',
  upload:            async (buf, key) => { uploadedKeys.set(key, buf); },
  delete:            async (key)      => { uploadedKeys.delete(key); },
  exists:            async (key)      => uploadedKeys.has(key),
  getPublicUrl:      (key)            => `https://cdn.test/${key}`,
  generateSignedUrl: async (key, ttl) => `https://cdn.test/${key}?signed=1&ttl=${ttl}`,
};

// Patch the singleton provider BEFORE AssetPipeline is loaded
StorageService._provider = MockProvider;

// ─── Mock subscriptionLimitService ───────────────────────────────────────────
// Intercept require cache
const quotaState = { shouldFail: false };
require.cache[require.resolve('../../services/subscriptionLimitService')] = {
  id: require.resolve('../../services/subscriptionLimitService'),
  filename: require.resolve('../../services/subscriptionLimitService'),
  loaded: true,
  exports: {
    reserveFeatureUsage:  async () => !quotaState.shouldFail,
    commitFeatureUsage:   async () => {},
    rollbackFeatureUsage: async () => {},
  },
};

// Load AssetPipeline AFTER mocks are in place
const AssetPipeline = require('../../services/assetPipeline/AssetPipeline');

// ─── Buffer factories ─────────────────────────────────────────────────────────
async function makeJpegBuffer(widthPx = 100, heightPx = 100, sizeHintBytes = null) {
  let img = sharp({ create: { width: widthPx, height: heightPx, channels: 3, background: '#3498db' } });
  if (sizeHintBytes) {
    // Use low quality to approach size target — exact size not guaranteed
    return img.jpeg({ quality: 10 }).toBuffer();
  }
  return img.jpeg({ quality: 80 }).toBuffer();
}

async function makePngBuffer(w = 100, h = 100) {
  return sharp({ create: { width: w, height: h, channels: 4, background: '#e74c3c' } })
    .png().toBuffer();
}

async function makeLargeJpegBuffer(targetMB = 6) {
  // Create a large buffer by repeating a real JPEG
  const base = await makeJpegBuffer(2000, 2000);
  // Repeat to approximate size (not accurate, but tests the size check path)
  const repeats = Math.ceil((targetMB * 1024 * 1024) / base.length);
  return Buffer.concat(Array(repeats).fill(base)).slice(0, targetMB * 1024 * 1024);
}

function makeExeBuffer() {
  // Windows PE magic bytes — disguised as .jpg
  const exe = Buffer.alloc(64, 0);
  exe[0] = 0x4D; exe[1] = 0x5A; // MZ header
  return exe;
}

function makePdfBuffer() {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A]); // %PDF-1.4
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    uploadedKeys.clear();
    quotaState.shouldFail = false;
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`       ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

async function assertThrowsCode(fn, expectedCode) {
  try {
    await fn();
    throw new Error(`Expected error code '${expectedCode}' but no error was thrown`);
  } catch (err) {
    if (err.code !== expectedCode) {
      throw new Error(`Expected code '${expectedCode}', got '${err.code}': ${err.message}`);
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Asset Pipeline — E2E Integration Tests');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Section 1: Policy Registry ──────────────────────────────────────────────
  console.log('📋  Policy Registry\n');

  await test('All 7 policies registered', async () => {
    const policies = registry.listPolicies();
    const required = ['product', 'banner', 'logo', 'category', 'avatar', 'receipt', 'document'];
    for (const p of required) {
      assert.ok(policies.includes(p), `Missing policy: ${p}`);
    }
  });

  await test('Unknown policy throws UNKNOWN_POLICY', async () => {
    await assertThrowsCode(
      async () => registry.validatePolicy('definitely_not_a_policy'),
      'UNKNOWN_POLICY'
    );
  });

  await test('Null policy name throws UNKNOWN_POLICY', async () => {
    await assertThrowsCode(
      async () => registry.validatePolicy(null),
      'UNKNOWN_POLICY'
    );
  });

  // ── Section 2: Magic Bytes Validation ──────────────────────────────────────
  console.log('\n🔍  Magic Bytes Validation\n');

  await test('Executable disguised as JPEG throws INVALID_MAGIC_BYTES', async () => {
    const exeBuf = makeExeBuffer();
    const policy = registry.getPolicy('product');
    assert.throws(
      () => MagicBytes.validate(exeBuf, 'image/jpeg', 'photo.jpg', policy.allowedMimeTypes),
      (err) => err.code === 'INVALID_MAGIC_BYTES'
    );
  });

  await test('Extension mismatch (PNG bytes with JPEG MIME) rejected at magic bytes or extension check', async () => {
    // PNG buffer with JPEG MIME type → fails at magic bytes (0x89 PNG ≠ 0xFF JPEG)
    // The validator catches this at magic bytes level first, which is correct.
    // Both INVALID_MAGIC_BYTES and MIME_MISMATCH are valid pipeline rejections here.
    const pngBuf = await makePngBuffer();
    const policy = registry.getPolicy('product');
    let errorCode;
    try {
      MagicBytes.validate(pngBuf, 'image/jpeg', 'photo.png', policy.allowedMimeTypes);
    } catch (err) {
      errorCode = err.code;
    }
    const validRejections = ['INVALID_MAGIC_BYTES', 'MIME_MISMATCH'];
    assert.ok(
      validRejections.includes(errorCode),
      `Expected INVALID_MAGIC_BYTES or MIME_MISMATCH, got: ${errorCode}`
    );
  });

  await test('Valid JPEG passes triple validation', async () => {
    const jpgBuf = await makeJpegBuffer();
    const policy = registry.getPolicy('product');
    const result = MagicBytes.validate(jpgBuf, 'image/jpeg', 'photo.jpg', policy.allowedMimeTypes);
    assert.ok(result.ext, 'Should return canonical extension');
  });

  await test('PDF rejected by product policy (not in allowedMimeTypes)', async () => {
    const pdfBuf = makePdfBuffer();
    const policy = registry.getPolicy('product');
    assert.throws(
      () => MagicBytes.validate(pdfBuf, 'application/pdf', 'doc.pdf', policy.allowedMimeTypes),
      (err) => err.code === 'UNSUPPORTED_TYPE'
    );
  });

  await test('PDF accepted by document policy', async () => {
    const pdfBuf = makePdfBuffer();
    const policy = registry.getPolicy('document');
    const result = MagicBytes.validate(pdfBuf, 'application/pdf', 'doc.pdf', policy.allowedMimeTypes);
    assert.equal(result.ext, 'pdf');
  });

  // ── Section 3: Storage URL API ─────────────────────────────────────────────
  console.log('\n🔐  Storage URL API\n');

  await test('getPublicUrl() works for public key', async () => {
    const key = 'stores/123/public/products/uuid.webp';
    const url  = StorageService.getPublicUrl(key);
    assert.ok(url.includes(key), `URL should contain key. Got: ${url}`);
  });

  await test('getPublicUrl() throws PRIVATE_ASSET for receipt key', async () => {
    const privateKey = 'stores/123/private/receipts/uuid.jpg';
    assert.throws(
      () => StorageService.getPublicUrl(privateKey),
      (err) => err.code === 'PRIVATE_ASSET'
    );
  });

  await test('getPublicUrl() throws PRIVATE_ASSET for document key', async () => {
    const docKey = 'stores/123/private/documents/uuid.pdf';
    assert.throws(
      () => StorageService.getPublicUrl(docKey),
      (err) => err.code === 'PRIVATE_ASSET'
    );
  });

  await test('generateSignedUrl() works for private receipt key', async () => {
    const key = 'stores/123/private/receipts/uuid.jpg';
    const url = await StorageService.generateSignedUrl(key, 3600);
    assert.ok(url.includes('signed=1'), `Expected signed URL. Got: ${url}`);
  });

  // ── Section 4: Full Pipeline — Happy Path ──────────────────────────────────
  console.log('\n🚀  Full Pipeline — Happy Path\n');

  await test('Product image: upload 100×100 JPEG → processes to WebP, returns key', async () => {
    const buf    = await makeJpegBuffer(100, 100);
    const result = await AssetPipeline.process({
      buffer: buf, mimetype: 'image/jpeg', originalname: 'product.jpg',
      policyName: 'product', storeId: 'store-test-001', correlationId: 'test-001',
    });
    assert.ok(result.key,   'Should return a key');
    assert.ok(result.sha256, 'Should return sha256');
    assert.ok(result.metrics, 'Should return metrics');
    assert.equal(result.policyVersion, 1);
    assert.ok(result.key.includes('public/products'), `Key should be public/products. Got: ${result.key}`);
    assert.ok(uploadedKeys.has(result.key), 'Object should be in mock storage');
  });

  await test('Banner image: uploads to public/banners/', async () => {
    const buf    = await makeJpegBuffer(200, 100);
    const result = await AssetPipeline.process({
      buffer: buf, mimetype: 'image/jpeg', originalname: 'banner.jpg',
      policyName: 'banner', storeId: 'store-test-001', correlationId: 'test-002',
    });
    assert.ok(result.key.includes('public/banners'), `Key: ${result.key}`);
  });

  await test('Logo: uploads to public/logos/ with custom key path', async () => {
    const buf    = await makePngBuffer(200, 200);
    const result = await AssetPipeline.process({
      buffer: buf, mimetype: 'image/png', originalname: 'logo.png',
      policyName: 'logo', storeId: 'store-test-001', correlationId: 'test-003',
    });
    assert.ok(result.key.includes('public/logos'), `Key: ${result.key}`);
  });

  await test('Receipt: uploads to private/receipts/ with original format (not WebP)', async () => {
    const buf    = await makeJpegBuffer(400, 300);
    const result = await AssetPipeline.process({
      buffer: buf, mimetype: 'image/jpeg', originalname: 'receipt.jpg',
      policyName: 'receipt', storeId: 'store-test-001', correlationId: 'test-004',
    });
    assert.ok(result.key.includes('private/receipts'), `Key: ${result.key}`);
    // ReceiptPolicy.convertToWebP = false → format stays as jpg
    assert.ok(!result.key.endsWith('.webp'), `Receipt should NOT be WebP. Got: ${result.key}`);
  });

  await test('Pipeline metrics returned: processedBytes, savedBytes, compressionRatio, processingMs', async () => {
    const buf    = await makeJpegBuffer(100, 100);
    const result = await AssetPipeline.process({
      buffer: buf, mimetype: 'image/jpeg', originalname: 'photo.jpg',
      policyName: 'product', storeId: 'store-test-001', correlationId: 'test-005',
    });
    assert.ok(typeof result.metrics.processedBytes   === 'number', 'processedBytes');
    assert.ok(typeof result.metrics.savedBytes        === 'number', 'savedBytes');
    assert.ok(typeof result.metrics.compressionRatio  === 'number', 'compressionRatio');
    assert.ok(typeof result.metrics.processingMs      === 'number', 'processingMs');
    assert.ok(result.metrics.processingMs >= 0, 'processingMs >= 0');
  });

  // ── Section 5: Full Pipeline — Error Handling ──────────────────────────────
  console.log('\n🛡️  Full Pipeline — Error Handling\n');

  await test('File too large throws FILE_TOO_LARGE', async () => {
    const hugeBuf = Buffer.alloc(16 * 1024 * 1024, 0xFF); // 16MB of 0xFF (no magic bytes)
    // Use JPEG magic bytes to pass the magic bytes check
    const jpgBuf = await makeJpegBuffer(100, 100);
    // Create a fake oversized JPEG: real header + padding
    const oversized = Buffer.concat([jpgBuf, Buffer.alloc(20 * 1024 * 1024, 0x00)]);
    // ProductPolicy maxSize = 15MB
    await assertThrowsCode(
      () => AssetPipeline.process({
        buffer: oversized, mimetype: 'image/jpeg', originalname: 'huge.jpg',
        policyName: 'product', storeId: 'store-test-001', correlationId: 'test-006',
      }),
      'FILE_TOO_LARGE'
    );
  });

  await test('Executable disguised as JPEG throws INVALID_MAGIC_BYTES', async () => {
    const exeBuf = makeExeBuffer();
    await assertThrowsCode(
      () => AssetPipeline.process({
        buffer: exeBuf, mimetype: 'image/jpeg', originalname: 'malware.jpg',
        policyName: 'product', storeId: 'store-test-001', correlationId: 'test-007',
      }),
      'INVALID_MAGIC_BYTES'
    );
  });

  await test('Unknown policy name throws UNKNOWN_POLICY', async () => {
    const buf = await makeJpegBuffer();
    await assertThrowsCode(
      () => AssetPipeline.process({
        buffer: buf, mimetype: 'image/jpeg', originalname: 'photo.jpg',
        policyName: 'hacker_policy', storeId: 'store-test-001', correlationId: 'test-008',
      }),
      'UNKNOWN_POLICY'
    );
  });

  await test('Quota exceeded throws QUOTA_EXCEEDED', async () => {
    quotaState.shouldFail = true;
    const buf = await makeJpegBuffer();
    await assertThrowsCode(
      () => AssetPipeline.process({
        buffer: buf, mimetype: 'image/jpeg', originalname: 'photo.jpg',
        policyName: 'product', storeId: 'store-quota-fail', correlationId: 'test-009',
      }),
      'QUOTA_EXCEEDED'
    );
  });

  // ── Section 6: Compensation Delete ────────────────────────────────────────
  console.log('\n♻️  Compensation Delete\n');

  await test('Quota commit failure triggers compensation delete (no orphan left)', async () => {
    // Use a fresh pipeline instance with injected mock to control commit behavior
    const storageModule   = require('../../services/assetPipeline/StorageService');
    const uploadedInTest  = new Map();
    let   compensationDeleteCalled = false;

    // Patch the provider directly on the singleton for this test
    const origProvider = storageModule._provider;
    storageModule._provider = {
      name:            'test-mock',
      upload:          async (buf, key) => uploadedInTest.set(key, buf),
      delete:          async (key)      => { compensationDeleteCalled = true; uploadedInTest.delete(key); },
      exists:          async (key)      => uploadedInTest.has(key),
      getPublicUrl:    (key)            => `https://cdn.test/${key}`,
      generateSignedUrl: async (key)   => `https://cdn.test/${key}?signed=1`,
    };

    // Patch commit to fail once
    const quotaModule = require.cache[require.resolve('../../services/subscriptionLimitService')];
    const origExports = { ...quotaModule.exports };
    quotaModule.exports.commitFeatureUsage = async () => {
      throw new Error('Simulated quota commit failure');
    };

    const buf = await makeJpegBuffer();
    let threw = false;
    try {
      await AssetPipeline.process({
        buffer: buf, mimetype: 'image/jpeg', originalname: 'photo.jpg',
        policyName: 'product', storeId: 'store-comp-delete', correlationId: 'test-010',
      });
    } catch {
      threw = true;
    }

    // Restore mocks
    storageModule._provider = origProvider;
    quotaModule.exports.commitFeatureUsage = origExports.commitFeatureUsage;

    assert.ok(threw, 'Should have thrown after commit failure');
    assert.ok(compensationDeleteCalled, 'Compensation delete should have been called on R2');
    assert.equal(uploadedInTest.size, 0, `No orphan objects — storage should be empty after compensation delete. Has: ${[...uploadedInTest.keys()].join(', ')}`);
  });

  // ── Section 7: Policy Behavior ─────────────────────────────────────────────
  console.log('\n🔧  Policy Behavior\n');

  await test('ReceiptPolicy: visibility is private', () => {
    assert.equal(registry.getPolicy('receipt').visibility, 'private');
  });

  await test('ReceiptPolicy: convertToWebP is false', () => {
    assert.equal(registry.getPolicy('receipt').convertToWebP, false);
  });

  await test('ReceiptPolicy: duplicateDetection is false', () => {
    assert.equal(registry.getPolicy('receipt').duplicateDetection, false);
  });

  await test('ProductPolicy: duplicateDetection is true', () => {
    assert.equal(registry.getPolicy('product').duplicateDetection, true);
  });

  await test('ProductPolicy: visibility is public', () => {
    assert.equal(registry.getPolicy('product').visibility, 'public');
  });

  await test('ReceiptPolicy: generateStorageKey produces private/receipts path', () => {
    const key = registry.getPolicy('receipt').generateStorageKey('s1', 'f1', 'jpg');
    assert.ok(key.includes('private/receipts'), `Got: ${key}`);
  });

  await test('LogoPolicy: generateStorageKey produces public/logos path', () => {
    const key = registry.getPolicy('logo').generateStorageKey('s1', 'f1', 'webp');
    assert.ok(key.includes('public/logos'), `Got: ${key}`);
  });

  await test('DocumentPolicy: visibility is private, allowedMimeTypes includes PDF', () => {
    const docPolicy = registry.getPolicy('document');
    assert.equal(docPolicy.visibility, 'private');
    assert.ok(docPolicy.allowedMimeTypes.includes('application/pdf'));
  });

  // ─── Final report ───────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`    ❌ ${f.name}\n       ${f.error}`));
  }
  console.log('═══════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
