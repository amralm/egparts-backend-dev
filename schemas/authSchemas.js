const { z } = require('zod');

const phone = z.string().min(10).max(16).regex(/^\+?[1-9]\d{1,14}$/, 'رقم هاتف غير صحيح');

const sendOTPSchema = z.object({ phone: phone.max(15), turnstileToken: z.string().max(4096).optional() }).strict();
const verifyOTPSchema = z.object({ phone, code: z.string().regex(/^\d{6}$/, 'كود التحقق يجب أن يكون 6 أرقام'), purpose: z.string().max(40).optional() }).strict();
const resolvePhoneSchema = z.object({ phone: phone.max(15), password: z.string().min(1).max(256) }).strict();

module.exports = { sendOTPSchema, verifyOTPSchema, resolvePhoneSchema };
