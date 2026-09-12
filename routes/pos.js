'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase } = require('../services/supabase');
const { verifyUser, verifyPermission, optionalAuth } = require('../middleware/auth');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');
const logger = require('../utils/logger');
const rateLimit = require('express-rate-limit');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const whatsappPoolService = require('../services/whatsappPoolService');
const { generateReceiptPdf } = require('../services/receiptPdfService');
const {
  posOrderSchema,
  posReturnSchema,
  openShiftSchema,
  cashMovementSchema,
  closeShiftSchema,
  sendReceiptSchema,
  createCashierSchema,
  updateCashierSchema,
  switchCashierSchema,
  managerPinSchema,
  setManagerPinSchema
} = require('../schemas/posSchemas');

// Dedicated rate limiter for staff authentication / switch attempts (10 attempts/minute per IP)
const staffAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'تم تجاوز عدد محاولات تسجيل الدخول المسموح بها. يرجى الانتظار دقيقة والمحاولة مرة أخرى.',
    data: null
  }
});
const posPinLimiter = staffAuthLimiter;

function hashPin(storeId, pin) {
  return crypto.createHash('sha256').update(`${storeId}:${String(pin).trim()}`).digest('hex');
}

async function resolveStoreOwnerUserId(storeId, currentUserId) {
  try {
    if (currentUserId && currentUserId !== 'manager') {
      const { data: directRole } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('store_id', storeId)
        .eq('user_id', currentUserId)
        .maybeSingle();
      if (directRole?.user_id) return directRole.user_id;
    }

    // Resolve true store owner from user_roles
    const { data: storeOwnerRole } = await supabase
      .from('user_roles')
      .select('user_id, roles!inner(name, role_type)')
      .eq('store_id', storeId)
      .eq('roles.role_type', 'tenant')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (storeOwnerRole?.user_id) return storeOwnerRole.user_id;

    // Secondary fallback: first user assigned to this store
    const { data: anyStoreUser } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('store_id', storeId)
      .limit(1)
      .maybeSingle();

    if (anyStoreUser?.user_id) return anyStoreUser.user_id;
  } catch (err) {
    logger.warn('[pos] resolveStoreOwnerUserId failed:', err.message);
  }
  return currentUserId || 'manager';
}

// ── GET /api/pos/products ──
// Fast, indexed product search and catalog for POS tablet cashier
router.get('/products', verifyPermission(['tenant.orders.read', 'orders.view', 'tenant.products.read', 'products.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { q, category_id, category } = req.query;
    const catFilter = category || category_id;

    let matchedVariantId = null;
    let barcodeProductId = null;
    if (q && q.trim()) {
      const normBarcode = q.trim().toLowerCase();
      const { data: regMatch } = await supabase
        .from('store_barcode_registry')
        .select('entity_type, entity_id, product_id')
        .eq('store_id', req.store.id)
        .eq('normalized_barcode', normBarcode)
        .maybeSingle();

      if (regMatch) {
        barcodeProductId = regMatch.product_id;
        if (regMatch.entity_type === 'variant') {
          matchedVariantId = regMatch.entity_id;
        }
      }
    }

    let query = supabase
      .from('products')
      .select('id, name, price, stock_quantity, stock, image, category, part_number, is_active, is_deleted, specs, has_variants, options_summary')
      .eq('store_id', req.store.id)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .order('name', { ascending: true })
      .limit(200);

    if (catFilter && catFilter !== 'all') {
      query = query.eq('category', catFilter);
    }

    if (barcodeProductId) {
      query = query.eq('id', barcodeProductId);
    } else if (q && q.trim()) {
      const searchTerm = q.trim();
      query = query.or(`name.ilike.%${searchTerm}%,part_number.ilike.%${searchTerm}%,category.ilike.%${searchTerm}%`);
    }

    const { data: products, error } = await query;
    if (error) throw error;

    const variantProductIds = (products || []).filter(p => p.has_variants).map(p => p.id);
    let variantsByProduct = {};
    if (variantProductIds.length > 0) {
      const { data: dbVariants } = await supabase
        .from('product_variants')
        .select('id, product_id, title, price, stock_quantity, sku, barcode, combination_key, is_active')
        .in('product_id', variantProductIds)
        .eq('store_id', req.store.id)
        .eq('is_active', true)
        .eq('is_archived', false)
        .order('created_at', { ascending: true });

      (dbVariants || []).forEach(v => {
        if (!variantsByProduct[v.product_id]) variantsByProduct[v.product_id] = [];
        variantsByProduct[v.product_id].push(v);
      });
    }

    const normalized = (products || []).map(p => ({
      ...p,
      stock_quantity: p.stock_quantity !== null && p.stock_quantity !== undefined ? p.stock_quantity : (p.stock || 0),
      sku: p.part_number || '',
      barcode: p.specs?.barcode || p.part_number || '',
      variants: variantsByProduct[p.id] || [],
      matched_variant_id: barcodeProductId && p.id === barcodeProductId ? matchedVariantId : null
    }));

    sendSuccess(res, { products: normalized });
  } catch (err) {
    logger.error('[pos] products lookup failed:', err.message);
    apiError(res, 500, 'Failed to fetch POS products', 'HTTP_500');
  }
});

