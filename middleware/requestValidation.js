const { z } = require('zod');

const clientErrorSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  stack: z.string().max(4000).optional().default(''),
  url: z.string().max(2048).optional().default(''),
  timestamp: z.string().max(80).optional(),
  storeName: z.string().max(160).optional().default(''),
  userAgent: z.string().max(512).optional().default('')
}).strict();

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'بيانات الطلب غير صالحة.',
        error: 'بيانات الطلب غير صالحة.',
        requestId: req.correlationId || req.id || null,
        fields: result.error.flatten().fieldErrors
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { clientErrorSchema, validateBody };
