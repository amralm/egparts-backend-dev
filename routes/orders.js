const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { optionalAuth, verifyUser, verifyPermission } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const { assertPaymentMethodAvailable } = require('../services/paymentMethodPolicy');
const { validateBody } = require('../middleware/requestValidation');
const { createOrderSchema, whatsappOrderSchema, orderStatusSchema } = require('../schemas/orderSchemas');
const { normalizePaymentMethod } = require('../schemas/canonicalSchemas');
const { calculateCouponDiscount } = require('../services/couponService');
const abandonedCartService = require('../services/abandonedCartService');
const { sendOrderDeliveredInvoiceWhatsApp } = require('../services/orderInvoiceNotifier');
const logger = require('../utils/logger');
const shippingZoneEngine = require('../services/location/shippingZoneEngine');

const PLAN_UPGRADE_CHAIN = {
  free: 'basic',
  basic: 'starter',
  starter: 'growth',
  growth: 'scale',
  scale: 'enterprise'
};

async function processOrderQuotaReservation(storeId, reservationKey) {
  const activeSub = await subscriptionLimitService.getActiveStoreSubscription(storeId);
  const planCode = String(activeSub?.plans?.code || 'free').toLowerCase();
  const isFreePlan = planCode === 'free';

  // Check quota for orders_per_month
  const limitState = await subscriptionLimitService.checkFeatureLimit(storeId, 'orders_per_month', 1);

  if (isFreePlan) {
    // 1. FREE PLAN: Hard Cap.
    // Merchants on Free tier (0 EGP) cannot exceed their allowance without upgrading.
    if (!limitState.allowed && !limitState.is_unlimited) {
      return {
        allowed: false,
        error: 'عذراً، لقد استنفد المتجر الحد الأقصى للطلبات المسموحة في الخطة المجانية لهذا الشهر. يرجى ترقية باقة المتجر للاستمرار في استقبال طلبات جديدة.',
        code: 'FREE_PLAN_ORDER_LIMIT_REACHED'
      };
    }
    await subscriptionLimitService.reserveFeatureUsage(storeId, 'orders_per_month', 1, reservationKey).catch((e) => {
      logger.warn(`[Orders] Free plan quota reservation warning: ${e.message}`);
    });
    return { allowed: true, isFreePlan: true };
  }

  // 2. PAID PLANS: Soft Limit with Grace Overage.
  // Paying subscribers are NEVER blocked from accepting customer orders.
  // When they cross their plan limit, we mark the store with an overage flag for upcoming billing cycle upgrade.
  const isOverLimit = !limitState.is_unlimited && limitState.limit > 0 && (Number(limitState.usage || 0) + 1 >= Number(limitState.limit));
  if (isOverLimit) {
    const suggestedCode = PLAN_UPGRADE_CHAIN[planCode] || 'enterprise';
    Promise.all([
      supabase.from('stores').update({
        is_over_quota: true,
        quota_overage_detected_at: new Date().toISOString(),
        suggested_plan_code: suggestedCode
      }).eq('id', storeId),
      supabase.from('store_subscriptions').update({
        is_over_quota: true,
        quota_overage_detected_at: new Date().toISOString(),
        suggested_plan_code: suggestedCode
      }).eq('store_id', storeId)
    ]).catch(err => logger.warn(`[Orders] Failed to flag store overage: ${err.message}`));
  }

  await subscriptionLimitService.reserveFeatureUsage(storeId, 'orders_per_month', 1, reservationKey).catch((e) => {
    logger.warn(`[Orders] Paid plan quota reservation warning: ${e.message}`);
  });

  return { allowed: true, isFreePlan: false, isOverLimit };
}

// Rate limiting for order creation (10 requests per minute per IP)
const orderRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, code: 'RATE_LIMITED', message: 'طلبات إنشاء الطلبات كثيرة جداً، حاول بعد دقيقة', data: null }
});

function enrichOrderItems(order) {
  if (!order) return order;
  if (Array.isArray(order.items)) {
    order.items = order.items.map(item => {
      const title = item.title || item.name || '';
      return {
        ...item,
        id: item.id || item.product_id,
        variant_id: item.variant_id || null,
        variant_title_snapshot: item.variant_title_snapshot || item.variant_title || null,
        title: title,
        name: item.name || title,
        qty: Number(item.qty ?? item.quantity ?? 1),
        price: item.price !== undefined ? Number(item.price) : (item.unit_price !== undefined ? Number(item.unit_price) : undefined)
      };
    });
  }
  return order;
}

