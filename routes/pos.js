'use strict';

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { verifyPermission } = require('../middleware/auth');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');
const logger = require('../utils/logger');

// ── GET /api/pos/products ──
// Fast, indexed product search and catalog for POS tablet cashier
router.get('/products', verifyPermission('orders.create'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { q, category_id } = req.query;
    let query = supabase
      .from('products')
      .select('id, name, price, stock_quantity, image, category_id, barcode, sku, is_active, is_deleted')
      .eq('store_id', req.store.id)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .order('name', { ascending: true })
      .limit(100);

    if (category_id && category_id !== 'all') {
      query = query.eq('category_id', category_id);
    }

    if (q && q.trim()) {
      const searchTerm = q.trim();
      // Search by name, barcode, or sku
      query = query.or(`name.ilike.%${searchTerm}%,barcode.ilike.%${searchTerm}%,sku.ilike.%${searchTerm}%`);
    }

    const { data: products, error } = await query;
    if (error) throw error;

    sendSuccess(res, { products: products || [] });
  } catch (err) {
    logger.error('[pos] products lookup failed:', err.message);
    apiError(res, 500, 'Failed to fetch POS products', 'HTTP_500');
  }
});

// ── GET /api/pos/categories ──
// Quick category filter buttons for POS
router.get('/categories', verifyPermission('orders.create'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { data: categories, error } = await supabase
      .from('categories')
      .select('id, name, image')
      .eq('store_id', req.store.id)
      .order('name', { ascending: true });

    if (error) throw error;

    sendSuccess(res, { categories: categories || [] });
  } catch (err) {
    logger.error('[pos] categories lookup failed:', err.message);
    apiError(res, 500, 'Failed to fetch categories', 'HTTP_500');
  }
});

// ── POST /api/pos/orders ──
// Executes atomic POS cashier sale, decrements stock atomically, and records delivered order
router.post('/orders', verifyPermission('orders.create'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const {
    items,
    payment_method = 'cash',
    discount_amount = 0,
    customer_name = 'عميل نقدي',
    customer_phone = null,
    notes = '',
    cash_tendered = null,
    change_due = null
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return apiError(res, 400, 'السلة فارغة. يرجى إضافة منتج واحد على الأقل.', 'CART_EMPTY');
  }

  const userId = req.user?.sub || req.user?.id || null;

  try {
    // 1. Execute atomic RPC
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_pos_order_atomic', {
      p_store_id: req.store.id,
      p_user_id: userId,
      p_items: items,
      p_payment_method: payment_method === 'card' ? 'card' : 'cash',
      p_discount_amount: Number(discount_amount) || 0,
      p_customer_name: customer_name || 'عميل نقدي',
      p_customer_phone: customer_phone || null,
      p_notes: notes || '',
      p_cash_tendered: cash_tendered != null ? Number(cash_tendered) : null,
      p_change_due: change_due != null ? Number(change_due) : null
    });

    if (rpcError) {
      logger.error('[pos] atomic order error:', rpcError.message);
      return apiError(res, 400, rpcError.message || 'تعذر إتمام عملية البيع بالكاشير', 'POS_ORDER_FAILED');
    }

    // 2. Fetch store order prefix
    const { data: settings } = await supabase
      .from('site_settings')
      .select('order_prefix, brand_name, brand_logo, logo_url')
      .eq('store_id', req.store.id)
      .maybeSingle();

    const orderPrefix = settings?.order_prefix || 'EG-';
    const formattedOrderNumber = `${orderPrefix}${rpcResult.order_number}`;

    logger.info(`[pos] Sale completed: Order #${formattedOrderNumber} (Store: ${req.store.id}) Total: ${rpcResult.total} EGP`);

    sendSuccess(res, {
      ...rpcResult,
      order_prefix: orderPrefix,
      formatted_order_number: formattedOrderNumber,
      store_name: settings?.brand_name || req.store.name || 'المتجر',
      store_logo: settings?.logo_url || settings?.brand_logo || null,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    logger.error('[pos] order creation failed:', err.message);
    apiError(res, 500, err.message || 'حدث خطأ أثناء إتمام الطلب', 'HTTP_500');
  }
});

module.exports = router;
