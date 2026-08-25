const { z } = require('zod');

const phone = z.string().trim().min(10).max(16).refine((value) => (
  /^0?1\d{9}$/.test(value) || /^\+?201\d{9}$/.test(value)
), 'رقم هاتف غير صحيح');

const sendOTPSchema = z.object({
  phone: phone.max(15),
  user_id: z.string().uuid().optional(),
  purpose: z.string().max(40).optional(),
  turnstileToken: z.string().max(4096).optional(),
  turnstile_token: z.string().max(4096).optional()
}).strict();
const verifyOTPSchema = z.object({ phone, code: z.string().regex(/^\d{6}$/, 'كود التحقق يجب أن يكون 6 أرقام'), purpose: z.string().max(40).optional() }).strict();
const resolvePhoneSchema = z.object({ phone: phone.max(15), password: z.string().min(1).max(256) }).strict();
const phoneVerificationClaimSchema = z.object({ token: z.string().min(20).max(200), phone }).strict();
const resetPasswordSchema = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/),
  new_password: z.string().min(6, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل').max(256)
}).strict();

module.exports = { sendOTPSchema, verifyOTPSchema, resolvePhoneSchema, phoneVerificationClaimSchema, resetPasswordSchema };