router.get('/my', verifyUser, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', `HTTP_400`);

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, payment_intents(id, status, metadata)')
      .eq('store_id', req.store.id)
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false });

    if (error) throw error;
    sendSuccess(res, { orders: (data || []).map(enrichOrderItems) });
  } catch (error) {
    console.error('Customer orders list error:', error.message);
    apiError(res, 500, 'Failed to load orders', `HTTP_500`);
  }
});

router.get('/:id/tracking', optionalAuth, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', `HTTP_400`);

  const rawQuery = String(req.params.id || '').trim();
  if (!rawQuery) return apiError(res, 400, 'Order ID is required', `HTTP_400`);

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawQuery);
    const numericMatch = rawQuery.match(/\d+/);
    const orderNum = numericMatch ? parseInt(numericMatch[0], 10) : null;

    let queryBuilder = supabase
      .from('orders')
      .select('*')
      .eq('store_id', req.store.id);

    if (isUuid) {
      queryBuilder = queryBuilder.eq('id', rawQuery);
    } else if (orderNum) {
      queryBuilder = queryBuilder.eq('order_number', orderNum);
    } else {
      queryBuilder = queryBuilder.eq('id', rawQuery);
    }

    const { data: order, error: orderError } = await queryBuilder.maybeSingle();

    if (orderError) throw orderError;
    if (!order) return apiError(res, 404, 'الطلب غير موجود، يرجى التأكد من الرقم الصحيح', `HTTP_404`);

    const { data: tracking, error: trackingError } = await supabase
      .from('order_tracking')
      .select('*')
      .eq('order_id', order.id)
      .order('created_at', { ascending: true });

    if (trackingError) throw trackingError;

    const isOwner = req.user?.sub && order.user_id === req.user.sub;
    
    // If not authenticated owner, mask phone & detailed address to safeguard customer privacy
    let outputOrder = enrichOrderItems(order);
    if (!isOwner) {
      outputOrder = {
        ...outputOrder,
        phone: order.phone ? order.phone.replace(/(\d{3})\d{4,6}(\d{3})/, '$1****$2') : '',
        address: order.city || 'العنوان محمي',
      };
    }

    sendSuccess(res, { order: outputOrder, tracking: tracking || [] });
  } catch (error) {
    console.error('Customer order tracking error:', error.message);
    apiError(res, 500, 'Failed to load order tracking', `HTTP_500`);
  }
});

