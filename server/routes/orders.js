const express = require('express');
const router = express.Router();
const { optionalAuth, verifyUser } = require('../middleware/auth');
const { supabase } = require('../services/supabase');

// Create a new order — works for both logged-in users and guests
router.post('/', optionalAuth, async (req, res) => {
  const { items, phone, city, address, note, paymentMethod, couponCode, idempotencyKey } = req.body;
  const userId = req.user?.sub || null; // null = guest order

  // 1. Validation
  const allowedMethods = ['cod', 'card'];
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
    // Idempotency: guests use the key directly; logged-in users scope it to their ID
    const idempotencyScope = userId ? `${userId}-${idempotencyKey}` : idempotencyKey;

    const idempotencyQuery = supabase
      .from('orders')
      .select('id, total')
      .eq('idempotency_key', idempotencyScope)
      .eq('store_id', req.store.id);

    if (userId) idempotencyQuery.eq('user_id', userId);

    const { data: existingOrder } = await idempotencyQuery.single();

    if (existingOrder) {
      return res.json({ success: true, message: 'Order already processed', orderId: existingOrder.id, total: existingOrder.total });
    }

    // 3. Server-Side Calculations
    let calculatedSubtotal = 0;
    const itemsWithPrices = [];
    const productIds = items.map(item => item.id);
    
    const { data: products, error: prodError } = await supabase
      .from('products')
      .select('id, name, price, stock')
      .in('id', productIds)
      .eq('store_id', req.store.id);

    if (prodError || !products) throw new Error('Could not fetch product prices');

    for (const item of items) {
      const dbProduct = products.find(p => p.id === item.id);
      if (!dbProduct) return res.status(404).json({ error: `Product ${item.id} not found` });
      if (dbProduct.stock < item.qty) return res.status(400).json({ error: `Not enough stock for ${dbProduct.name}` });

      calculatedSubtotal += dbProduct.price * item.qty;
      itemsWithPrices.push({ id: dbProduct.id, title: dbProduct.name, qty: item.qty, price: dbProduct.price });
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
        p_store_id: req.store.id
      });

      if (error) {
        console.error('RPC Error:', error.message);
        const isStockError = error.message.includes('stock') || error.message.includes('الكمية');
        return res.status(isStockError ? 400 : 500).json({ error: error.message });
      }

      const order = Array.isArray(data) ? data[0] : data;
      return res.status(201).json({ success: true, orderId: order.id, total: order.total });

    } else {
      // For Card: Regular insert
      const { data: order, error: orderError } = await supabase.from('orders').insert([{
        user_id: userId, items: itemsWithPrices, phone, city, address, customer_note: note,
        payment_method: 'card', subtotal: calculatedSubtotal, discount: calculatedDiscount,
        shipping_fee: calculatedShippingFee, total: calculatedTotal, coupon_id: couponId,
        idempotency_key: idempotencyScope, status: 'pending', payment_status: 'unpaid',
        store_id: req.store.id
      }]).select().single();

      if (orderError) throw orderError;
      return res.json({ success: true, orderId: order.id, total: calculatedTotal });
    }

  } catch (error) {
    console.error('Order processing error:', error.message);
    res.status(500).json({ error: 'Order processing failed' });
  }
});

module.exports = router;
