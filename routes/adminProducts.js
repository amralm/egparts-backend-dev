const { apiError } = require('../utils/apiError');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const productAdminService = require('../services/productAdminService');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const { validateBody } = require('../middleware/requestValidation');
const { productSchema } = require('../schemas/catalogSchemas');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'Tenant context is required.', 'TENANT_CONTEXT_REQUIRED');
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
    apiError(res, 500, 'Unable to load products.', `HTTP_500`);
  }
});

router.post('/', verifyPermission('products.create'), validateBody(productSchema), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  let reservationKey;
  try {
    reservationKey = req.headers['x-idempotency-key'] || `prod_${Date.now()}`;
    const isAllowed = await subscriptionLimitService.reserveFeatureUsage(storeId, 'products', 1, reservationKey, 15);
    if (!isAllowed) {
      return apiError(res, 403, 'تجاوزت الحد الأقصى للمنتجات المسموح بها في باقتك. يرجى ترقية الباقة لإضافة المزيد.', 'FEATURE_LIMIT_EXCEEDED');
    }
    const product = await productAdminService.saveProduct(storeId, req.body || {});
    await subscriptionLimitService.commitFeatureUsage(reservationKey);
    res.status(201).json({ success: true, product });
  } catch (err) {
    if (typeof reservationKey !== 'undefined') {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
    }
    logger.error('[admin-products] create failed:', err.message);
    apiError(res, 500, 'Unable to create product.', 'PRODUCT_CREATE_FAILED');
  }
});

router.put('/:id', verifyPermission('products.update'), validateBody(productSchema.partial()), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const product = await productAdminService.saveProduct(storeId, req.body || {}, req.params.id);
    res.json({ success: true, product });
  } catch (err) {
    logger.error('[admin-products] update failed:', err.message);
    apiError(res, 500, 'Unable to update product.', 'PRODUCT_UPDATE_FAILED');
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
    apiError(res, 500, 'Unable to archive product.', 'PRODUCT_ARCHIVE_FAILED');
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
    apiError(res, 500, 'Unable to restore product.', 'PRODUCT_RESTORE_FAILED');
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
    apiError(res, 500, 'Unable to delete product.', 'PRODUCT_DELETE_FAILED');
  }
});

module.exports = router;
