const { z } = require('zod');

const mediaKey = z.string().trim().max(2000);

const productSchema = z.object({
  name: z.string().trim().min(1).max(240),
  price: z.coerce.number().finite().min(0).max(1_000_000_000),
  stock_quantity: z.coerce.number().int().min(0).max(100_000_000),
  category: z.string().trim().min(1).max(160),
  image: mediaKey.optional().default(''),
  gallery: z.array(mediaKey).max(50).optional().default([]),
  part_number: z.string().trim().max(160).optional().default(''),
  old_price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  cost_price: z.preprocess((value) => value === '' || value === null || value === undefined ? null : value, z.coerce.number().finite().min(0).max(1_000_000_000).nullable()).optional().default(null),
  is_original: z.boolean().optional().default(true),
  is_active: z.boolean().optional().default(true),
  specs: z.record(z.string().trim().max(160), z.union([z.string().trim().max(1000), z.number(), z.boolean()])).optional().default({}),
  compatibility: z.array(z.string().trim().max(200)).max(200).optional().default([])
}).strip();

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
  shipping_fee: z.coerce.number().finite().min(0).max(100000)
}).strip();

const couponSchema = z.object({
  code: z.string().trim().min(2).max(64).regex(/^[A-Z0-9_-]+$/i),
  discount_percentage: z.coerce.number().finite().min(0).max(100).optional().default(0),
  discount_amount: z.coerce.number().finite().min(0).max(1_000_000_000).optional().default(0),
  min_order_value: z.coerce.number().finite().min(0).max(1_000_000_000).optional().default(0),
  max_uses: z.coerce.number().int().min(1).max(100000).optional().default(100),
  is_active: z.boolean().optional().default(true)
}).strip().refine((value) => value.discount_percentage > 0 || value.discount_amount > 0, {
  message: 'A coupon must have a percentage or fixed discount'
});

const couponValidationSchema = z.object({
  code: z.string().trim().min(2).max(64),
  subtotal: z.coerce.number().finite().min(0).max(1_000_000_000)
}).strip();

module.exports = { productSchema, bannerSchema, shippingZoneSchema, couponSchema, couponValidationSchema };
