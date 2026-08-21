const { z } = require('zod');

const itemSchema = z.object({
  id: z.union([z.string().trim().min(1).max(120), z.number().int().positive()]),
  qty: z.number().int().positive().max(100000).optional(),
  quantity: z.number().int().positive().max(100000).optional()
}).refine((item) => item.qty !== undefined || item.quantity !== undefined, {
  message: 'qty is required',
  path: ['qty']
});

const commonOrderFields = {
  items: z.array(itemSchema).min(1).max(100),
  phone: z.string().trim().min(8).max(20).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(2).max(500).optional(),
  note: z.string().trim().max(2000).optional().default(''),
  paymentMethod: z.enum(['cod', 'card', 'manual_wallet']).default('cod'),
  couponCode: z.string().trim().max(120).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(255),
  location_url: z.string().url().max(2048).nullable().optional(),
  address_id: z.string().uuid().nullable().optional(),
  addressId: z.string().uuid().nullable().optional()
};

const createOrderSchema = z.object(commonOrderFields).strip();

const whatsappOrderSchema = z.object({
  items: z.array(itemSchema).min(1).max(100),
  customerPhone: z.string().trim().min(8).max(20),
  customerCity: z.string().trim().min(1).max(120),
  customerAddress: z.string().trim().min(2).max(500),
  customerNote: z.string().trim().max(2000).optional().default(''),
  couponId: z.string().uuid().nullable().optional(),
  couponCode: z.string().trim().max(120).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(255).optional(),
  paymentMethod: z.enum(['cod', 'card', 'manual_wallet']).default('cod')
}).strip();

const orderStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']).optional(),
  payment_status: z.enum(['unpaid', 'pending', 'paid', 'failed', 'cancelled', 'canceled', 'expired']).optional()
}).refine((payload) => payload.status !== undefined || payload.payment_status !== undefined, {
  message: 'status or payment_status is required'
});

module.exports = { createOrderSchema, whatsappOrderSchema, orderStatusSchema };