router.get('/admin/list', verifyPermission('orders.view'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', `HTTP_400`);

  try {
    const { productId } = req.query;
    let filterProduct = null;

    if (productId) {
      const { data: product } = await supabase
        .from('products')
        .select('id, name, image')
        .eq('id', productId)
        .eq('store_id', req.store.id)
        .maybeSingle();
      filterProduct = product || null;
    }

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('store_id', req.store.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    let orders = (data || []).map(enrichOrderItems);
    if (productId) {
      orders = orders.filter((order) => Array.isArray(order.items) && order.items.some((item) => item.id === productId));
    }

    sendSuccess(res, { orders, filter_product: filterProduct });
  } catch (error) {
    console.error('Admin orders list error:', error.message);
    apiError(res, 500, 'Failed to load orders', `HTTP_500`);
  }
});

router.get('/admin/:id/customer-address', verifyPermission('orders.view'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', `HTTP_400`);
  try {
    const { data: order } = await supabase
      .from('orders')
      .select('user_id')
      .eq('id', req.params.id)
      .eq('store_id', req.store.id)
      .maybeSingle();

    if (!order || !order.user_id) return sendSuccess(res, { address: null });

    let { data } = await supabase
      .from('user_addresses')
      .select('title, phone, city, address, is_default, location_url')
      .eq('user_id', order.user_id)
      .eq('store_id', req.store.id)
      .eq('is_default', true)
      .limit(1);

    if (!data || data.length === 0) {
      ({ data } = await supabase
        .from('user_addresses')
        .select('title, phone, city, address, is_default, location_url')
        .eq('user_id', order.user_id)
        .eq('store_id', req.store.id)
        .order('created_at', { ascending: false })
        .limit(1));
    }

    sendSuccess(res, { address: data && data[0] ? data[0] : null });
  } catch (error) {
    console.error('Admin order customer address error:', error.message);
    apiError(res, 500, 'Failed to load customer address', `HTTP_500`);
  }
});

router.patch('/admin/:id/status', verifyPermission('orders.update_status'), validateBody(orderStatusSchema), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', `HTTP_400`);

  const { id } = req.params;
  const { status, payment_status } = req.body || {};
  if (!status && !payment_status) return apiError(res, 400, 'No status update provided', `HTTP_400`);
  const allowedStatuses = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);
  const allowedPaymentStatuses = new Set(['unpaid', 'pending', 'paid', 'failed', 'cancelled', 'canceled', 'expired']);
  if (status && !allowedStatuses.has(status)) return apiError(res, 400, 'Invalid order status', `HTTP_400`);
  if (payment_status && !allowedPaymentStatuses.has(payment_status)) return apiError(res, 400, 'Invalid payment status', `HTTP_400`);

  try {
    const { data: oldOrder, error: oldErr } = await supabase
      .from('orders')
      .select('id, status, payment_status, payment_method, phone, order_number, user_id')
      .eq('id', id)
      .eq('store_id', req.store.id)
      .maybeSingle();

    if (oldErr) throw oldErr;
    if (!oldOrder) return apiError(res, 404, 'Order not found', `HTTP_404`);
    if (status === oldOrder.status && (!payment_status || payment_status === oldOrder.payment_status)) {
      return sendSuccess(res, { order: oldOrder, unchanged: true });
    }

    const nextStatus = status || oldOrder.status;
    const transitions = {
      pending: new Set(['confirmed', 'cancelled']),
      confirmed: new Set(['processing', 'cancelled']),
      processing: new Set(['shipped', 'cancelled']),
      shipped: new Set(['delivered', 'cancelled']),
      delivered: new Set(),
      cancelled: new Set(),
    };
    if (status && status !== oldOrder.status && !transitions[oldOrder.status]?.has(status)) {
      return apiError(res, 409, 'Invalid order status transition', 'INVALID_ORDER_TRANSITION');
    }
    const oldPaymentMethod = normalizePaymentMethod(oldOrder.payment_method);
    if (status === 'delivered' && oldPaymentMethod !== 'cod' && oldOrder.payment_status !== 'paid') {
      return apiError(res, 409, 'Cannot deliver an unpaid non-COD order', 'PAYMENT_REQUIRED');
    }
    if (payment_status && payment_status !== oldOrder.payment_status) {
      const isCod = oldPaymentMethod === 'cod';
      if (!isCod || !['unpaid', 'paid'].includes(payment_status)) {
        return apiError(res, 409, 'Payment status is controlled by the payment workflow', 'PAYMENT_WORKFLOW_REQUIRED');
      }
      if (payment_status === 'paid' && !['confirmed', 'processing', 'shipped', 'delivered'].includes(oldOrder.status)) {
        return apiError(res, 409, 'COD can be marked paid only after confirmation', 'INVALID_PAYMENT_TRANSITION');
      }
    }
    const updatePayload = {};
    if (status) updatePayload.status = status;
    if (payment_status) updatePayload.payment_status = payment_status;
    if (status === 'delivered' && oldPaymentMethod === 'cod') {
      // Settlement timestamp parity with wallet approvals and Paymob webhooks.
      updatePayload.payment_status = 'paid';
      updatePayload.paid_at = new Date().toISOString();
    } else if (payment_status === 'paid' && oldPaymentMethod !== 'cod' && !updatePayload.paid_at) {
      // Admin-forced paid on non-COD flows must still record settlement time.
      const { data: gatewayIntent } = await supabase
        .from('payment_intents')
        .select('updated_at')
        .eq('order_id', id)
        .eq('status', 'captured')
        .limit(1)
        .maybeSingle();
      updatePayload.paid_at = gatewayIntent?.updated_at || new Date().toISOString();
    }

    const { data: order, error } = await supabase
      .from('orders')
      .update(updatePayload)
      .eq('id', id)
      .eq('store_id', req.store.id)
      .select('*')
      .maybeSingle();

    if (error) throw error;

    if (status === 'cancelled' && oldOrder.status !== 'cancelled' && oldOrder.payment_status !== 'paid') {
      const { error: restoreError } = await supabase.rpc('restore_order_stock', { p_order_id: id });
      if (restoreError) throw restoreError;
    }

    await supabase.from('order_logs').insert([{
      order_id: id,
      store_id: req.store.id,
      admin_id: req.user?.sub || null,
      old_status: status ? oldOrder.status : 'payment update',
      new_status: status || payment_status,
      note: status
        ? `Status updated via Admin: ${oldOrder.status} -> ${status}`
        : `Payment status updated via Admin: ${payment_status}`
    }]);

    // Automatic WhatsApp Vector PDF Invoice on Delivery
    if (status === 'delivered' && oldOrder.status !== 'delivered') {
      sendOrderDeliveredInvoiceWhatsApp(id, req.store.id).catch((invErr) => {
        logger.warn(`[orders] Auto-dispatch delivered invoice failed for ${id}:`, invErr.message);
      });
    }

    sendSuccess(res, { order });
  } catch (error) {
    console.error('Admin order status update error:', error.message);
    apiError(res, 500, 'Failed to update order status', `HTTP_500`);
  }
});


