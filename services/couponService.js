const { z } = require('zod');
const { supabase } = require('./supabase');
const subscriptionLimitService = require('./subscriptionLimitService');

const couponSchema = z.object({
  code: z.string().trim().min(2).max(64).regex(/^[A-Z0-9_-]+$/i),
  discount_percentage: z.coerce.number().min(0).max(100).default(0),
  discount_amount: z.coerce.number().min(0).default(0),
  min_order_value: z.coerce.number().min(0).default(0),
  max_discount_cap: z.preprocess((v) => v === '' || v === null || v === undefined ? null : v, z.coerce.number().min(0).nullable().optional().default(null)),
  max_uses: z.coerce.number().int().min(1).max(100000).default(100),
  is_active: z.boolean().default(true),
  applies_to: z.enum(['all', 'specific_products']).default('all'),
  applicable_product_ids: z.array(z.string().uuid()).default([])
}).refine((value) => value.discount_percentage > 0 || value.discount_amount > 0, {
  message: 'A coupon must have a percentage or fixed discount'
});

function normalizePayload(payload) {
  const parsed = couponSchema.parse({
    ...payload,
    code: String(payload?.code || '').trim().toUpperCase()
  });

  return {
    code: parsed.code,
    discount_percentage: parsed.discount_percentage,
    discount_amount: parsed.discount_amount,
    min_order_value: parsed.min_order_value,
    max_discount_cap: parsed.max_discount_cap ?? null,
    max_uses: parsed.max_uses,
    is_active: parsed.is_active,
    applies_to: parsed.applies_to,
    applicable_product_ids: Array.isArray(parsed.applicable_product_ids) ? parsed.applicable_product_ids : []
  };
}

function calculateCouponDiscount(coupon, items = [], subtotal = 0) {
  const orderSubtotal = Number(subtotal) || 0;
  let applicableSubtotal = orderSubtotal;
  let applicableItemCount = Array.isArray(items) ? items.length : 0;

  if (coupon.applies_to === 'specific_products') {
    const allowedIds = new Set((coupon.applicable_product_ids || []).map(id => String(id)));
    applicableSubtotal = 0;
    applicableItemCount = 0;

    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const itemId = String(item?.id || '');
        if (allowedIds.has(itemId)) {
          const itemPrice = Number(item.price || 0);
          const itemQty = Number(item.qty ?? item.quantity ?? 1);
          applicableSubtotal += itemPrice * itemQty;
          applicableItemCount += itemQty;
        }
      }
    }
  }

  let calculatedDiscount = 0;
  if (applicableSubtotal > 0) {
    if (coupon.discount_percentage > 0) {
      calculatedDiscount = (applicableSubtotal * Number(coupon.discount_percentage)) / 100;
      if (coupon.max_discount_cap && Number(coupon.max_discount_cap) > 0 && calculatedDiscount > Number(coupon.max_discount_cap)) {
        calculatedDiscount = Number(coupon.max_discount_cap);
      }
    } else if (coupon.discount_amount > 0) {
      calculatedDiscount = Math.min(Number(coupon.discount_amount), applicableSubtotal);
    }
  }

  return {
    applicableSubtotal,
    applicableItemCount,
    calculatedDiscount
  };
}

async function ensureCouponsEnabled(storeId) {
  const state = await subscriptionLimitService.checkFeatureLimit(storeId, 'coupons', 0);
  if (!state.allowed) {
    const err = new Error('Coupons are not enabled for this store plan');
    err.statusCode = 403;
    err.code = 'FEATURE_COUPONS_DISABLED';
    throw err;
  }
  return state;
}

async function listCoupons(storeId) {
  await ensureCouponsEnabled(storeId);

  const { data, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function validateCoupon(storeId, code, subtotal, items = []) {
  await ensureCouponsEnabled(storeId);
  const normalizedCode = String(code || '').trim().toUpperCase();
  const orderSubtotal = Number(subtotal) || 0;

  const { data, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('code', normalizedCode)
    .eq('is_active', true)
    .eq('store_id', storeId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Coupon not found');
    err.statusCode = 404;
    err.code = 'COUPON_NOT_FOUND';
    throw err;
  }

  if (data.expiry_date && new Date(data.expiry_date) < new Date()) {
    const err = new Error('Coupon expired');
    err.statusCode = 400;
    err.code = 'COUPON_EXPIRED';
    throw err;
  }

  if (data.max_uses > 0 && data.used_count >= data.max_uses) {
    const err = new Error('Coupon usage limit reached');
    err.statusCode = 400;
    err.code = 'COUPON_USAGE_LIMIT_REACHED';
    throw err;
  }

  if (data.min_order_value > 0 && orderSubtotal < data.min_order_value) {
    const err = new Error('Minimum order value not met');
    err.statusCode = 400;
    err.code = 'COUPON_MIN_ORDER_NOT_MET';
    err.min_order_value = data.min_order_value;
    throw err;
  }

  // If specific products coupon, verify items in cart
  if (data.applies_to === 'specific_products') {
    const allowedIds = new Set((data.applicable_product_ids || []).map(id => String(id)));
    const hasApplicableItem = Array.isArray(items) && items.some(item => allowedIds.has(String(item?.id)));
    if (!hasApplicableItem && Array.isArray(items) && items.length > 0) {
      const err = new Error('Coupon is only applicable to specific products not in cart');
      err.statusCode = 400;
      err.code = 'COUPON_PRODUCTS_NOT_IN_CART';
      throw err;
    }
  }

  const { applicableSubtotal, applicableItemCount, calculatedDiscount } = calculateCouponDiscount(data, items, orderSubtotal);

  return {
    ...data,
    applicable_subtotal: applicableSubtotal,
    applicable_item_count: applicableItemCount,
    calculated_discount: calculatedDiscount
  };
}

async function createCoupon(storeId, payload) {
  await ensureCouponsEnabled(storeId);

  const insertPayload = {
    ...normalizePayload(payload),
    store_id: storeId
  };

  const { data, error } = await supabase
    .from('coupons')
    .insert([insertPayload])
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateCoupon(storeId, couponId, payload) {
  await ensureCouponsEnabled(storeId);

  const updatePayload = normalizePayload(payload);
  const { data, error } = await supabase
    .from('coupons')
    .update(updatePayload)
    .eq('id', couponId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Coupon not found');
    err.statusCode = 404;
    err.code = 'COUPON_NOT_FOUND';
    throw err;
  }
  return data;
}

async function setCouponStatus(storeId, couponId, isActive) {
  await ensureCouponsEnabled(storeId);

  const { data, error } = await supabase
    .from('coupons')
    .update({ is_active: Boolean(isActive) })
    .eq('id', couponId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Coupon not found');
    err.statusCode = 404;
    err.code = 'COUPON_NOT_FOUND';
    throw err;
  }
  return data;
}

async function deleteCoupon(storeId, couponId) {
  await ensureCouponsEnabled(storeId);

  const { error } = await supabase
    .from('coupons')
    .delete()
    .eq('id', couponId)
    .eq('store_id', storeId);

  if (error) throw error;
  return { deleted: true };
}

module.exports = {
  listCoupons,
  validateCoupon,
  calculateCouponDiscount,
  createCoupon,
  updateCoupon,
  setCouponStatus,
  deleteCoupon
};
