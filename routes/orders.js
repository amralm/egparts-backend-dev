const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { optionalAuth, verifyUser, verifyPermission } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const subscriptionLimitService = require('../services/subscriptionLimitService');

// Rate limiting for order creation (10 requests per minute per IP)
const orderRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'طلبات إنشاء الطلبات كثيرة جداً، حاول بعد دقيقة' }
});

router.get('/my', verifyUser, async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ error: 'Tenant context required' });

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
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

router.get('/:id/tracking', verifyUser, async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ error: 'Tenant context required' });

  try {
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', req.params.id)
      .eq('store_id', req.store.id)
      .eq('user_id', req.user.sub)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { data: tracking, error: trackingError } = await supabase
      .from('order_tracking')
      .select('*')
      .eq('order_id', req.params.id)
      .order('created_at', { ascending: true });

    if (trackingError) throw trackingError;
    res.json({ success: true, order, tracking: tracking || [] });
  } catch (error) {
    console.error('Customer order tracking error:', error.message);
    res.status(500).json({ error: 'Failed to load order tracking' });
  }
});

router.get('/admin/list', verifyPermission('orders.view'), async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ error: 'Tenant context required' });

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
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

router.get('/admin/:id/customer-address', verifyPermission('orders.view'), async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ error: 'Tenant context required' });
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
    res.status(500).json({ error: 'Failed to load customer address' });
  }
});

router.patch('/admin/:id/status', verifyPermission('orders.update_status'), async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ error: 'Tenant context required' });

  const { id } = req.params;
  const { status, payment_status } = req.body || {};
  if (!status && !payment_status) return res.status(400).json({ error: 'No status update provided' });

  try {
    const { data: oldOrder, error: oldErr } = await supabase
      .from('orders')
      .select('id, status, payment_status, phone, order_number, user_id')
      .eq('id', id)
      .eq('store_id', req.store.id)
      .maybeSingle();

    if (oldErr) throw oldErr;
    if (!oldOrder) return res.status(404).json({ error: 'Order not found' });

    const updatePayload = {};
    if (status) updatePayload.status = status;
    if (payment_status) updatePayload.payment_status = payment_status;

    const { data: order, error } = await supabase
      .from('orders')
      .update(updatePayload)
      .eq('id', id)
      .eq('store_id', req.store.id)
      .select('*')
      .maybeSingle();

    if (error) throw error;

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
    res.status(500).json({ error: 'Failed to update order status' });
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
    res.status(500).json({ error: 'Failed to fetch recent purchases' });
  }
});

