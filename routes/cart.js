'use strict';

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const { validateBody, validateParams } = require('../middleware/requestValidation');
const { verifyPermission } = require('../middleware/auth');
const { syncDraftCartSchema, recoverTokenParamSchema } = require('../schemas/cartSchemas');
const abandonedCartService = require('../services/abandonedCartService');
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

// Anti-Spam / Rate-limiting for draft syncing
const draftSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 requests per minute per IP
  message: { success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/cart/draft
 * Silently saves/updates cart draft once customer inputs phone number.
 */
router.post('/draft', draftSyncLimiter, validateBody(syncDraftCartSchema), async (req, res) => {
  if (!req.store?.id) {
    return apiError(res, 400, 'Tenant store context required', 'TENANT_REQUIRED');
  }

  try {
    const { phone, customerName, customer_name, items } = req.body;
    const result = await abandonedCartService.syncDraft(req.store.id, {
      phone,
      customerName: customerName || customer_name,
      items,
    });

    return sendSuccess(res, result, { status: 200, message: 'Draft saved' });
  } catch (err) {
    logger.error(`[CartRoute] Draft sync error: ${err.message}`);
    return apiError(res, 500, 'Failed to save cart draft', 'DRAFT_SYNC_FAILED');
  }
});

/**
 * GET /api/cart/recover/:token
 * Restores cart session with real-time price and stock validation.
 */
router.get('/recover/:token', validateParams(recoverTokenParamSchema), async (req, res) => {
  try {
    const result = await abandonedCartService.recoverCart(req.params.token);

    if (!result.valid) {
      if (result.error === 'SESSION_EXPIRED') {
        return apiError(res, 410, 'Cart session has expired', 'CART_EXPIRED');
      }
      return apiError(res, 404, 'Cart session not found', 'CART_NOT_FOUND');
    }

    return sendSuccess(res, result);
  } catch (err) {
    logger.error(`[CartRoute] Recover cart error: ${err.message}`);
    return apiError(res, 500, 'Failed to recover cart', 'RECOVER_FAILED');
  }
});

/**
 * GET /api/cart/admin/sessions
 * Store manager dashboard to inspect abandoned & recovered cart sessions.
 */
router.get('/admin/sessions', verifyPermission('orders.view'), async (req, res) => {
  if (!req.store?.id) {
    return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');
  }

  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let query = supabase
      .from('cart_sessions')
      .select('id, phone, customer_name, items, status, reminder_sent, reminder_sent_at, last_interaction_at, created_at', { count: 'exact' })
      .eq('store_id', req.store.id)
      .order('last_interaction_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && ['active', 'abandoned', 'recovered', 'expired'].includes(status)) {
      query = query.eq('status', status);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    return sendSuccess(res, {
      sessions: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (err) {
    logger.error(`[CartRoute] Admin sessions fetch error: ${err.message}`);
    return apiError(res, 500, 'Failed to load cart sessions', 'FETCH_SESSIONS_FAILED');
  }
});

module.exports = router;
