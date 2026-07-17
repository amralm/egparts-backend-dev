const { z } = require('zod');
const { supabase } = require('./supabase');
const subscriptionLimitService = require('./subscriptionLimitService');

const couponSchema = z.object({
  code: z.string().trim().min(2).max(64).regex(/^[A-Z0-9_-]+$/),
  discount_percentage: z.coerce.number().min(0).max(100).default(0),
  discount_amount: z.coerce.number().min(0).default(0),
  min_order_value: z.coerce.number().min(0).default(0),
  max_uses: z.coerce.number().int().min(1).max(100000).default(100),
  is_active: z.boolean().default(true)
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
    max_uses: parsed.max_uses,
    is_active: parsed.is_active
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

async function validateCoupon(storeId, code, subtotal) {
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

  return data;
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
  createCoupon,
  updateCoupon,
  setCouponStatus,
  deleteCoupon
};