// Privacy: public social proof shows first name + initial only.
function maskBuyerName(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'عميل';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'عميل';
  const firstName = parts[0];
  const initial = parts[1] ? ` ${parts[1].charAt(0)}.` : '';
  return `${firstName}${initial}`;
}

// Securely fetch recent purchases for Social Proof
router.get('/recent-purchases', async (req, res) => {
  try {
    const { data: recentOrders, error } = await supabase
      .from('orders')
      .select('items, created_at, city, user_id')
      .eq('store_id', req.store.id)
      .order('created_at', { ascending: false })
      .limit(15);

    if (error) throw error;

    // Extract only necessary data and fetch real names if user_id exists
    const purchases = [];
    if (recentOrders && recentOrders.length > 0) {
      const userIds = [...new Set(recentOrders.map(o => o.user_id).filter(Boolean))];
      let profilesMap = new Map();
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('user_id, full_name')
          .in('user_id', userIds)
          .eq('store_id', req.store.id);
        if (profiles) {
          profiles.forEach(p => profilesMap.set(p.user_id, p.full_name));
        }
      }

      recentOrders.forEach(order => {
        if (order.items && Array.isArray(order.items)) {
          order.items.forEach(item => {
            purchases.push({
              id: item.id,
              name: item.title || item.name || 'منتج',
              image: item.image || null,
              time: order.created_at,
              // Privacy: never expose full customer names publicly — first
              // name + initial only (e.g. "أحمد م.").
              buyer_name: maskBuyerName(order.user_id ? profilesMap.get(order.user_id) : null),
              city: order.city || null // Real city if available
            });
          });
        }
      });
    }

    sendSuccess(res, { purchases });
  } catch (error) {
    console.error('Error fetching recent purchases:', error.message);
    apiError(res, 500, 'Failed to fetch recent purchases', `HTTP_500`);
  }
});

