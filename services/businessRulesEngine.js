const registry = require('./toolRegistry');

/**
 * Calculates upgrade recommendations based on actual usage percentages
 */
function calculateUpgradeUrgency(realtimeCounts, featureUsage, planCode) {
  if (planCode === 'enterprise') {
    return { recommended: false, reason: null, urgency: 'low', pitchText: '' };
  }

  // 1. Check product limit
  const productUsage = realtimeCounts.products || 0;
  let productLimit = 100; // default Starter
  if (planCode === 'growth') productLimit = 1000;
  if (planCode === 'scale') productLimit = 9999999;

  const productPct = productUsage / productLimit;
  if (productPct >= 0.85 && planCode !== 'scale') {
    const nextPlan = planCode === 'starter' ? 'الاحترافية (Growth)' : 'الشركات (Scale)';
    const remainingSlots = productLimit - productUsage;
    return {
      recommended: true,
      reason: 'products',
      urgency: productPct >= 0.95 ? 'high' : 'medium',
      estimatedDays: Math.max(1, Math.round(remainingSlots / 1.5)), // assume rate of 1.5 products/day
      pitchText: `لقد استهلكت ${Math.round(productPct * 100)}% من المساحة المتاحة للمنتجات (متبقي ${remainingSlots} منتجات فقط). الترقية إلى باقة ${nextPlan} ستتيح لك مواصلة رفع منتجاتك والتوسع بدون حظر.`
    };
  }

  // 2. Check storage usage
  const storageBytesUsage = featureUsage.find(f => f.feature_key === 'storage_bytes')?.usage || 0;
  let storageLimit = 1 * 1024 * 1024 * 1024; // 1GB default Starter
  if (planCode === 'growth') storageLimit = 10 * 1024 * 1024 * 1024;
  if (planCode === 'scale') storageLimit = 50 * 1024 * 1024 * 1024;

  const storagePct = storageBytesUsage / storageLimit;
  if (storagePct >= 0.80 && planCode !== 'scale') {
    const nextPlan = planCode === 'starter' ? 'Growth' : 'Scale';
    return {
      recommended: true,
      reason: 'storage',
      urgency: storagePct >= 0.92 ? 'high' : 'medium',
      estimatedDays: Math.max(1, Math.round((storageLimit - storageBytesUsage) / (50 * 1024 * 1024))), // assume 50MB/day
      pitchText: `لقد استخدمت ${Math.round(storagePct * 100)}% من مساحة تخزين متجرك. الترقية إلى باقة ${nextPlan} تمنحك سعة تخزينية أكبر وتضمن عدم توقف رفع صور ومنتجات جديدة.`
    };
  }

  // Default: no urgent upgrade recommended
  return {
    recommended: false,
    reason: null,
    urgency: 'low',
    pitchText: ''
  };
}

/**
 * Computes growth recommendations with confidence metrics based on actual telemetry
 */
function generateGrowthRecommendations(sales, inventory, usage, businessType) {
  const recommendations = [];

  // Rec 1: Low stock warning
  if (inventory.totals.lowStockCount > 0) {
    recommendations.push({
      id: 'low_stock_restock',
      title: 'إعادة تمويل مخزون المنتجات الأكثر طلباً',
      description: `لديك ${inventory.totals.lowStockCount} منتجات أوشكت على النفاد من المخزن. ننصح بإعادة توفيرها سريعاً لتجنب فقدان الطلبات.`,
      confidence: 0.95,
      reason: 'low_stock',
      dataSources: ['inventory'],
      action: {
        type: 'restock_notification',
        label: 'مراجعة المنتجات منخفضة المخزون',
        payload: { products: inventory.lowStockSamples }
      }
    });
  }

  // Rec 2: Coupon campaign for sales conversion
  const ordersCount = sales.last30Days.ordersCount || 0;
  if (ordersCount < 10) {
    recommendations.push({
      id: 'create_promo_coupon',
      title: 'إطلاق حملة خصومات ترويجية',
      description: 'المبيعات منخفضة نسبياً هذا الشهر. نقترح إنشاء كوبون خصم بنسبة 10% ونشره لعملائك لزيادة التحويل.',
      confidence: 0.85,
      reason: 'low_sales',
      dataSources: ['sales'],
      action: {
        type: 'create_coupon',
        label: 'إنشاء مسودة كوبون خصم 10%',
        payload: { code: 'WELCOME10', discount_percentage: 10, max_uses: 100 }
      }
    });
  }

  // Rec 3: Automotive compatibility tagging (specific to Automotive niche)
  if (businessType === 'automotive' && inventory.totals.activeProducts > 0) {
    recommendations.push({
      id: 'automotive_compat_mapping',
      title: 'تحديد توافق قطع الغيار مع السيارات',
      description: 'الزبائن يفضلون البحث بنوع سيارتهم. إضافة التوافق الدقيق (OEM) لقطع الغيار يزيد المبيعات بنسبة 35%.',
      confidence: 0.90,
      reason: 'niche_compatibility',
      dataSources: ['inventory', 'compatibility'],
      action: {
        type: 'map_compatibility',
        label: 'ربط القطع بموديلات السيارات',
        payload: { sample_product: inventory.outOfStockSamples[0] || null }
      }
    });
  }

  // Filter recommendations below 60% confidence
  return recommendations.filter(r => r.confidence >= 0.60);
}

module.exports = {
  calculateUpgradeUrgency,
  generateGrowthRecommendations
};
