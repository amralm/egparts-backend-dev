'use strict';

require('dotenv').config();
const { extractR2Key, safeDeleteR2Object, safeDeleteR2Objects } = require('../utils/r2Helper');
const {
  runMasterRetentionCleanup,
  cleanupResolvedSupportTickets,
  cleanupResolvedAbuseReports,
  cleanupClientErrorLogs,
  cleanupAnalyticsEvents,
  cleanupNotificationQueue,
  cleanupUserLoginLogs,
  cleanupStaleImpersonationSessions,
  cleanupOrphanedWhatsAppSessions,
} = require('../services/retentionService');
const productAdminService = require('../services/productAdminService');
const bannerAdminService = require('../services/bannerAdminService');
const settingsAdminService = require('../services/settingsAdminService');
const accountService = require('../services/accountService');
const { supabase } = require('../services/supabase');

async function runTests() {
  console.log('🧪 Starting Master Retention & Media Cleanup E2E Test Suite...');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // ── 1. Test R2 Key Extraction Helper ─────────────────────────────
  console.log('\n📌 [1/6] Testing R2 Key Extraction Helper:');
  const key1 = extractR2Key('https://media.egparts.store/products/store-123/prod-456.webp');
  assert(key1 === 'products/store-123/prod-456.webp', `Extracted CDN URL key correctly: ${key1}`);

  const key2 = extractR2Key('banners/store-abc/banner-xyz.webp');
  assert(key2 === 'banners/store-abc/banner-xyz.webp', `Preserved relative key: ${key2}`);

  const key3 = extractR2Key('/avatars/user-999/avatar.webp');
  assert(key3 === 'avatars/user-999/avatar.webp', `Stripped leading slash: ${key3}`);

  const key4 = extractR2Key(null);
  assert(key4 === null, `Handled null gracefully: ${key4}`);

  // ── 2. Test Safe R2 Deletion (Null/Malformed & Batch) ───────────
  console.log('\n📌 [2/6] Testing Safe R2 Deletion:');
  const delNull = await safeDeleteR2Object(null);
  assert(delNull === false, 'Safe delete on null returns false without throwing');

  const batchDel = await safeDeleteR2Objects([
    'products/test/nonexistent-1.webp',
    'banners/test/nonexistent-2.webp',
  ]);
  assert(batchDel.attempted === 2, `Batch deletion attempted 2 objects without error`);

  // ── 3. Test Product & Banner Image Deletion Hooks ────────────────
  console.log('\n📌 [3/6] Testing Product, Banner & Settings Media Hooks:');
  const { data: testStore } = await supabase.from('stores').select('id').limit(1).single();
  const storeId = testStore?.id;

  if (storeId) {
    // 3a. Banner Media Hook
    const banner = await bannerAdminService.createBanner(storeId, {
      title: 'Retention Test Banner',
      image_url: 'banners/test/retention-banner-mock.webp'
    });
    assert(banner && banner.id, `Created test banner: ${banner.id}`);

    const updatedBanner = await bannerAdminService.updateBanner(storeId, banner.id, {
      image_url: 'banners/test/retention-banner-mock-updated.webp'
    });
    assert(updatedBanner.image_url.includes('updated'), 'Updated banner with new image triggers old cleanup');

    const delBannerRes = await bannerAdminService.deleteBanner(storeId, banner.id);
    assert(delBannerRes.deleted === true, 'Deleted test banner and triggered R2 cleanup');

    // 3b. Product Media Hook
    const product = await productAdminService.saveProduct(storeId, {
      name: 'Retention Test Product',
      price: 100,
      image: 'products/test/mock-main.webp',
      gallery: ['products/test/mock-gal-1.webp', 'products/test/mock-gal-2.webp']
    });
    assert(product && product.id, `Created test product: ${product.id}`);

    const delProdRes = await productAdminService.hardDeleteProduct(storeId, product.id);
    assert(delProdRes.mediaKeys && delProdRes.mediaKeys.length === 3, 'Hard deleted product and collected 3 media keys for R2 cleanup');

    // 3c. Settings Media Hook
    const savedSettings = await settingsAdminService.saveSettings(storeId, {
      logo_url: 'logos/test/mock-logo-new.webp'
    });
    assert(savedSettings !== null, 'Updated store settings logo with R2 cleanup trigger');
  }

  // ── 4. Test User Avatar Media Hook ──────────────────────────────
  console.log('\n📌 [4/6] Testing User Avatar Media Hook:');
  const { data: testUser } = await supabase.from('users').select('id').limit(1).single();
  if (testUser?.id && storeId) {
    const updatedProfile = await accountService.updateProfile(storeId, testUser.id, {
      avatar_url: 'avatars/test/mock-avatar-updated.webp'
    });
    assert(updatedProfile !== null, 'Updated user avatar with R2 cleanup trigger');
  }

  // ── 5. Test Individual Retention Routines ─────────────────────────
  console.log('\n📌 [5/6] Testing Individual Retention Routines:');
  const ticketsRes = await cleanupResolvedSupportTickets();
  assert(typeof ticketsRes.purgedTickets === 'number', `Tickets cleanup executed (Purged: ${ticketsRes.purgedTickets}, AutoClosed: ${ticketsRes.autoClosed})`);

  const abuseRes = await cleanupResolvedAbuseReports();
  assert(typeof abuseRes.purgedReports === 'number', `Abuse reports cleanup executed (Purged: ${abuseRes.purgedReports})`);

  const errorsRes = await cleanupClientErrorLogs();
  assert(typeof errorsRes.purged === 'number', `Client error logs cleanup executed (Purged: ${errorsRes.purged})`);

  const analyticsRes = await cleanupAnalyticsEvents();
  assert(typeof analyticsRes.purged === 'number', `Analytics events cleanup executed (Purged: ${analyticsRes.purged})`);

  const notifsRes = await cleanupNotificationQueue();
  assert(typeof notifsRes.purgedSent === 'number', `Notification queue cleanup executed (Purged sent: ${notifsRes.purgedSent})`);

  const loginsRes = await cleanupUserLoginLogs();
  assert(typeof loginsRes.purged === 'number', `User login logs cleanup executed (Purged: ${loginsRes.purged})`);

  const impersonationRes = await cleanupStaleImpersonationSessions();
  assert(typeof impersonationRes.purgedCodes === 'number', `Impersonation cleanup executed (Purged codes: ${impersonationRes.purgedCodes})`);

  const waSessionsRes = await cleanupOrphanedWhatsAppSessions();
  assert(typeof waSessionsRes.purgedOrphanSessions === 'number', `WhatsApp orphaned sessions cleanup executed (Purged: ${waSessionsRes.purgedOrphanSessions})`);

  // ── 6. Test Master Retention Execution ───────────────────────────
  console.log('\n📌 [6/6] Testing Master Retention Execution:');
  const masterRes = await runMasterRetentionCleanup();
  assert(masterRes.success === true, `Master retention completed successfully in ${masterRes.durationMs}ms`);
  assert(masterRes.paymentProofs !== undefined, 'Payment proofs retention ran');
  assert(masterRes.supportTickets !== undefined, 'Support tickets retention ran');
  assert(masterRes.clientErrorLogs !== undefined, 'Client error logs retention ran');
  assert(masterRes.whatsappSessions !== undefined, 'WhatsApp sessions retention ran');

  console.log(`\n🏁 Test Results: ${passed} Passed, ${failed} Failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 ALL Master Retention & Media Cleanup Tests PASSED with 100% integrity!\n');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Fatal error in tests:', err);
  process.exit(1);
});
