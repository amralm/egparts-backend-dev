const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyUser } = require('../middleware/auth');
const wishlistService = require('../services/wishlistService');

function requireStore(req, res) {
  if (!req.store?.id) {
    res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'Tenant context is required.' });
    return null;
  }
  return req.store.id;
}

router.get('/', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const productIds = await wishlistService.listWishlist(storeId, req.user.sub);
    res.json({ success: true, product_ids: productIds });
  } catch (err) {
    logger.error('[wishlist] list failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load wishlist.' });
  }
});

router.get('/products', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const products = await wishlistService.listWishlistProducts(storeId, req.user.sub);
    res.json({ success: true, products });
  } catch (err) {
    logger.error('[wishlist] product list failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load favorite products.' });
  }
});

router.post('/:productId', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const productId = await wishlistService.addWishlistItem(storeId, req.user.sub, req.params.productId);
    res.json({ success: true, product_id: productId });
  } catch (err) {
    logger.error('[wishlist] add failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to update wishlist.' });
  }
});

router.delete('/:productId', verifyUser, async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    await wishlistService.removeWishlistItem(storeId, req.user.sub, req.params.productId);
    res.json({ success: true });
  } catch (err) {
    logger.error('[wishlist] remove failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to update wishlist.' });
  }
});

module.exports = router;
