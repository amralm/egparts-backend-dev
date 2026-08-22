const { z } = require('zod');
const contract = require('../contracts/api-contract.json');

const paymentMethodSchema = z.preprocess(
  (value) => contract.legacy_payment_method_aliases[value] || value,
  z.enum(contract.payment_methods)
);
const orderStatusValueSchema = z.enum(contract.order_statuses);
const paymentStatusValueSchema = z.enum(contract.payment_statuses);
const itemSchema = z.object({
  id: z.union([z.string().trim().min(1).max(contract.fields.item_id_max), z.number().int().positive()]),
  qty: z.number().int().positive().max(contract.fields.item_quantity_max).optional(),
  quantity: z.number().int().positive().max(contract.fields.item_quantity_max).optional()
}).refine((item) => item.qty !== undefined || item.quantity !== undefined, {
  message: 'qty is required',
  path: ['qty']
});

const addressSchema = z.object({
  title: z.string().trim().min(1).max(contract.fields.address_title_max),
  phone: z.string().trim().min(contract.fields.phone_min).max(contract.fields.phone_max),
  city: z.string().trim().min(1).max(contract.fields.city_max),
  address: z.string().trim().min(2).max(contract.fields.address_max),
  is_default: z.boolean().optional().default(false),
  location_url: z.preprocess(
    (value) => value === '' || value === undefined ? null : value,
    z.string().url().max(contract.fields.location_url_max).nullable()
  ).optional().default(null)
}).strip();

const errorResponseSchema = z.object({
  success: z.literal(false),
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().nullable(),
  data: z.null()
});

module.exports = {
  contract,
  paymentMethodSchema,
  orderStatusValueSchema,
  paymentStatusValueSchema,
  itemSchema,
  addressSchema,
  errorResponseSchema
};