router.post('/whatsapp-checkout', verifyUser, orderRateLimiter, validateBody(whatsappOrderSchema), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', `HTTP_400`);

  const {
    items,
    customerPhone,
    customerCity,
    customerAddress,
    customerNote = '',
    couponId = null,
    couponCode = null,
    idempotencyKey = null,
    paymentMethod = 'cod'
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return apiError(res, 400, 'Cart is empty', `HTTP_400`);
  }
  
  const reservationKey = `whatsapp-${req.store.id}-${Date.now()}-${Math.random()}`;
  try {
    await assertPaymentMethodAvailable(req.store.id, paymentMethod);
  } catch (err) {
    return apiError(res, err.status || 409, 'وسيلة الدفع غير متاحة', err.code || 'PAYMENT_METHOD_UNAVAILABLE', { reason: err.message });
  }
  const quotaCheck = await processOrderQuotaReservation(req.store.id, reservationKey);
  if (!quotaCheck.allowed) {
    return apiError(res, 403, quotaCheck.error, quotaCheck.code || 'HTTP_403');
  }

  try {
    const productIds = items.map((item) => item?.id).filter(Boolean);
    const variantIds = items.map((item) => item?.variant_id).filter(Boolean);

    const { data: tenantProducts, error: productError } = await supabase
      .from('products')
      .select('id, name, price, has_variants')
      .in('id', productIds)
      .eq('store_id', req.store.id)
      .eq('is_active', true)
      .eq('is_deleted', false);

    if (productError) throw productError;
    const allowedIds = new Set((tenantProducts || []).map((product) => String(product.id)));
    if (productIds.length !== allowedIds.size || productIds.some((id) => !allowedIds.has(String(id)))) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return apiError(res, 400, 'Invalid cart items', `HTTP_400`);
    }

    let tenantVariants = [];
    if (variantIds.length > 0) {
      const { data: varData, error: varError } = await supabase
        .from('product_variants')
        .select('id, product_id, title, price, is_active, is_archived')
        .in('id', variantIds)
        .eq('store_id', req.store.id)
        .eq('is_active', true)
        .eq('is_archived', false);
      if (varError) throw varError;
      tenantVariants = varData || [];
    }

    const normalizedItems = items.map(item => ({
      id: item.id,
      variant_id: item.variant_id || null,
      qty: Number(item.qty ?? item.quantity ?? 0)
    }));

    if (normalizedItems.some(item => !item.id || !Number.isInteger(item.qty) || item.qty < 1)) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return apiError(res, 400, 'Invalid cart quantities', `HTTP_400`);
    }

    // Validate that products with has_variants have valid variant_id
    for (const nit of normalizedItems) {
      const parentProd = (tenantProducts || []).find(p => String(p.id) === String(nit.id));
      if (parentProd?.has_variants) {
        if (!nit.variant_id) {
          await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
          return apiError(res, 400, `الرجاء اختيار مواصفات المنتج: ${parentProd.name}`, 'VARIANT_REQUIRED');
        }
        const matchedVar = tenantVariants.find(v => String(v.id) === String(nit.variant_id) && String(v.product_id) === String(parentProd.id));
        if (!matchedVar) {
          await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
          return apiError(res, 400, `النسخة المختارة من "${parentProd.name}" غير متوفرة`, 'VARIANT_NOT_FOUND');
        }
      }
    }

    if (paymentMethod === 'cod') {
      const { data: storeSiteSettings } = await supabase
        .from('site_settings')
        .select('cod_max_threshold_enabled, cod_max_threshold')
        .eq('store_id', req.store.id)
        .maybeSingle();

      if (storeSiteSettings?.cod_max_threshold_enabled) {
        const maxThreshold = Number(storeSiteSettings.cod_max_threshold) || 1000;
        const productsMap = new Map((tenantProducts || []).map(p => [String(p.id), Number(p.price || 0)]));
        const variantsMap = new Map(tenantVariants.map(v => [String(v.id), Number(v.price)]));
        const estimatedSubtotal = normalizedItems.reduce((sum, it) => {
          const varPrice = it.variant_id ? variantsMap.get(String(it.variant_id)) : null;
          const price = varPrice != null ? varPrice : (productsMap.get(String(it.id)) || 0);
          return sum + price * it.qty;
        }, 0);
        if (estimatedSubtotal > maxThreshold) {
          await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
          return apiError(
            res,
            400,
            `قيمة الطلب تتجاوز الحد الأقصى المسموح به للدفع عند الاستلام (${maxThreshold} ج.م). يرجى الدفع إلكترونياً.`,
            'COD_THRESHOLD_EXCEEDED',
            { max_threshold: maxThreshold, total: estimatedSubtotal }
          );
        }
      }
    }
    let effectiveCouponCode = null;
    if (couponCode) {
      const couponState = await subscriptionLimitService.checkFeatureLimit(req.store.id, 'coupons', 0);
      if (couponState?.allowed) {
        effectiveCouponCode = couponCode;
      }
    }

    const stableIdempotencyKey = String(idempotencyKey || `whatsapp-checkout-${req.store.id}-${req.user?.sub || 'guest'}-${crypto.randomUUID()}`).slice(0, 255);
    let { data, error } = await supabase.rpc('create_order_atomic', {
      p_user_id: req.user?.sub || null,
      p_items: normalizedItems,
      p_phone: customerPhone,
      p_city: customerCity,
      p_address: customerAddress,
      p_customer_note: customerNote,
      p_payment_method: paymentMethod,
      p_coupon_code: effectiveCouponCode,
      p_idempotency_key: stableIdempotencyKey,
      p_auth_source: req.user?.app_metadata?.provider || 'otp',
      p_metadata: { coupon_id: couponId },
      p_store_id: req.store.id
    });

    if (error) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      throw error;
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (result && result.success === false) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return apiError(res, 400, result.error || 'Checkout failed', 'CHECKOUT_FAILED');
    }

    await subscriptionLimitService.commitFeatureUsage(reservationKey);
    abandonedCartService.markConverted(req.store.id, customerPhone).catch((err) => {
      logger.warn(`[Orders] Failed to mark cart converted: ${err.message}`);
    });
    sendSuccess(res, { checkout: result || null });
  } catch (error) {
    await subscriptionLimitService.rollbackFeatureUsage(reservationKey).catch(() => {});
    console.error('WhatsApp checkout error:', error.message);
    apiError(res, 500, 'Checkout failed', `HTTP_500`);
  }
});