router.post('/whatsapp-checkout', verifyUser, orderRateLimiter, async (req, res) => {
  if (!req.store?.id) return res.status(400).json({ error: 'Tenant context required' });

  const {
    items,
    customerPhone,
    customerCity,
    customerAddress,
    customerNote = '',
    couponId = null,
    paymentMethod = 'cod'
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  
  const reservationKey = `whatsapp-${req.store.id}-${Date.now()}-${Math.random()}`;
  const isAllowed = await subscriptionLimitService.reserveFeatureUsage(req.store.id, 'orders', 1, reservationKey);
  if (!isAllowed) {
    return res.status(403).json({ error: 'عذراً، المتجر استنفد الحد الأقصى من الطلبات المسموحة في باقته الحالية' });
  }

  try {
    if (paymentMethod === 'cod') {
      const { data: codGateway } = await supabase
        .from('store_payment_gateways')
        .select('is_active')
        .eq('store_id', req.store.id)
        .eq('provider_name', 'cod')
        .maybeSingle();
        
      if (codGateway && codGateway.is_active === false) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        return res.status(400).json({ success: false, error: 'الدفع عند الاستلام غير متاح حالياً' });
      }
    }

    const productIds = items.map((item) => item?.id).filter(Boolean);
    const { data: tenantProducts, error: productError } = await supabase
      .from('products')
      .select('id')
      .in('id', productIds)
      .eq('store_id', req.store.id)
      .eq('is_active', true)
      .neq('is_deleted', true);

    if (productError) throw productError;
    const allowedIds = new Set((tenantProducts || []).map((product) => String(product.id)));
    if (productIds.length !== allowedIds.size || productIds.some((id) => !allowedIds.has(String(id)))) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return res.status(400).json({ error: 'Invalid cart items' });
    }

    let { data, error } = await supabase.rpc('process_secure_checkout_v2', {
      p_user_id: req.user?.sub || null,
      p_items: items,
      p_customer_phone: customerPhone,
      p_customer_city: customerCity,
      p_customer_address: customerAddress,
      p_customer_note: customerNote,
      p_coupon_id: couponId,
      p_payment_method: paymentMethod,
      p_store_id: req.store.id
    });

    if (error && /p_store_id|schema cache|function/i.test(error.message || '')) {
      const fallback = await supabase.rpc('process_secure_checkout_v2', {
        p_user_id: req.user?.sub || null,
        p_items: items,
        p_customer_phone: customerPhone,
        p_customer_city: customerCity,
        p_customer_address: customerAddress,
        p_customer_note: customerNote,
        p_coupon_id: couponId,
        p_payment_method: paymentMethod
      });
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      throw error;
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (result && result.success === false) {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      return res.status(400).json({ success: false, error: result.error || 'Checkout failed' });
    }

    await subscriptionLimitService.commitFeatureUsage(reservationKey);
    res.json({ success: true, checkout: result || null });
  } catch (error) {
    await subscriptionLimitService.rollbackFeatureUsage(reservationKey).catch(() => {});
    console.error('WhatsApp checkout error:', error.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// Create a new order — strictly requires authenticated user (guests blocked)
router.post('/', verifyUser, async (req, res) => {
  const { items, phone, city, address, note, paymentMethod, couponCode, idempotencyKey, location_url } = req.body;
  const userId = req.user.sub;

  // 1. Validation
  const allowedMethods = ['cod', 'card', 'manual_wallet'];
  if (!allowedMethods.includes(paymentMethod)) {
    return res.status(400).json({ error: 'وسيلة دفع غير مدعومة' });
  }

  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency Key is required' });
  }

  // Items must be a non-empty array with valid shape.
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة' });
  }
  for (const item of items) {
    if (!item || (typeof item.id !== 'string' && typeof item.id !== 'number') || typeof item.qty !== 'number' || item.qty < 1) {
      return res.status(400).json({ error: 'صنف في السلة غير صالح' });
    }
  }

  // Validate required delivery fields.
  if (!phone || !city || !address) {
    return res.status(400).json({ error: 'بيانات التوصيل ناقصة' });
  }

  try {
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
      return res.status(403).json({ error: 'عذراً، المتجر استنفد الحد الأقصى من الطلبات المسموحة في باقته الحالية' });
    }

    if (paymentMethod === 'cod') {
      const { data: codGateway } = await supabase
        .from('store_payment_gateways')
        .select('is_active')
        .eq('store_id', req.store.id)
        .eq('provider_name', 'cod')
        .maybeSingle();
        
      if (codGateway && codGateway.is_active === false) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        return res.status(400).json({ error: 'الدفع عند الاستلام غير متاح حالياً' });
      }
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
        return res.status(404).json({ error: `المنتج غير موجود أو غير متاح في هذا المتجر` });
      }
      if ((dbProduct.stock_quantity || 0) < item.qty) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        return res.status(400).json({ error: `عذراً، الكمية المتاحة من "${dbProduct.name}" غير كافية لإتمام طلبك` });
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

    // 4. Atomic Execution
    if (paymentMethod === 'cod') {
      const { data, error } = await supabase.rpc('create_order_atomic', {
        p_user_id: userId,
        p_items: items.map(item => ({ id: item.id, qty: item.qty })),
        p_phone: phone,
        p_city: city,
        p_address: address,
        p_customer_note: note || '',
        p_payment_method: 'cod',
        p_coupon_code: couponCode || null,
        p_idempotency_key: idempotencyScope,
        p_auth_source: req.user?.app_metadata?.provider || 'otp',
        p_metadata: { user_agent: req.headers['user-agent'] },
        p_store_id: req.store.id,
        p_location_url: location_url || null
      });

      if (error) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        console.error('RPC Error:', error.message);
        const isStockError = error.message.includes('stock') || error.message.includes('الكمية');
        return res.status(isStockError ? 400 : 500).json({ error: error.message });
      }

      await subscriptionLimitService.commitFeatureUsage(reservationKey);
      const order = Array.isArray(data) ? data[0] : data;
      return res.status(201).json({ success: true, orderId: order.id, total: order.total });

    } else {
      // For Card and Manual Wallet: Regular insert
      const { data: order, error: orderError } = await supabase.from('orders').insert([{
        user_id: userId, items: itemsWithPrices, phone, city, address, customer_note: note,
        payment_method: paymentMethod, subtotal: calculatedSubtotal, discount: calculatedDiscount,
        shipping_fee: calculatedShippingFee, total: calculatedTotal, coupon_id: couponId,
        idempotency_key: idempotencyScope, status: 'pending', payment_status: 'unpaid',
        store_id: req.store.id, location_url: location_url || null
      }]).select().single();

      if (orderError) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
        throw orderError;
      }
      
      await subscriptionLimitService.commitFeatureUsage(reservationKey);
      return res.json({ success: true, orderId: order.id, total: calculatedTotal });
    }

  } catch (error) {
    const idempotencyScope = userId ? `${userId}-${idempotencyKey}` : idempotencyKey;
    await subscriptionLimitService.rollbackFeatureUsage(`order-${req.store.id}-${idempotencyScope}`).catch(() => {});
    console.error('Order processing error:', error.message);
    res.status(500).json({ error: 'Order processing failed' });
  }
});

module.exports = router;
