const { z } = require('zod');

const egyptianPoolPhone = z.string().trim().min(10).max(20).regex(/^\+?[\d\s()-]+$/).transform((value, ctx) => {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `2${digits}`;
  if (digits.startsWith('1') && digits.length === 10) digits = `20${digits}`;
  if (!/^20\d{10}$/.test(digits)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'رقم واتساب مصري غير صالح' });
    return z.NEVER;
  }
  return digits;
});

const accountSchema = z.object({
  phone_number: egyptianPoolPhone,
  display_name: z.string().trim().max(160).optional().default(''),
  priority: z.number().int().min(0).max(10000).optional().default(100),
  weight: z.number().int().min(1).max(100).optional().default(1),
  max_concurrency: z.number().int().min(1).max(100).optional().default(1),
  enabled: z.boolean().optional().default(true)
}).strict();

module.exports = { accountSchema };
