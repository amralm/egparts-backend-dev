const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyUser } = require('../middleware/auth');
const wishlistService = require('../services/wishlistService');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'Tenant context is required.', 'TENANT_CONTEXT_REQUIRED');
    return null;
  }
  return req.store.id;
}

router.get('/', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const productIds = await wishlistService.listWishlist(storeId, req.user.sub);
    sendSuccess(res, { product_ids: productIds });
  } catch (err) {
    logger.error('[wishlist] list failed:', err.message);
    apiError(res, 500, 'Unable to load wishlist.', `HTTP_500`);
  }
});

router.get('/products', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const products = await wishlistService.listWishlistProducts(storeId, req.user.sub);
    sendSuccess(res, { products });
  } catch (err) {
    logger.error('[wishlist] product list failed:', err.message);
    apiError(res, 500, 'Unable to load favorite products.', `HTTP_500`);
  }
});

router.post('/:productId', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const productId = await wishlistService.addWishlistItem(storeId, req.user.sub, req.params.productId);
    sendSuccess(res, { product_id: productId });
  } catch (err) {
    logger.error('[wishlist] add failed:', err.message);
    apiError(res, 500, 'Unable to update wishlist.', `HTTP_500`);
  }
});

router.delete('/:productId', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    await wishlistService.removeWishlistItem(storeId, req.user.sub, req.params.productId);
    sendSuccess(res, {});
  } catch (err) {
    logger.error('[wishlist] remove failed:', err.message);
    apiError(res, 500, 'Unable to update wishlist.', `HTTP_500`);
  }
});

module.exports = router;