// ── GET /api/pos/categories ──
// Quick category filter buttons for POS
router.get('/categories', verifyPermission(['tenant.orders.read', 'orders.view', 'tenant.products.read', 'products.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { data, error } = await supabase
      .from('products')
      .select('category')
      .eq('store_id', req.store.id)
      .eq('is_deleted', false)
      .eq('is_active', true)
      .not('category', 'is', null);

    if (error) throw error;

    const uniqueCategories = [...new Set((data || []).map(p => p.category?.trim()).filter(Boolean))].map(cat => ({
      id: cat,
      name: cat
    }));

    sendSuccess(res, { categories: uniqueCategories });
  } catch (err) {
    logger.error('[pos] categories lookup failed:', err.message);
    apiError(res, 500, 'Failed to fetch categories', 'HTTP_500');
  }
});

// ── POST /api/pos/orders ──
// Executes atomic POS cashier sale, decrements stock atomically, and records delivered order
router.post('/orders', verifyPermission(['tenant.orders.write', 'orders.create', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = posOrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorMsg = parseResult.error?.issues?.[0]?.message || parseResult.error?.errors?.[0]?.message || 'بيانات الطلب غير صالحة';
    return apiError(res, 400, errorMsg, 'VALIDATION_ERROR');
  }

  const {
    items,
    payment_method,
    discount_amount,
    customer_name,
    customer_phone,
    notes,
    cash_tendered,
    change_due
  } = parseResult.data;

  const userId = req.user?.sub || req.user?.id || null;
  let posReservationKey = null;

  try {
    // 1. Quota check & reservation for orders_per_month with high POS resilience
    const activeSub = await subscriptionLimitService.getActiveStoreSubscription(req.store.id).catch(() => null);
    const planCode = String(activeSub?.plans?.code || 'free').toLowerCase();
    const isFreePlan = planCode === 'free';
    const limitState = await subscriptionLimitService.checkFeatureLimit(req.store.id, 'orders_per_month', 1).catch(() => ({ allowed: true }));

    if (isFreePlan && !limitState.allowed && !limitState.is_unlimited) {
      return apiError(
        res,
        403,
        'عذراً، لقد استنفد المتجر الحد الأقصى للطلبات المسموحة في الخطة المجانية لهذا الشهر. يرجى ترقية باقة المتجر من لوحة الإدارة للاستمرار في تسجيل مبيعات الكاشير.',
        'FREE_PLAN_ORDER_LIMIT_REACHED'
      );
    }

    posReservationKey = `pos-${req.store.id}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    await subscriptionLimitService.reserveFeatureUsage(req.store.id, 'orders_per_month', 1, posReservationKey).catch((e) => {
      logger.warn(`[POS] Quota reservation warning: ${e.message}`);
    });

    // 2. Execute atomic RPC (sanitizing items to strip any client-sent price)
    const sanitizedItems = items.map(it => ({
      id: it.id,
      variant_id: it.variant_id || null,
      qty: Number(it.qty),
      name: it.name || undefined
    }));
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_pos_order_atomic', {
      p_store_id: req.store.id,
      p_user_id: userId,
      p_items: sanitizedItems,
      p_payment_method: payment_method === 'card' ? 'card' : 'cash',
      p_discount_amount: Number(discount_amount) || 0,
      p_customer_name: customer_name || 'عميل نقدي',
      p_customer_phone: customer_phone || null,
      p_notes: notes || '',
      p_cash_tendered: cash_tendered != null ? Number(cash_tendered) : null,
      p_change_due: change_due != null ? Number(change_due) : null,
      p_customer_user_id: null
    });

    if (rpcError) {
      await subscriptionLimitService.rollbackFeatureUsage(posReservationKey).catch(() => {});
      logger.error('[pos] atomic order error:', rpcError.message);
      return apiError(res, 400, rpcError.message || 'تعذر إتمام عملية البيع بالكاشير', 'POS_ORDER_FAILED');
    }

    await subscriptionLimitService.commitFeatureUsage(posReservationKey).catch((e) => {
      logger.warn(`[POS] Quota commit warning: ${e.message}`);
    });

    // 3. Soft limit overage detection for paid plans
    if (!isFreePlan && !limitState.is_unlimited && limitState.limit > 0 && (Number(limitState.usage || 0) + 1 >= Number(limitState.limit))) {
      Promise.all([
        supabase.from('stores').update({ is_over_quota: true, quota_overage_detected_at: new Date().toISOString() }).eq('id', req.store.id),
        supabase.from('store_subscriptions').update({ is_over_quota: true, quota_overage_detected_at: new Date().toISOString() }).eq('store_id', req.store.id)
      ]).catch(err => logger.warn(`[POS] Failed to flag store overage: ${err.message}`));
    }

    // 2. Persist active cashier name and ID in order metadata if supplied from POS terminal
    if (rpcResult?.order_id && (req.body?.cashier_name || req.body?.cashier_id)) {
      const activeCashierName = req.body.cashier_name || 'الكاشير';
      await supabase
        .from('orders')
        .update({
          metadata: {
            channel: 'pos',
            cashier_id: req.body.cashier_id || null,
            cashier_name: activeCashierName,
            customer_name: customer_name || 'عميل نقدي',
            cash_tendered: cash_tendered != null ? Number(cash_tendered) : null,
            change_due: change_due != null ? Number(change_due) : null,
            source: 'pos_terminal'
          }
        })
        .eq('id', rpcResult.order_id);
      rpcResult.cashier_name = activeCashierName;
    }

    // 3. Fetch store order prefix
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
    if (posReservationKey) {
      await subscriptionLimitService.rollbackFeatureUsage(posReservationKey).catch(() => {});
    }
    logger.error('[pos] order creation failed:', err.message);
    apiError(res, 500, err.message || 'حدث خطأ أثناء إتمام الطلب', 'HTTP_500');
  }
});

// ── GET /api/pos/orders/lookup/:query ──
// Look up an existing order by barcode or order number for returns
router.get('/orders/lookup/:query', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const rawQuery = req.params.query.trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawQuery);
    const cleanedNumber = rawQuery.replace(/\D/g, '');

    let orderQuery = supabase
      .from('orders')
      .select('id, order_number, total, subtotal, discount, discount_amount, payment_method, status, payment_status, items, created_at, phone, metadata')
      .eq('store_id', req.store.id);

    if (isUuid) {
      orderQuery = orderQuery.eq('id', rawQuery);
    } else if (cleanedNumber) {
      orderQuery = orderQuery.eq('order_number', Number(cleanedNumber));
    } else {
      return apiError(res, 400, 'صيغة رقم الفاتورة أو الباركود غير صالحة', 'INVALID_LOOKUP_QUERY');
    }

    const { data: order, error } = await orderQuery.maybeSingle();
    if (error) throw error;
    if (!order) {
      return apiError(res, 404, 'لم يتم العثور على فاتورة بهذا الرقم في هذا المتجر', 'ORDER_NOT_FOUND');
    }

    // Check existing returns on this order
    const { data: existingReturns } = await supabase
      .from('pos_returns')
      .select('id, return_number, items, total_refund, created_at, refund_method')
      .eq('order_id', order.id)
      .eq('store_id', req.store.id);

    // Calculate returned quantities per product
    const returnedQtys = {};
    for (const ret of (existingReturns || [])) {
      if (Array.isArray(ret.items)) {
        for (const item of ret.items) {
          const itemId = item.id || item.product_id;
          if (itemId) {
            returnedQtys[itemId] = (returnedQtys[itemId] || 0) + (Number(item.qty) || 0);
          }
        }
      }
    }

    // Attach returnable status to each item
    const items = (Array.isArray(order.items) ? order.items : []).map(item => {
      const itemId = item.id || item.product_id;
      const originalQty = Number(item.qty || item.quantity || 1);
      const alreadyReturned = returnedQtys[itemId] || 0;
      const returnableQty = Math.max(0, originalQty - alreadyReturned);

      return {
        ...item,
        id: itemId,
        original_qty: originalQty,
        already_returned_qty: alreadyReturned,
        returnable_qty: returnableQty,
        can_return: returnableQty > 0
      };
    });

    const isFullyReturned = items.length > 0 && items.every(i => i.returnable_qty === 0);

    sendSuccess(res, {
      order: {
        ...order,
        items,
        is_fully_returned: isFullyReturned,
        returns_history: existingReturns || []
      }
    });
  } catch (err) {
    logger.error('[pos] order lookup failed:', err.message);
    apiError(res, 500, 'فشل البحث عن الفاتورة', 'HTTP_500');
  }
});

// ── POST /api/pos/returns ──
// Execute atomic cashier return with inventory restock or scrap
router.post('/returns', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = posReturnSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات الإرجاع غير صالحة', 'VALIDATION_ERROR');
  }

  const {
    order_id,
    items,
    refund_method,
    reason,
    allow_negative_cash,
    manager_pin,
    override_reason
  } = parseResult.data;
  const userId = req.user?.sub || req.user?.id || null;

  try {
    // Manager authorization check if negative cash override requested
    let isManagerAuthorized = false;
    if (allow_negative_cash) {
      const userRole = String(req.user?.role || '').toLowerCase();
      if (['owner', 'manager', 'admin', 'superadmin'].includes(userRole) || req.isStoreOwner) {
        isManagerAuthorized = true;
      } else if (manager_pin) {
        const pinHash = hashPin(req.store.id, manager_pin);
        const { data: storeRow } = await supabase
          .from('stores')
          .select('pos_manager_pin_hash')
          .eq('id', req.store.id)
          .maybeSingle();

        if (storeRow?.pos_manager_pin_hash && storeRow.pos_manager_pin_hash === pinHash) {
          isManagerAuthorized = true;
        } else {
          return apiError(res, 403, 'رمز PIN الخاص بالمدير غير صحيح', 'INVALID_MANAGER_PIN');
        }
      } else {
        return apiError(res, 403, 'تجاوز رصيد الدرج يتطلب مصادقة أو رمز PIN الخاص بالمدير', 'MANAGER_AUTHORIZATION_REQUIRED');
      }
    }

    // Authoritative refund pricing: client-supplied prices are strictly ignored
    // to prevent tampering; unit prices are authoritatively determined from the original order in the DB.
    const sanitizedReturnItems = items.map(it => ({
      id: it.id,
      product_id: it.id,
      qty: Number(it.qty),
      condition: it.condition || 'sound',
      name: it.name || undefined
    }));
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_pos_return_atomic', {
      p_store_id: req.store.id,
      p_order_id: order_id,
      p_user_id: userId,
      p_items: sanitizedReturnItems,
      p_refund_method: refund_method,
      p_reason: reason || 'مرتجع كاشير',
      p_allow_negative_cash: Boolean(allow_negative_cash && isManagerAuthorized),
      p_override_reason: override_reason || (allow_negative_cash ? 'تصريح استثنائي للمدير' : null)
    });

    if (rpcError) {
      logger.error('[pos] atomic return error:', rpcError.message);
      if (rpcError.message && rpcError.message.includes('INSUFFICIENT_DRAWER_CASH')) {
        return apiError(res, 400, rpcError.message, 'INSUFFICIENT_DRAWER_CASH');
      }
      return apiError(res, 400, rpcError.message || 'تعذر إتمام عملية الإرجاع', 'POS_RETURN_FAILED');
    }

    logger.info(`[pos] Return processed: ${rpcResult.return_number} (Store: ${req.store.id}) Refund: ${rpcResult.total_refund} EGP Override: ${rpcResult.manager_override}`);

    sendSuccess(res, {
      ...rpcResult,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    logger.error('[pos] return creation failed:', err.message);
    apiError(res, 500, err.message || 'حدث خطأ أثناء إتمام عملية الإرجاع', 'HTTP_500');
  }
});

// ── POST /api/pos/orders/:id/send-receipt ──
// Generate vector PDF receipt and dispatch to customer via WhatsApp
router.post('/orders/:id/send-receipt', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = sendReceiptSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'رقم الهاتف مطلوب', 'VALIDATION_ERROR');
  }

  const { phone } = parseResult.data;

  try {
    // 1. Fetch order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, total, total_amount, subtotal, discount, discount_amount, payment_method, items, created_at, phone, metadata')
      .eq('id', req.params.id)
      .eq('store_id', req.store.id)
      .single();

    if (orderError || !order) {
      return apiError(res, 404, 'الفاتورة غير موجودة', 'ORDER_NOT_FOUND');
    }

    // 2. Fetch store prefix & branding
    const { data: settings } = await supabase
      .from('site_settings')
      .select('order_prefix, brand_name')
      .eq('store_id', req.store.id)
      .maybeSingle();

    const orderPrefix = settings?.order_prefix || 'EG-';
    const formattedOrderNumber = `${orderPrefix}${order.order_number}`;

    // 3. Generate high-quality single-page vector PDF receipt
    const { pdfBuffer, fileName } = await generateReceiptPdf({
      order: {
        ...order,
        formatted_order_number: formattedOrderNumber
      },
      store: {
        name: settings?.brand_name || req.store.name || 'المتجر',
        subdomain: req.store.subdomain
      },
      cashierName: order.metadata?.cashier_name || 'الكاشير'
    });

    // 4. Dispatch via WhatsApp Pool
    const caption = `إيصال فاتورة مبيعات رقم ${formattedOrderNumber} من ${settings?.brand_name || req.store.name || 'المتجر'}. شكراً لتعاملكم معنا!`;
    await whatsappPoolService.sendDocument(phone, pdfBuffer, fileName, caption, {
      storeId: req.store.id
    });

    sendSuccess(res, {
      sent: true,
      phone,
      fileName,
      message: 'تم إرسال الفاتورة بنجاح عبر واتساب'
    });
  } catch (err) {
    logger.error('[pos] send receipt failed:', err.message);
    apiError(res, 500, err.message || 'فشل إرسال الفاتورة عبر واتساب', 'WHATSAPP_SEND_FAILED');
  }
});

// ── GET /api/pos/shifts/current ──
// Get current active open shift for this store
router.get('/shifts/current', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { data: shift, error } = await supabase
      .from('pos_shifts')
      .select('*')
      .eq('store_id', req.store.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!shift) {
      return sendSuccess(res, { shift: null });
    }

    const openingCash = Number(shift.opening_cash) || 0;
    const cashSales = Number(shift.cash_sales) || 0;
    const cardSales = Number(shift.card_sales) || 0;
    const totalSales = Number(shift.total_sales) || 0;
    const cashRefunds = Number(shift.cash_refunds) || 0;
    const cardRefunds = Number(shift.card_refunds) || 0;
    const totalRefunds = Number(shift.total_refunds) || 0;
    const payIns = Number(shift.pay_ins) || 0;
    const payOuts = Number(shift.pay_outs) || 0;
    const expectedCash = openingCash + cashSales - cashRefunds + payIns - payOuts;

    sendSuccess(res, {
      shift: {
        ...shift,
        opening_cash: openingCash,
        cash_sales: cashSales,
        card_sales: cardSales,
        total_sales: totalSales,
        cash_refunds: cashRefunds,
        card_refunds: cardRefunds,
        total_refunds: totalRefunds,
        pay_ins: payIns,
        pay_outs: payOuts,
        expected_cash: expectedCash
      }
    });
  } catch (err) {
    logger.error('[pos] get current shift failed:', err.message);
    apiError(res, 500, 'فشل جلب بيانات الوردية الحالية', 'HTTP_500');
  }
});

// ── POST /api/pos/shifts/open ──
// Open a new cashier shift with starting cash float
router.post('/shifts/open', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = openShiftSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات فتح الوردية غير صالحة', 'VALIDATION_ERROR');
  }

  const { opening_cash, notes } = parseResult.data;
  const userId = req.user?.sub || req.user?.id || null;

  try {
    // Check if an open shift already exists
    const { data: existing } = await supabase
      .from('pos_shifts')
      .select('id, opened_at, cashier_name')
      .eq('store_id', req.store.id)
      .eq('status', 'open')
      .maybeSingle();

    if (existing) {
      return apiError(res, 400, 'يوجد وردية مفتوحة بالفعل لهذا المتجر. يرجى إغلاقها أولاً.', 'SHIFT_ALREADY_OPEN');
    }

    // Resolve cashier name
    let cashierName = req.user?.user_metadata?.full_name || req.user?.name;
    if (!cashierName && userId) {
      const { data: prof } = await supabase.from('user_profiles').select('full_name').eq('user_id', userId).maybeSingle();
      cashierName = prof?.full_name;
    }
    cashierName = cashierName || 'الكاشير';

    const { data: newShift, error } = await supabase
      .from('pos_shifts')
      .insert({
        store_id: req.store.id,
        cashier_user_id: userId,
        cashier_name: cashierName,
        opening_cash: Number(opening_cash) || 0,
        notes: notes || '',
        status: 'open',
        pay_ins: 0,
        pay_outs: 0,
        cash_sales: 0,
        card_sales: 0,
        total_sales: 0,
        expected_cash: Number(opening_cash) || 0,
        cash_movements: []
      })
      .select()
      .single();

    if (error) throw error;

    logger.info(`[pos] Shift opened for store ${req.store.id} by ${cashierName} with ${opening_cash} EGP`);

    sendSuccess(res, {
      shift: {
        ...newShift,
        expected_cash: Number(newShift.opening_cash)
      }
    });
  } catch (err) {
    logger.error('[pos] open shift failed:', err.message);
    apiError(res, 500, err.message || 'فشل فتح الوردية', 'HTTP_500');
  }
});

// ── POST /api/pos/shifts/movement ──
// Record Cash In / Cash Out drawer movement
router.post('/shifts/movement', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = cashMovementSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات الحركة غير صالحة', 'VALIDATION_ERROR');
  }

  const { type, amount, reason } = parseResult.data;
  const userId = req.user?.sub || req.user?.id || null;

  try {
    // 1. Fetch current open shift
    const { data: shift, error: shiftError } = await supabase
      .from('pos_shifts')
      .select('*')
      .eq('store_id', req.store.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (shiftError || !shift) {
      return apiError(res, 400, 'لا توجد وردية مفتوحة لتسجيل الحركة النقدية', 'NO_OPEN_SHIFT');
    }

    const movement = {
      id: crypto.randomUUID(),
      type,
      amount: Number(amount),
      reason,
      cashier_id: userId,
      created_at: new Date().toISOString()
    };

    const currentMovements = Array.isArray(shift.cash_movements) ? shift.cash_movements : [];
    const updatedMovements = [...currentMovements, movement];

    const currentPayIns = Number(shift.pay_ins) || 0;
    const currentPayOuts = Number(shift.pay_outs) || 0;

    const newPayIns = type === 'pay_in' ? currentPayIns + Number(amount) : currentPayIns;
    const newPayOuts = type === 'pay_out' ? currentPayOuts + Number(amount) : currentPayOuts;

    const { data: updatedShift, error: updateError } = await supabase
      .from('pos_shifts')
      .update({
        cash_movements: updatedMovements,
        pay_ins: newPayIns,
        pay_outs: newPayOuts,
        updated_at: new Date().toISOString()
      })
      .eq('id', shift.id)
      .select()
      .single();

    if (updateError) throw updateError;

    const expectedCash = (Number(updatedShift.opening_cash) || 0) +
      (Number(updatedShift.cash_sales) || 0) -
      (Number(updatedShift.cash_refunds) || 0) +
      newPayIns - newPayOuts;

    sendSuccess(res, {
      movement,
      shift: {
        ...updatedShift,
        expected_cash: expectedCash
      }
    });
  } catch (err) {
    logger.error('[pos] cash movement failed:', err.message);
    apiError(res, 500, err.message || 'فشل تسجيل الحركة النقدية', 'HTTP_500');
  }
});

// ── POST /api/pos/shifts/close ──
// Close cashier shift, calculate drawer discrepancy, and produce Z-Report
router.post('/shifts/close', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = closeShiftSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات إغلاق الوردية غير صالحة', 'VALIDATION_ERROR');
  }

  const { shift_id, actual_cash, notes } = parseResult.data;

  try {
    let shift = null;
    if (shift_id) {
      const { data: byId, error: byIdErr } = await supabase
        .from('pos_shifts')
        .select('*')
        .eq('id', shift_id)
        .eq('store_id', req.store.id)
        .maybeSingle();

      if (byIdErr) {
        logger.error('[pos] Close shift query by ID failed:', byIdErr.message);
      } else if (byId) {
        if (byId.status !== 'open') {
          return apiError(res, 400, 'الوردية المحددة مغلقة بالفعل مسبقاً', 'SHIFT_ALREADY_CLOSED');
        }
        shift = byId;
      }
    }

    if (!shift) {
      const { data: latestOpen, error: shiftError } = await supabase
        .from('pos_shifts')
        .select('*')
        .eq('store_id', req.store.id)
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (shiftError) {
        logger.error('[pos] Close shift latest open query failed:', shiftError.message);
        return apiError(res, 500, 'تعذر التحقق من حالة الوردية الحالية', 'SHIFT_QUERY_FAILED');
      }
      shift = latestOpen;
    }

    if (!shift) {
      return apiError(res, 400, 'لا توجد وردية مفتوحة لإغلاقها', 'NO_OPEN_SHIFT');
    }

    const openingCash = Number(shift.opening_cash) || 0;
    const cashSales = Number(shift.cash_sales) || 0;
    const cardSales = Number(shift.card_sales) || 0;
    const totalSales = Number(shift.total_sales) || 0;
    const cashRefunds = Number(shift.cash_refunds) || 0;
    const cardRefunds = Number(shift.card_refunds) || 0;
    const totalRefunds = Number(shift.total_refunds) || 0;
    const payIns = Number(shift.pay_ins) || 0;
    const payOuts = Number(shift.pay_outs) || 0;
    const expectedCash = openingCash + cashSales - cashRefunds + payIns - payOuts;
    const actualCash = Number(actual_cash);
    const difference = actualCash - expectedCash;

    const { data: closedShift, error: closeError } = await supabase
      .from('pos_shifts')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        expected_cash: expectedCash,
        actual_cash: actualCash,
        difference: difference,
        notes: notes || shift.notes || '',
        updated_at: new Date().toISOString()
      })
      .eq('id', shift.id)
      .select()
      .single();

    if (closeError) throw closeError;

    logger.info(`[pos] Shift ${shift.id} closed for store ${req.store.id}. Expected: ${expectedCash} EGP, Actual: ${actualCash} EGP, Diff: ${difference} EGP`);

    sendSuccess(res, {
      shift: closedShift,
      z_report: {
        shift_id: closedShift.id,
        opened_at: closedShift.opened_at,
        closed_at: closedShift.closed_at,
        cashier_name: closedShift.cashier_name,
        opening_cash: openingCash,
        cash_sales: cashSales,
        card_sales: cardSales,
        total_sales: totalSales,
        cash_refunds: cashRefunds,
        card_refunds: cardRefunds,
        total_refunds: totalRefunds,
        pay_ins: payIns,
        pay_outs: payOuts,
        expected_cash: expectedCash,
        actual_cash: actualCash,
        difference: difference,
        discrepancy_status: difference === 0 ? 'exact' : (difference > 0 ? 'surplus' : 'deficit')
      }
    });
  } catch (err) {
    logger.error('[pos] close shift failed:', err.message);
    apiError(res, 500, err.message || 'فشل إغلاق الوردية', 'HTTP_500');
  }
});

// ── GET /api/pos/shifts/history ──
// List past shifts with Z-Report metrics
router.get('/shifts/history', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: shifts, count, error } = await supabase
      .from('pos_shifts')
      .select('*', { count: 'exact' })
      .eq('store_id', req.store.id)
      .order('opened_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    sendSuccess(res, {
      shifts: shifts || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (err) {
    logger.error('[pos] shift history failed:', err.message);
    apiError(res, 500, 'فشل جلب سجل الورديات', 'HTTP_500');
  }
});

// ── POST /api/pos/switch-cashier & POST /api/pos/switch-staff ──
// Staff Authentication (Email & Password + Enterprise RBAC)
const handleStaffSwitch = async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = switchCashierSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorMsg = parseResult.error?.issues?.[0]?.message || parseResult.error?.errors?.[0]?.message || 'بيانات الدخول غير صالحة';
    return apiError(res, 400, errorMsg, 'VALIDATION_ERROR');
  }

  const { email, password } = parseResult.data;

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password: password
    });

    if (authErr || !authData?.user) {
      return apiError(res, 401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة', 'INVALID_CREDENTIALS');
    }

    const authUser = authData.user;
    const userId = authUser.id;
    const userName = authUser.user_metadata?.full_name || authUser.user_metadata?.name || normalizedEmail.split('@')[0];

    // Check user_roles (relational roles table)
    const { data: roleRows } = await supabase
      .from('user_roles')
      .select('user_id, store_id, role_id, roles(name)')
      .eq('user_id', userId);

    const isSuperAdmin = (roleRows || []).some(r => r.roles?.name === 'super_admin' || r.roles?.name === 'superadmin');
    const isStoreOwnerRole = (roleRows || []).some(r => (['owner', 'admin'].includes(r.roles?.name)) && (r.store_id === req.store.id || !r.store_id));

    // Check store_staff
    const { data: staffRow } = await supabase
      .from('store_staff')
      .select('id, store_id, user_id, role_name, is_active')
      .eq('store_id', req.store.id)
      .eq('user_id', userId)
      .maybeSingle();

    const isStaffManager = staffRow && staffRow.is_active && ['store_manager', 'manager', 'admin', 'owner'].includes(staffRow.role_name);
    const isStoreOwner = isStoreOwnerRole || isStaffManager;

    if (!isStoreOwner && !isSuperAdmin && !staffRow) {
      return apiError(res, 403, 'هذا الحساب ليس لديه صلاحية العمل في هذا المتجر', 'FORBIDDEN_STORE_ACCESS');
    }

    if (staffRow && !staffRow.is_active) {
      return apiError(res, 403, 'حساب هذا الموظف معطل حالياً', 'STAFF_INACTIVE');
    }

    const rawRole = staffRow?.role_name || (isStoreOwner ? 'owner' : isSuperAdmin ? 'super_admin' : 'cashier');
    const isCashier = rawRole === 'cashier';
    const mode = isCashier ? 'cashier' : 'manager';

    let sessionToken = null;
    if (process.env.SUPABASE_JWT_SECRET) {
      try {
        sessionToken = jwt.sign({
          sub: userId,
          store_id: req.store.id,
          role: isCashier ? 'cashier' : 'manager',
          staff_role: rawRole,
          cashier_name: userName,
          email: normalizedEmail,
          scope: isCashier ? 'cashier_pos_only' : 'manager_full'
        }, process.env.SUPABASE_JWT_SECRET, { expiresIn: '14h' });
      } catch (tokenErr) {
        logger.warn('[pos] could not sign session token:', tokenErr.message);
      }
    }

    return sendSuccess(res, {
      mode,
      cashier: {
        id: userId,
        name: userName,
        email: normalizedEmail,
        role: rawRole
      },
      session_token: sessionToken,
      access_token: authData.session?.access_token || null
    }, { message: `مرحباً بك يا ${userName}` });
  } catch (authCatchErr) {
    logger.error('[pos] email/password staff auth failed:', authCatchErr.message);
    return apiError(res, 500, 'فشل التحقق من بيانات الدخول', 'AUTH_ERROR');
  }
};

router.post('/switch-cashier', staffAuthLimiter, optionalAuth, handleStaffSwitch);
router.post('/switch-staff', staffAuthLimiter, optionalAuth, handleStaffSwitch);

// ── POST /api/pos/terminal/unlock ──
// ── POST /api/pos/terminal/unlock ──
// Unlock manager mode from POS Terminal using email & password
router.post('/terminal/unlock', staffAuthLimiter, optionalAuth, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = managerPinSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorMsg = parseResult.error?.issues?.[0]?.message || parseResult.error?.errors?.[0]?.message || 'بيانات المدير غير صالحة';
    return apiError(res, 400, errorMsg, 'VALIDATION_ERROR');
  }

  const { email, password } = parseResult.data;

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password: password
    });

    if (authErr || !authData?.user) {
      return apiError(res, 401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة', 'INVALID_CREDENTIALS');
    }

    const userId = authData.user.id;

    // Verify owner or superadmin or store_manager
    const [{ data: roleRows }, { data: staffRow }] = await Promise.all([
      supabase.from('user_roles').select('user_id, store_id, role_id, roles(name)').eq('user_id', userId),
      supabase.from('store_staff').select('id, role_name, is_active').eq('store_id', req.store.id).eq('user_id', userId).maybeSingle()
    ]);

    const isSuperAdmin = (roleRows || []).some(r => r.roles?.name === 'super_admin' || r.roles?.name === 'superadmin');
    const isStoreOwnerRole = (roleRows || []).some(r => (['owner', 'admin'].includes(r.roles?.name)) && (r.store_id === req.store.id || !r.store_id));
    const isManagerStaff = staffRow && staffRow.is_active && ['store_manager', 'manager', 'admin', 'owner'].includes(staffRow.role_name);
    const isStoreOwner = isStoreOwnerRole || isManagerStaff;

    if (!isStoreOwner && !isSuperAdmin && !isManagerStaff) {
      return apiError(res, 403, 'هذا الحساب لا يملك صلاحية إدارة المتجر لإلغاء القفل', 'NOT_A_MANAGER');
    }

    let managerToken = null;
    if (process.env.SUPABASE_JWT_SECRET) {
      try {
        managerToken = jwt.sign({
          sub: userId,
          store_id: req.store.id,
          role: 'manager',
          scope: 'manager_full',
          parent_user_id: userId
        }, process.env.SUPABASE_JWT_SECRET, { expiresIn: '14h' });
      } catch (tokenErr) {
        logger.warn('[pos] could not sign manager unlock token:', tokenErr.message);
      }
    }

    return sendSuccess(res, {
      unlocked: true,
      mode: 'manager',
      session_token: managerToken,
      access_token: authData.session?.access_token || null
    }, { message: 'تم إلغاء قفل الإدارة بنجاح' });
  } catch (err) {
    logger.error('[pos] terminal unlock email/pass failed:', err.message);
    return apiError(res, 500, 'فشل إلغاء قفل الـ POS', 'HTTP_500');
  }
});

// ── POST /api/pos/terminal/manager-pin ──
// Set or update store manager PIN
router.post('/terminal/manager-pin', verifyPermission(['settings.update', 'tenant.settings.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = setManagerPinSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorMsg = parseResult.error?.issues?.[0]?.message || parseResult.error?.errors?.[0]?.message || 'رمز PIN غير صالح';
    return apiError(res, 400, errorMsg, 'VALIDATION_ERROR');
  }

  const { pin } = parseResult.data;
  const pinHash = hashPin(req.store.id, pin);

  try {
    // Check if duplicate with any cashier PIN
    const { data: duplicateCashier } = await supabase
      .from('pos_cashiers')
      .select('id, name')
      .eq('store_id', req.store.id)
      .eq('pin_hash', pinHash)
      .maybeSingle();

    if (duplicateCashier) {
      return apiError(res, 400, `رمز الـ PIN هذا مستخدم بالفعل للكاشير (${duplicateCashier.name}). يرجى اختيار رمز مختلف.`, 'DUPLICATE_PIN');
    }

    const { error } = await supabase
      .from('stores')
      .update({ pos_manager_pin_hash: pinHash })
      .eq('id', req.store.id);

    if (error) throw error;

    const { tenantCache } = require('../utils/cache');
    if (tenantCache) {
      if (req.store.subdomain) tenantCache.delete(req.store.subdomain);
      if (req.store.custom_domain) tenantCache.delete(req.store.custom_domain);
    }

    sendSuccess(res, { updated: true }, { message: 'تم حفظ رمز PIN المدير بنجاح' });
  } catch (err) {
    logger.error('[pos] update manager pin failed:', err.message);
    apiError(res, 500, 'فشل حفظ رمز PIN المدير', 'HTTP_500');
  }
});

// ── GET /api/pos/cashiers ──
// List all store cashiers and staff for switcher and management
router.get('/cashiers', verifyPermission(['settings.view', 'settings.update', 'tenant.settings.read', 'tenant.settings.write', 'tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const [{ data: cashiers, error: cashiersErr }, { data: staffList }, { data: storeRow }] = await Promise.all([
      supabase
        .from('pos_cashiers')
        .select('id, name, phone, role, is_active, created_at, updated_at')
        .eq('store_id', req.store.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('store_staff')
        .select('id, user_id, role_name, invited_email, is_active, created_at')
        .eq('store_id', req.store.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('stores')
        .select('pos_manager_pin_hash')
        .eq('id', req.store.id)
        .maybeSingle()
    ]);

    if (cashiersErr) throw cashiersErr;

    const availableStaff = [
      ...(staffList || []).map(s => ({
        id: s.id,
        user_id: s.user_id,
        name: s.invited_email ? s.invited_email.split('@')[0] : 'موظف',
        email: s.invited_email,
        role: s.role_name,
        is_active: s.is_active
      })),
      ...(cashiers || []).filter(c => !(staffList || []).some(s => s.invited_email === c.name)).map(c => ({
        id: c.id,
        name: c.name,
        email: null,
        role: c.role,
        is_active: c.is_active
      }))
    ];

    sendSuccess(res, {
      cashiers: cashiers || [],
      staff: staffList || [],
      available_staff: availableStaff,
      has_manager_pin: Boolean(storeRow?.pos_manager_pin_hash)
    });
  } catch (err) {
    logger.error('[pos] list cashiers failed:', err.message);
    apiError(res, 500, 'فشل جلب قائمة الكاشيرين', 'HTTP_500');
  }
});

// ── POST /api/pos/cashiers ──
// Create a new store cashier
router.post('/cashiers', verifyPermission(['settings.update', 'tenant.settings.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = createCashierSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات الكاشير غير صالحة', 'VALIDATION_ERROR');
  }

  const { name, phone, role, pin } = parseResult.data;
  const pinHash = hashPin(req.store.id, pin);

  try {
    // 1. Check uniqueness against Manager PIN
    const { data: storeRow } = await supabase
      .from('stores')
      .select('pos_manager_pin_hash')
      .eq('id', req.store.id)
      .maybeSingle();

    if (storeRow?.pos_manager_pin_hash === pinHash) {
      return apiError(res, 400, 'هذا الرمز مطابق لرمز PIN المدير، يرجى اختيار رمز آخر للكاشير', 'DUPLICATE_PIN');
    }

    // 2. Check uniqueness against other cashiers
    const { data: existingCashier } = await supabase
      .from('pos_cashiers')
      .select('id, name')
      .eq('store_id', req.store.id)
      .eq('pin_hash', pinHash)
      .maybeSingle();

    if (existingCashier) {
      return apiError(res, 400, `رمز الـ PIN هذا مسجل بالفعل للكاشير (${existingCashier.name})`, 'DUPLICATE_PIN');
    }

    // 3. Insert cashier
    const { data: newCashier, error: insertError } = await supabase
      .from('pos_cashiers')
      .insert({
        store_id: req.store.id,
        name,
        phone: phone || null,
        role,
        pin_hash: pinHash,
        is_active: true
      })
      .select('id, name, phone, role, is_active, created_at, updated_at')
      .single();

    if (insertError) throw insertError;

    sendSuccess(res, { cashier: newCashier }, { status: 201, message: 'تمت إضافة الكاشير بنجاح' });
  } catch (err) {
    logger.error('[pos] create cashier failed:', err.message);
    apiError(res, 500, err.message || 'فشل إضافة الكاشير', 'HTTP_500');
  }
});

// ── PATCH /api/pos/cashiers/:id ──
// Update cashier details or reset PIN
router.patch('/cashiers/:id', verifyPermission(['settings.update', 'tenant.settings.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = updateCashierSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات التحديث غير صالحة', 'VALIDATION_ERROR');
  }

  const { name, phone, role, pin, is_active } = parseResult.data;
  const updateData = { updated_at: new Date().toISOString() };

  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone || null;
  if (role !== undefined) updateData.role = role;
  if (is_active !== undefined) updateData.is_active = is_active;

  try {
    if (pin) {
      const pinHash = hashPin(req.store.id, pin);

      // Check manager pin
      const { data: storeRow } = await supabase
        .from('stores')
        .select('pos_manager_pin_hash')
        .eq('id', req.store.id)
        .maybeSingle();

      if (storeRow?.pos_manager_pin_hash === pinHash) {
        return apiError(res, 400, 'هذا الرمز مطابق لرمز PIN المدير، يرجى اختيار رمز آخر للكاشير', 'DUPLICATE_PIN');
      }

      // Check other cashiers
      const { data: existingCashier } = await supabase
        .from('pos_cashiers')
        .select('id, name')
        .eq('store_id', req.store.id)
        .eq('pin_hash', pinHash)
        .neq('id', req.params.id)
        .maybeSingle();

      if (existingCashier) {
        return apiError(res, 400, `رمز الـ PIN هذا مسجل بالفعل للكاشير (${existingCashier.name})`, 'DUPLICATE_PIN');
      }

      updateData.pin_hash = pinHash;
    }

    const { data: updatedCashier, error: updateError } = await supabase
      .from('pos_cashiers')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('store_id', req.store.id)
      .select('id, name, phone, role, is_active, created_at, updated_at')
      .single();

    if (updateError) throw updateError;
    if (!updatedCashier) return apiError(res, 404, 'الكاشير غير موجود', 'CASHIER_NOT_FOUND');

    sendSuccess(res, { cashier: updatedCashier }, { message: 'تم تحديث بيانات الكاشير بنجاح' });
  } catch (err) {
    logger.error('[pos] update cashier failed:', err.message);
    apiError(res, 500, 'فشل تحديث بيانات الكاشير', 'HTTP_500');
  }
});

// ── DELETE /api/pos/cashiers/:id ──
// Delete a store cashier
router.delete('/cashiers/:id', verifyPermission(['settings.update', 'tenant.settings.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { error } = await supabase
      .from('pos_cashiers')
      .delete()
      .eq('id', req.params.id)
      .eq('store_id', req.store.id);

    if (error) throw error;

    sendSuccess(res, { deleted: true }, { message: 'تم حذف الكاشير بنجاح' });
  } catch (err) {
    logger.error('[pos] delete cashier failed:', err.message);
    apiError(res, 500, 'فشل حذف الكاشير', 'HTTP_500');
  }
});

module.exports = router;
