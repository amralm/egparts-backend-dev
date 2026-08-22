const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const reviewAdminService = require('../services/reviewAdminService');
const logger = require('../utils/logger');

const router = express.Router();

function getStoreId(req, res) {
  const storeId = req.store?.id;
  if (!storeId) {
    apiError(res, 403, 'Tenant context required', `HTTP_403`);
    return null;
  }
  return storeId;
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  return apiError(res, status, status >= 500 ? 'Internal server error' : (err.code || 'Request failed'), err.code || `HTTP_${status}`);
}

router.get('/', verifyPermission('reviews.view'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const reviews = await reviewAdminService.listReviews(storeId, req.query.status || 'all');
    sendSuccess(res, { reviews });
  } catch (err) {
    logger.error('[admin-reviews] list failed:', err.message);
    sendError(res, err);
  }
});

router.patch('/:id/status', verifyPermission('reviews.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const review = await reviewAdminService.updateReviewStatus(storeId, req.params.id, req.body?.status);
    sendSuccess(res, { review });
  } catch (err) {
    logger.error('[admin-reviews] status update failed:', err.message);
    sendError(res, err);
  }
});

router.delete('/:id', verifyPermission('reviews.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    await reviewAdminService.deleteReview(storeId, req.params.id);
    sendSuccess(res, {});
  } catch (err) {
    logger.error('[admin-reviews] delete failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;
