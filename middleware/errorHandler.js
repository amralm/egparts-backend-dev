const logger = require('../utils/logger');

const SENSITIVE_FIELDS = new Set([
  'password', 'new_password', 'code', 'token', 'authorization', 'cookie',
  'set-cookie', 'x-api-key', 'apikey', 'access_token', 'refresh_token',
  'service_role', 'secret', 'client_secret'
]);

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const sanitized = Array.isArray(body) ? [...body] : { ...body };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.has(String(key).toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeBody(sanitized[key]);
    }
  }
  return sanitized;
}

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  
  const message = (statusCode >= 500 && !global.DEV_MODE_ENABLED)
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');

  // ✅ Structured Error Response
  const errorCode = err.code || 'INTERNAL_ERROR';
  const errorResponse = {
    success: false,
    code: errorCode,
    message,
    requestId: req.id || req.correlationId || null,
    data: null,
    // Kept temporarily for older clients; new clients must use the
    // top-level contract fields above.
    error: {
      message,
      code: errorCode,
      requestId: req.id || req.correlationId || null
    }
  };

  // Attach full context if DEV_MODE_ENABLED
  if (global.DEV_MODE_ENABLED) {
    errorResponse.error.stack = err.stack;
    errorResponse.error.requestContext = {
      body: sanitizeBody(req.body),
      query: sanitizeBody(req.query),
      headers: sanitizeBody(req.headers)
    };
  }

  logger.error(`${req.method} ${req.url} - ${err.message}`, {
    requestId: req.id,
    stack: err.stack,
    body: sanitizeBody(req.body),
    user: req.user ? (req.user.sub || req.user.id || 'unknown') : 'guest'
  });

  // ✅ Fire-and-forget asynchronous DB logging
  (async () => {
    try {
      if (global.DEV_MODE_ENABLED) {
        const { supabase } = require('../services/supabase');
        const storeId = req.store?.id || (req.user?.store_id) || 'platform';
        await supabase.from('client_error_logs').insert([{
          message: err.message,
          stack: err.stack,
          url: req.url,
          store_name: storeId.toString(),
          user_agent: req.headers['user-agent']
        }]);
      }
    } catch (dbErr) {
      // Ignore errors here to ensure graceful degradation (Fail-safe)
      logger.debug('Failed to log to client_error_logs: ' + dbErr.message);
    }
  })();

  // We already added stack above if DEV_MODE_ENABLED

  res.status(statusCode).json(errorResponse);
};

module.exports = errorHandler;
