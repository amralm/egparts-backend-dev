const { z } = require('zod');
const { apiError } = require('../utils/apiError');

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
      return apiError(res, 400, 'بيانات الطلب غير صالحة.', 'VALIDATION_ERROR', { fields: result.error.flatten().fieldErrors });
    }
    req.body = result.data;
    next();
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return apiError(res, 400, 'معرفات المسار غير صالحة.', 'PARAMS_VALIDATION_ERROR', { fields: result.error.flatten().fieldErrors });
    }
    req.params = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return apiError(res, 400, 'معاملات الاستعلام غير صالحة.', 'QUERY_VALIDATION_ERROR', { fields: result.error.flatten().fieldErrors });
    }
    req.query = result.data;
    next();
  };
}

module.exports = { clientErrorSchema, validateBody, validateParams, validateQuery };
