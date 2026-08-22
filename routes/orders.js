const { apiError } = require('../utils/apiError');
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

// Rate limiting for order creation (10 requests per minute per IP)
const orderRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, code: 'RATE_LIMITED', message: 'طلبات إنشاء الطلبات كثيرة جداً، حاول بعد دقيقة', data: null }
});

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
    res.json({ success: true, orders: data || [] });
  } catch (error) {
    console.error('Customer orders list error:', error.message);
    apiError(res, 500, 'Failed to load orders', `HTTP_500`);
  }
});

router.get('/:id/tracking', verifyUser, async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', `HTTP_400`);

  try {
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', req.params.id)
      .eq('store_id', req.store.id)
      .eq('user_id', req.user.sub)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!order) return apiError(res, 404, 'Order not found', `HTTP_404`);

    const { data: tracking, error: trackingError } = await supabase
      .from('order_tracking')
      .select('*')
      .eq('order_id', req.params.id)
      .order('created_at', { ascending: true });

    if (trackingError) throw trackingError;
    res.json({ success: true, order, tracking: tracking || [] });
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

    let orders = data || [];
    if (productId) {
      orders = orders.filter((order) => Array.isArray(order.items) && order.items.some((item) => item.id === productId));
    }

    res.json({ success: true, orders, filter_product: filterProduct });
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

    if (!order || !order.user_id) return res.json({ success: true, address: null });

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

    res.json({ success: true, address: data && data[0] ? data[0] : null });
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
      return res.json({ success: true, order: oldOrder, unchanged: true });
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
    if (status === 'delivered' && oldPaymentMethod === 'cod') updatePayload.payment_status = 'paid';

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


    // Duplicate manual WhatsApp notification removed since it is handled by DB triggers
    res.json({ success: true, order });
  } catch (error) {
    console.error('Admin order status update error:', error.message);
    apiError(res, 500, 'Failed to update order status', `HTTP_500`);
  }
});


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
              buyer_name: order.user_id ? (profilesMap.get(order.user_id) || 'عميل') : 'عميل',
              city: order.city || null // Real city if available
            });
          });
        }
      });
    }

    res.json({ success: true, purchases });
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
  const isAllowed = await subscriptionLimitService.reserveFeatureUsage(req.store.id, 'orders', 1, reservationKey);
  if (!isAllowed) {
    return apiError(res, 403, 'عذراً، المتجر استنفد الحد الأقصى من الطلبات المسموحة في باقته الحالية', `HTTP_403`);
  }

  try {
    const productIds = items.map((item) => item?.id).filter(Boolean);
    const { data: tenantProducts, error: productError } = await supabase
      .from('products')
      .select('id')
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

    const normalizedItems = items.map(item => ({ id: item.id, qty: Number(item.qty ?? item.quantity ?? 0) }));
    if (normalizedItems.some(item => !item.id || !Number.isInteger(item.qty) || item.qty < 1)) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return apiError(res, 400, 'Invalid cart quantities', `HTTP_400`);
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
      p_coupon_code: couponCode || null,
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
    res.json({ success: true, checkout: result || null });
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
  const userId = req.user.sub;

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
      if (typeof addressId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(addressId)) {
        return apiError(res, 400, 'العنوان المحفوظ غير صالح', 'INVALID_ADDRESS_ID');
      }
      const { data, error: addressError } = await supabase
        .from('user_addresses')
        .select('id')
        .eq('id', addressId)
        .eq('user_id', userId)
        .eq('store_id', req.store.id)
        .maybeSingle();
      if (addressError) throw addressError;
      if (!data) {
        return apiError(res, 404, 'العنوان المحفوظ غير موجود أو لا يخص هذا المتجر', 'SAVED_ADDRESS_NOT_FOUND');
      }
      savedAddress = data;
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
      return res.json({ success: true, message: 'Order already processed', orderId: existingOrder.id, total: existingOrder.total });
    }

    const reservationKey = `order-${req.store.id}-${idempotencyScope}`;
    const isAllowed = await subscriptionLimitService.reserveFeatureUsage(req.store.id, 'orders', 1, reservationKey);
    if (!isAllowed) {
      return apiError(res, 403, 'عذراً، المتجر استنفد الحد الأقصى من الطلبات المسموحة في باقته الحالية', `HTTP_403`);
    }

    // 3. Server-Side Calculations
    let calculatedSubtotal = 0;
    const itemsWithPrices = [];
    const productIds = items.map(item => item.id);
    
    const { data: products, error: prodError } = await supabase
      .from('products')
      .select('id, name, price, cost_price, stock_quantity')
      .in('id', productIds)
      .eq('store_id', req.store.id);

    if (prodError || !products) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      throw new Error('Could not fetch product prices');
    }

    for (const item of items) {
      const dbProduct = products.find(p => p.id === item.id);
      if (!dbProduct) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return apiError(res, 404, 'المنتج غير موجود أو غير متاح في هذا المتجر', 'PRODUCT_NOT_FOUND');
      }
      if ((dbProduct.stock_quantity || 0) < item.qty) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return apiError(res, 400, `عذراً، الكمية المتاحة من "${dbProduct.name}" غير كافية لإتمام طلبك`, 'INSUFFICIENT_STOCK');
      }

      calculatedSubtotal += dbProduct.price * item.qty;
      itemsWithPrices.push({
        id: dbProduct.id,
        title: dbProduct.name,
        qty: item.qty,
        price: dbProduct.price,
        unit_cost_snapshot: dbProduct.cost_price || 0,
        gross_profit: ((dbProduct.price || 0) - (dbProduct.cost_price || 0)) * item.qty
      });
    }

    const { data: zone } = await supabase.from('shipping_zones').select('shipping_fee').eq('city_name', city).eq('store_id', req.store.id).single();
    let calculatedShippingFee = zone ? zone.shipping_fee : 0;

    // Fallback: if city not in zones, use "محافظة أخرى"
    if (!zone) {
      const { data: fallback } = await supabase.from('shipping_zones').select('shipping_fee').eq('city_name', 'محافظة أخرى').eq('store_id', req.store.id).single();
      if (fallback) calculatedShippingFee = fallback.shipping_fee;
    }

    // Free shipping: waive fee if subtotal >= threshold
    const { data: shipSettings } = await supabase.from('site_settings').select('free_shipping_enabled, free_shipping_threshold').eq('store_id', req.store.id).single();
    if (shipSettings && shipSettings.free_shipping_enabled !== false && calculatedSubtotal >= (shipSettings.free_shipping_threshold ?? 0)) {
      calculatedShippingFee = 0;
    }

    let calculatedDiscount = 0;
    let couponId = null;
    if (couponCode) {
      const { data: coupon } = await supabase.from('coupons').select('*').eq('code', couponCode).eq('is_active', true).eq('store_id', req.store.id).single();
      if (coupon) {
        const now = new Date();
        const expiry = coupon.expiry_date ? new Date(coupon.expiry_date) : null;
        if ((!expiry || expiry > now) && (coupon.max_uses === 0 || coupon.used_count < coupon.max_uses) && (calculatedSubtotal >= (coupon.min_order_value || 0))) {
          calculatedDiscount = coupon.discount_percentage ? (calculatedSubtotal * (coupon.discount_percentage / 100)) : (coupon.discount_amount || 0);
          couponId = coupon.id;
        }
      }
    }

    const calculatedTotal = calculatedSubtotal + calculatedShippingFee - calculatedDiscount;

    // 4. Atomic Execution — every payment method uses the same stock-safe RPC.
    const { data, error } = await supabase.rpc('create_order_atomic', {
        p_user_id: userId,
        p_items: items.map(item => ({ id: item.id, qty: item.qty })),
        p_phone: phone,
        p_city: city,
        p_address: address,
        p_customer_note: note || '',
        p_payment_method: paymentMethod,
        p_coupon_code: couponCode || null,
        p_idempotency_key: idempotencyScope,
        p_auth_source: req.user?.app_metadata?.provider || 'otp',
        // The Dev/Production RPC contract currently stores optional location
        // data in metadata; do not send an undeclared RPC argument because
        // PostgREST rejects the entire call before the transaction starts.
        p_metadata: {
          user_agent: req.headers['user-agent'],
          address_id: savedAddress?.id || null,
          location_url: location_url || null
        },
        p_store_id: req.store.id
    });

    if (error) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      console.error('RPC Error:', error.message);
      const isStockError = error.message.includes('stock') || error.message.includes('الكمية');
      return apiError(res, isStockError ? 400 : 500, error.message, isStockError ? 'INSUFFICIENT_STOCK' : 'ORDER_CREATE_FAILED');
    }

    await subscriptionLimitService.commitFeatureUsage(reservationKey);
    const order = Array.isArray(data) ? data[0] : data;
    return res.status(201).json({ success: true, orderId: order.id, total: order.total });


  } catch (error) {
    const idempotencyScope = userId ? `${userId}-${idempotencyKey}` : idempotencyKey;
    await subscriptionLimitService.rollbackFeatureUsage(`order-${req.store.id}-${idempotencyScope}`).catch(() => {});
    console.error('Order processing error:', error.message);
    apiError(res, 500, 'Order processing failed', `HTTP_500`);
  }
});

module.exports = router;
