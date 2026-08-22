const { z } = require('zod');
const { contract, itemSchema, paymentMethodSchema, orderStatusValueSchema, paymentStatusValueSchema } = require('./canonicalSchemas');

const commonOrderFields = {
  items: z.array(itemSchema).min(1).max(contract.fields.items_max),
  phone: z.string().trim().min(contract.fields.phone_min).max(contract.fields.phone_max).optional(),
  city: z.string().trim().min(1).max(contract.fields.city_max).optional(),
  address: z.string().trim().min(2).max(contract.fields.address_max).optional(),
  note: z.string().trim().max(contract.fields.note_max).optional().default(''),
  paymentMethod: paymentMethodSchema.default('cod'),
  couponCode: z.string().trim().max(120).nullable().optional(),
  idempotencyKey: z.string().trim().min(contract.fields.idempotency_key_min).max(contract.fields.idempotency_key_max),
  location_url: z.string().url().max(contract.fields.location_url_max).nullable().optional(),
  address_id: z.string().uuid().nullable().optional(),
  addressId: z.string().uuid().nullable().optional()
};

const createOrderSchema = z.object(commonOrderFields).strip();

const whatsappOrderSchema = z.object({
  items: z.array(itemSchema).min(1).max(contract.fields.items_max),
  customerPhone: z.string().trim().min(contract.fields.phone_min).max(contract.fields.phone_max),
  customerCity: z.string().trim().min(1).max(contract.fields.city_max),
  customerAddress: z.string().trim().min(2).max(contract.fields.address_max),
  customerNote: z.string().trim().max(contract.fields.note_max).optional().default(''),
  couponId: z.string().uuid().nullable().optional(),
  couponCode: z.string().trim().max(120).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(255).optional(),
  paymentMethod: paymentMethodSchema.default('cod')
}).strip();

const orderStatusSchema = z.object({
  status: orderStatusValueSchema.optional(),
  payment_status: paymentStatusValueSchema.optional()
}).refine((payload) => payload.status !== undefined || payload.payment_status !== undefined, {
  message: 'status or payment_status is required'
});

module.exports = { createOrderSchema, whatsappOrderSchema, orderStatusSchema };
