const { z } = require('zod');

const paymentSettingsSchema = z.object({
  is_active: z.boolean(),
  api_key: z.string().trim().max(512).optional().default(''),
  integration_id: z.union([z.string().trim().max(120), z.number().int().positive()]).optional(),
  iframe_id: z.union([z.string().trim().max(120), z.number().int().positive()]).optional(),
  hmac_secret: z.string().trim().max(512).optional().default('')
}).strip();

const paymentToggleSchema = z.object({ is_active: z.boolean() });
const intentSchema = z.object({
  order_id: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  order: z.string().uuid().optional()
}).refine((payload) => Boolean(payload.order_id || payload.orderId || payload.order), {
  message: 'order_id is required', path: ['order_id']
});
const proofDecisionSchema = z.object({
  intent_id: z.string().uuid(),
  reason: z.string().trim().max(1000).optional().default('')
}).strip();
const walletSettingsSchema = z.object({
  wallets: z.array(z.record(z.string(), z.unknown())).max(20),
  is_active: z.boolean()
}).strip();

module.exports = { paymentSettingsSchema, paymentToggleSchema, intentSchema, proofDecisionSchema, walletSettingsSchema };
