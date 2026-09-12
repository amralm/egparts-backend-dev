const { z } = require('zod');

const mediaKey = z.string().trim().max(2000);

const productOptionValueSchema = z.object({
  id: z.string().uuid().optional(),
  value: z.string().trim().min(1).max(80),
  sort_order: z.coerce.number().int().min(0).max(1000).optional().default(0)
}).strip();

const productOptionSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  sort_order: z.coerce.number().int().min(0).max(1000).optional().default(0),
  values: z.array(z.union([z.string().trim().min(1).max(80), productOptionValueSchema])).min(1).max(25)
}).strip();

const productVariantSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  sku: z.preprocess((v) => v === '' ? null : v, z.string().trim().max(120).nullable().optional().default(null)),
  barcode: z.preprocess((v) => v === '' ? null : v, z.string().trim().max(120).nullable().optional().default(null)),
  price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  old_price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  cost_price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  stock_quantity: z.coerce.number().int().min(0).max(100_000_000).default(0),
  image: mediaKey.optional().default(''),
  option_values: z.record(z.string(), z.string()).optional(),
  option_value_ids: z.array(z.string().uuid()).optional().default([]),
  is_active: z.boolean().optional().default(true),
  is_archived: z.boolean().optional().default(false)
}).strip().refine((data) => data.old_price === null || data.price === null || data.old_price >= data.price, {
  message: 'old_price must be greater than or equal to price',
  path: ['old_price']
});

const baseProductSchema = z.object({
  name: z.string().trim().min(1).max(240),
  price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  stock_quantity: z.coerce.number().int().min(0).max(100_000_000),
  category: z.preprocess((value) => (typeof value === 'string' && value.trim() === '') || value === null || value === undefined ? 'عام' : value, z.string().trim().min(1).max(160).default('عام')),
  image: mediaKey.optional().default(''),
  gallery: z.array(mediaKey).max(50).optional().default([]),
  part_number: z.preprocess((value) => value === null || value === undefined ? '' : value, z.string().trim().max(160).optional().default('')),
  old_price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  cost_price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  is_original: z.boolean().optional().default(true),
  is_active: z.boolean().optional().default(true),
  specs: z.record(z.string().trim().max(160), z.union([z.string().trim().max(1000), z.number(), z.boolean()])).optional().default({}),
  compatibility: z.array(z.string().trim().max(200)).max(200).optional().default([]),
  has_variants: z.boolean().optional().default(false),
  options: z.array(productOptionSchema).max(5).optional().default([]),
  variants: z.array(productVariantSchema).max(100).optional().default([])
}).strip();

const productSchema = baseProductSchema.refine((data) => {
  if (data.has_variants && (!data.variants || data.variants.length === 0)) {
    return false;
  }
  return true;
}, {
  message: 'Products with variants enabled must contain at least one variant',
  path: ['variants']
}).refine((data) => data.old_price === null || data.price === null || data.old_price >= data.price, {
  message: 'old_price must be greater than or equal to price',
  path: ['old_price']
});

const updateProductSchema = baseProductSchema.partial().refine((data) => {
  if (data.has_variants && (!data.variants || data.variants.length === 0)) {
    return false;
  }
  return true;
}, {
  message: 'Products with variants enabled must contain at least one variant',
  path: ['variants']
}).refine((data) => {
  if (data.old_price !== undefined && data.price !== undefined) {
    return data.old_price === null || data.price === null || data.old_price >= data.price;
  }
  return true;
}, {
  message: 'old_price must be greater than or equal to price',
  path: ['old_price']
});

const bannerSchema = z.object({
  title: z.string().trim().max(160).optional().default(''),
  subtitle: z.string().trim().max(300).optional().default(''),
  image_url: mediaKey.optional().default(''),
  link_url: z.string().trim().max(500).optional().default('/catalog'),
  is_active: z.boolean().optional().default(true),
  order_index: z.coerce.number().int().min(0).max(10000).optional().default(0),
  overlay_opacity: z.coerce.number().int().min(0).max(100).optional().default(40),
  blur_px: z.coerce.number().int().min(0).max(48).optional().default(6)
}).strip();

const shippingZoneSchema = z.object({
  city_name: z.string().trim().min(2).max(120),
  shipping_fee: z.coerce.number().finite().min(0).max(100000),
  location_id: z.string().trim().max(120).nullable().optional(),
  scope_type: z.enum(['CITY', 'MARKAZ', 'GOVERNORATE', 'CUSTOM', 'ALL_EGYPT']).optional().default('CITY'),
  is_fallback: z.boolean().optional().default(false),
  priority: z.coerce.number().int().min(-100).max(1000).optional().default(0),
  estimated_days: z.string().trim().max(50).optional().default('2-3 أيام'),
  is_active: z.boolean().optional().default(true)
}).strip();

const updateShippingZoneSchema = shippingZoneSchema.partial();

const couponSchema = z.object({
  code: z.string().trim().min(2).max(64).regex(/^[A-Z0-9_-]+$/i),
  discount_percentage: z.coerce.number().finite().min(0).max(100).optional().default(0),
  discount_amount: z.coerce.number().finite().min(0).max(1_000_000_000).optional().default(0),
  min_order_value: z.coerce.number().finite().min(0).max(1_000_000_000).optional().default(0),
  max_discount_cap: z.preprocess((v) => v === '' || v === null || v === undefined ? null : v, z.coerce.number().finite().min(0).max(1_000_000_000).nullable().optional().default(null)),
  max_uses: z.coerce.number().int().min(1).max(100000).optional().default(100),
  is_active: z.boolean().optional().default(true),
  applies_to: z.enum(['all', 'specific_products']).optional().default('all'),
  applicable_product_ids: z.array(z.string().uuid()).optional().default([])
}).strip().refine((value) => value.discount_percentage > 0 || value.discount_amount > 0, {
  message: 'A coupon must have a percentage or fixed discount'
});

const couponValidationSchema = z.object({
  code: z.string().trim().min(2).max(64),
  subtotal: z.coerce.number().finite().min(0).max(1_000_000_000),
  items: z.array(z.object({
    id: z.string().uuid().or(z.string().min(1)),
    qty: z.coerce.number().finite().min(1).optional(),
    quantity: z.coerce.number().finite().min(1).optional(),
    price: z.coerce.number().finite().min(0).optional()
  })).optional().default([])
}).strip();

module.exports = { productSchema, updateProductSchema, baseProductSchema, productOptionSchema, productVariantSchema, bannerSchema, shippingZoneSchema, updateShippingZoneSchema, couponSchema, couponValidationSchema };
