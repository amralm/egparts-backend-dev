const logger = require('../utils/logger');

const SENSITIVE_FIELDS = ['password', 'new_password', 'code', 'token', 'authorization'];

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const sanitized = Array.isArray(body) ? [...body] : { ...body };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.includes(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeBody(sanitized[key]);
    }
  }
  return sanitized;
}

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  
  // ✅ Structured Error Response
  const errorResponse = {
    success: false,
    error: {
      message: err.message || 'Internal Server Error',
      code: err.code || 'INTERNAL_ERROR',
      requestId: req.id
    }
  };

  logger.error(`${req.method} ${req.url} - ${err.message}`, {
    requestId: req.id,
    stack: err.stack,
    body: sanitizeBody(req.body),
    user: req.user ? (req.user.sub || req.user.id || 'unknown') : 'guest'
  });

  if (process.env.NODE_ENV !== 'production') {
    errorResponse.error.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
};

module.exports = errorHandler;
