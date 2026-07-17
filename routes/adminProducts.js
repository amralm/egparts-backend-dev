const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const productAdminService = require('../services/productAdminService');
const subscriptionLimitService = require('../services/subscriptionLimitService');

function requireStore(req, res) {
  if (!req.store?.id) {
    res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'Tenant context is required.' });
    return null;
  }
  return req.store.id;
}

router.get('/', verifyPermission('products.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const products = await productAdminService.listProducts(storeId, req.query.view || 'active');
    res.json({ success: true, products });
  } catch (err) {
    logger.error('[admin-products] list failed:', err.message, err.details, err.hint);
    res.status(500).json({ success: false, error: 'Unable to load products.' });
  }
});

router.post('/', verifyPermission('products.create'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const isAllowed = await subscriptionLimitService.reserveFeatureUsage(storeId, 'products', 1, req.headers['x-idempotency-key'] || Date.now().toString());
    if (!isAllowed) {
      return res.status(403).json({ success: false, code: 'FEATURE_LIMIT_EXCEEDED', error: 'تجاوزت الحد الأقصى للمنتجات المسموح بها في باقتك. يرجى ترقية الباقة لإضافة المزيد.' });
    }
    const product = await productAdminService.saveProduct(storeId, req.body || {});
    res.status(201).json({ success: true, product });
  } catch (err) {
    logger.error('[admin-products] create failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', verifyPermission('products.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const product = await productAdminService.saveProduct(storeId, req.body || {}, req.params.id);
    res.json({ success: true, product });
  } catch (err) {
    logger.error('[admin-products] update failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/soft-delete', verifyPermission('products.delete'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    await productAdminService.softDeleteProduct(storeId, req.params.id);
    res.json({ success: true, result: 'soft_deleted' });
  } catch (err) {
    logger.error('[admin-products] soft delete failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', verifyPermission('products.delete'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const result = await productAdminService.hardDeleteProduct(storeId, req.params.id);
    res.json({ success: true, result: 'hard_deleted', mediaKeys: result.mediaKeys || [] });
  } catch (err) {
    logger.error('[admin-products] hard delete failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/restore', verifyPermission('products.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const product = await productAdminService.restoreProduct(storeId, req.params.id);
    res.json({ success: true, product });
  } catch (err) {
    logger.error('[admin-products] restore failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
