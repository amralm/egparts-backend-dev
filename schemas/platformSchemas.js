'use strict';

const { z } = require('zod');
const contract = require('../contracts/api-contract.json');

// ─── Manager / owner invitations ─────────────────────────────────────────────
const managerInviteCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(contract.fields.email_max).optional(),
  phone: z.string().trim().min(contract.fields.phone_min).max(contract.fields.phone_max).optional(),
  store_id: z.string().uuid(),
  role_id: z.string().uuid().optional()
})
  .strict()
  .refine((value) => value.email || value.phone, {
    message: 'email or phone is required',
    path: ['email']
  });

const invitationIdParamSchema = z.object({
  id: z.string().uuid()
}).strict();

// ─── Store settings save (PUT /api/admin/settings) ──────────────────────────
// Values may be strings, scalars, or bounded nested JSON (e.g. hot_deals).
const boundedSettingsValue = z.any().refine((value) => {
  if (typeof value === 'string') return value.length <= contract.fields.settings_value_max;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).length <= contract.fields.settings_value_max * 2;
    } catch {
      return false;
    }
  }
  return false;
}, 'قيمة الإعداد كبيرة جدًا أو غير مدعومة.');

const storeSettingsSaveSchema = z.object({
  settings: z.record(
    z.string().min(1).max(contract.fields.settings_key_max),
    boundedSettingsValue
  ).default({}),
  businessType: z.string().trim().max(60).optional(),
  guaranteeProductIds: z.array(z.string().min(1).max(contract.fields.item_id_max))
    .max(contract.fields.guarantee_product_ids_max)
    .optional()
}).strict();

// ─── WhatsApp pool account params ────────────────────────────────────────────
const whatsappAccountIdParamSchema = z.object({
  id: z.string().uuid()
}).strict();

// ─── Upload reservation keys (report-metrics tenant binding) ────────────────
const uploadReservationKeySchema = z.string().trim().min(8).max(contract.fields.reservation_key_max)
  .regex(/^upload_[0-9a-fA-F-]{36}_[A-Za-z0-9_-]+$/, 'malformed reservation key');

module.exports = {
  contract,
  managerInviteCreateSchema,
  invitationIdParamSchema,
  storeSettingsSaveSchema,
  whatsappAccountIdParamSchema,
  uploadReservationKeySchema
};
