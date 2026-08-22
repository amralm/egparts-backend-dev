const { z } = require('zod');

const accountSchema = z.object({
  phone_number: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/),
  display_name: z.string().trim().max(160).optional().default(''),
  priority: z.number().int().min(0).max(10000).optional().default(100),
  weight: z.number().int().min(1).max(100).optional().default(1),
  max_concurrency: z.number().int().min(1).max(100).optional().default(1),
  enabled: z.boolean().optional().default(true)
}).strict();

module.exports = { accountSchema };