// Create a new order — strictly requires authenticated user (guests blocked)
router.post('/', verifyUser, validateBody(createOrderSchema), async (req, res) => {
  let { items, phone, city, address, note, paymentMethod, couponCode, idempotencyKey, location_url } = req.body;
  const addressId = req.body?.address_id || req.body?.addressId || null;
  const userId = req.user?.sub || req.user?.id || req.user?.user_id;

  // 1. Validation
  const allowedMethods = ['cod', 'card', 'manual_wallet'];
  if (!allowedMethods.includes(paymentMethod)) {
    return apiError(res, 400, 'وسيلة دفع غير مدعومة', `HTTP_400`);
  }

  if (!idempotencyKey) {
    return apiError(res, 400, 'Idempotency Key is required', `HTTP_400`);
  }

  // Items must be a non-empty array with valid shape.
  if (!Array.isArray(items) || items.length === 0) {
    return apiError(res, 400, 'السلة فارغة', `HTTP_400`);
  }
  for (const item of items) {
    if (!item || (typeof item.id !== 'string' && typeof item.id !== 'number') || typeof item.qty !== 'number' || item.qty < 1) {
      return apiError(res, 400, 'صنف في السلة غير صالح', `HTTP_400`);
    }
  }

  // Validate required delivery fields.
  if (!phone || !city || !address) {
    return apiError(res, 400, 'بيانات التوصيل ناقصة', `HTTP_400`);
  }

  try {
    let savedAddress = null;
    if (addressId) {
      if (typeof addressId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(addressId)) {
        const { data, error: addressError } = await supabase
          .from('user_addresses')
          .select('id')
          .eq('id', addressId)
          .eq('user_id', userId)
          .eq('store_id', req.store.id)
          .maybeSingle();
        if (!addressError && data) {
          savedAddress = data;
        }
      }
    }

    try {
      await assertPaymentMethodAvailable(req.store.id, paymentMethod);
    } catch (err) {
      return apiError(res, err.status || 409, 'وسيلة الدفع غير متاحة', err.code || 'PAYMENT_METHOD_UNAVAILABLE', { reason: err.message });
    }
    // Idempotency: scoped to user and key
    const idempotencyScope = `${userId}-${idempotencyKey}`;

    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id, total')
      .eq('idempotency_key', idempotencyScope)
      .eq('store_id', req.store.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (existingOrder) {
      return sendSuccess(res, { message: 'Order already processed', orderId: existingOrder.id, total: existingOrder.total });
    }

    const reservationKey = `order-${req.store.id}-${idempotencyScope}`;
    const quotaCheck = await processOrderQuotaReservation(req.store.id, reservationKey);
    if (!quotaCheck.allowed) {
      return apiError(res, 403, quotaCheck.error, quotaCheck.code || 'HTTP_403');
    }

    // 3. Server-Side Calculations
    let calculatedSubtotal = 0;
    const itemsWithPrices = [];
    const productIds = items.map(item => item.id);
    const variantIds = items.map(item => item.variant_id).filter(Boolean);
    
    const { data: products, error: prodError } = await supabase
      .from('products')
      .select('id, name, price, cost_price, stock_quantity, has_variants')
      .in('id', productIds)
      .eq('store_id', req.store.id);

    if (prodError || !products) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      throw new Error('Could not fetch product prices');
    }

    let variants = [];
    if (variantIds.length > 0) {
      const { data: varData, error: varError } = await supabase
        .from('product_variants')
        .select('id, product_id, title, price, cost_price, stock_quantity, is_active, is_archived')
        .in('id', variantIds)
        .eq('store_id', req.store.id)
        .eq('is_active', true)
        .eq('is_archived', false);

      if (varError) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        throw new Error('Could not fetch variant prices');
      }
      variants = varData || [];
    }

    for (const item of items) {
      const dbProduct = products.find(p => p.id === item.id);
      if (!dbProduct) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        return apiError(res, 404, 'المنتج غير موجود أو غير متاح في هذا المتجر', 'PRODUCT_NOT_FOUND');
      }

      let itemPrice = Number(dbProduct.price) || 0;
      let itemCost = Number(dbProduct.cost_price) || 0;
      let itemTitle = dbProduct.name;
      let selectedVariantId = null;

      if (dbProduct.has_variants) {
        if (!item.variant_id) {
          await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
          return apiError(res, 400, `الرجاء اختيار مواصفات المنتج: ${dbProduct.name}`, 'VARIANT_REQUIRED');
        }
        const dbVariant = variants.find(v => v.id === item.variant_id && v.product_id === dbProduct.id);
        if (!dbVariant) {
          await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
          return apiError(res, 400, `النسخة المختارة من "${dbProduct.name}" غير متوفرة`, 'VARIANT_NOT_FOUND');
        }
        if ((dbVariant.stock_quantity || 0) < item.qty) {
          await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
          return apiError(res, 400, `عذراً، الكمية المتاحة من "${dbProduct.name} - ${dbVariant.title}" غير كافية لإتمام طلبك`, 'INSUFFICIENT_STOCK');
        }
        if (dbVariant.price != null) itemPrice = Number(dbVariant.price);
        if (dbVariant.cost_price != null) itemCost = Number(dbVariant.cost_price);
        itemTitle = `${dbProduct.name} (${dbVariant.title})`;
        selectedVariantId = dbVariant.id;
      } else {
        if ((dbProduct.stock_quantity || 0) < item.qty) {
          await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
          return apiError(res, 400, `عذراً، الكمية المتاحة من "${dbProduct.name}" غير كافية لإتمام طلبك`, 'INSUFFICIENT_STOCK');
        }
      }

      calculatedSubtotal += itemPrice * item.qty;
      itemsWithPrices.push({
        id: dbProduct.id,
        variant_id: selectedVariantId,
        title: itemTitle,
        qty: item.qty,
        price: itemPrice,
        unit_cost_snapshot: itemCost,
        gross_profit: (itemPrice - itemCost) * item.qty
      });
    }

    // Authoritative Geospatial & Shipping Zone Containment Engine
    const targetLocationId = req.body?.location_id || req.body?.locationId || null;
    let reqLat = req.body?.latitude ?? req.body?.lat ?? null;
    let reqLng = req.body?.longitude ?? req.body?.lng ?? null;

    if ((reqLat == null || reqLng == null) && typeof location_url === 'string' && location_url.trim()) {
      const match = location_url.match(/([-+]?\d{1,2}\.\d+)\s*[,|\s]\s*([-+]?\d{1,3}\.\d+)/);
      if (match) {
        reqLat = parseFloat(match[1]);
        reqLng = parseFloat(match[2]);
      }
    }

    const coverage = await shippingZoneEngine.evaluateCoverage({
      storeId: req.store.id,
      locationId: targetLocationId,
      lat: reqLat,
      lng: reqLng,
      cityName: city
    });

    if (!coverage.allowed) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return apiError(res, 400, coverage.message || 'نعتذر، المتجر لا يوفر الشحن لهذا الموقع حالياً.', coverage.code || 'SHIPPING_OUT_OF_COVERAGE', {
        details: coverage
      });
    }

    let calculatedShippingFee = Number(coverage.fee) || 0;

    // Free shipping & COD threshold settings
    const { data: storeSiteSettings } = await supabase
      .from('site_settings')
      .select('free_shipping_enabled, free_shipping_threshold, cod_max_threshold_enabled, cod_max_threshold')
      .eq('store_id', req.store.id)
      .maybeSingle();

    if (storeSiteSettings && storeSiteSettings.free_shipping_enabled !== false && calculatedSubtotal >= (Number(storeSiteSettings.free_shipping_threshold) || 0)) {
      calculatedShippingFee = 0;
    }

    let calculatedDiscount = 0;
    let couponId = null;
    if (couponCode) {
      const couponState = await subscriptionLimitService.checkFeatureLimit(req.store.id, 'coupons', 0);
      if (couponState?.allowed) {
        const { data: coupon } = await supabase.from('coupons').select('*').eq('code', couponCode).eq('is_active', true).eq('store_id', req.store.id).maybeSingle();
        if (coupon) {
          const now = new Date();
          const expiry = coupon.expiry_date ? new Date(coupon.expiry_date) : null;
          if ((!expiry || expiry > now) && (coupon.max_uses === 0 || coupon.used_count < coupon.max_uses) && (calculatedSubtotal >= (Number(coupon.min_order_value) || 0))) {
            const discountResult = calculateCouponDiscount(coupon, itemsWithPrices, calculatedSubtotal);
            if (discountResult.applicableSubtotal > 0 && discountResult.calculatedDiscount > 0) {
              calculatedDiscount = discountResult.calculatedDiscount;
              couponId = coupon.id;
            }
          }
        }
      }
    }

    const calculatedTotal = Math.max(calculatedSubtotal + calculatedShippingFee - calculatedDiscount, 0);

    // COD Maximum Threshold Enforcement (e.g. Supermarket fraud & perishable goods protection)
    if (paymentMethod === 'cod' && storeSiteSettings?.cod_max_threshold_enabled) {
      const maxThreshold = Number(storeSiteSettings.cod_max_threshold) || 1000;
      if (calculatedTotal > maxThreshold) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        return apiError(
          res,
          400,
          `قيمة الطلب (${calculatedTotal} ج.م) تتجاوز الحد الأقصى المسموح به للدفع عند الاستلام (${maxThreshold} ج.م). يرجى اختيار وسيلة دفع إلكترونية.`,
          'COD_THRESHOLD_EXCEEDED',
          { max_threshold: maxThreshold, total: calculatedTotal }
        );
      }
    }

    // 4. Atomic Execution — every payment method uses the same stock-safe RPC.
    const { data, error } = await supabase.rpc('create_order_atomic', {
        p_user_id: userId,
        p_items: itemsWithPrices.map(item => ({
          id: item.id,
          variant_id: item.variant_id || null,
          qty: Number(item.qty || 1),
          title: item.title,
          name: item.title,
          price: item.price
        })),
        p_phone: phone,
        p_city: city,
        p_address: address,
        p_customer_note: note || '',
        p_payment_method: paymentMethod,
        p_coupon_code: couponId ? couponCode : null,
        p_idempotency_key: idempotencyScope,
        p_auth_source: req.user?.app_metadata?.provider || 'otp',
        p_metadata: {
          user_agent: req.headers['user-agent'],
          address_id: savedAddress?.id || null,
          location_url: location_url || null,
          shipping_location_id: coverage.matchedZone?.location_id || null,
          shipping_scope: coverage.matchedZone?.scope_type || null,
          canonical_location_id: coverage.resolvedLocation?.id || null,
          shipping_resolution: coverage.resolutionMethod || null
        },
        p_store_id: req.store.id,
        p_location_url: location_url || null
    });

    if (error) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      logger.error('RPC Error in create_order_atomic:', error.message);
      const isStockError = error.message.includes('stock') || error.message.includes('الكمية');
      return apiError(res, isStockError ? 400 : 500, error.message, isStockError ? 'INSUFFICIENT_STOCK' : 'ORDER_CREATE_FAILED');
    }

    await subscriptionLimitService.commitFeatureUsage(reservationKey);
    abandonedCartService.markConverted(req.store.id, phone).catch((err) => {
      logger.warn(`[Orders] Failed to mark cart converted: ${err.message}`);
    });
    const order = Array.isArray(data) ? data[0] : data;
    if (!order?.id) {
      logger.error('Unexpected RPC response payload:', data);
      throw new Error('لم يتم إنشاء الطلب بشكل سليم من الخادم');
    }

    // Retrieve store customized invoice/order prefix (defaults to 'EG-')
    const { data: storeSettings } = await supabase
      .from('site_settings')
      .select('order_prefix')
      .eq('store_id', req.store.id)
      .maybeSingle();
    const orderPrefix = storeSettings?.order_prefix || 'EG-';
    const orderRef = order.order_number ? `${orderPrefix}${order.order_number}` : `#${order.id?.split('-')[0]}`;

    return sendSuccess(res, { 
      id: order.id, 
      orderId: order.id, 
      order_number: order.order_number || '', 
      order_prefix: orderPrefix,
      order_reference: orderRef,
      total: order.total 
    }, { status: 201 });

  } catch (error) {
    const idempotencyScope = userId ? `${userId}-${idempotencyKey}` : idempotencyKey;
    await subscriptionLimitService.rollbackFeatureUsage(`order-${req.store.id}-${idempotencyScope}`).catch(() => {});
    logger.error('[orders.create] Order processing error:', error);
    apiError(res, error.statusCode || 500, error.message || 'Order processing failed', error.code || 'HTTP_500');
  }
});

module.exports = router;
