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
  
  const message = (statusCode >= 500 && process.env.NODE_ENV === 'production')
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');

  // ✅ Structured Error Response
  const errorResponse = {
    success: false,
    error: {
      message,
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

  // ✅ Fire-and-forget asynchronous DB logging
  (async () => {
    try {
      const { supabase } = require('../services/supabase');
      const { data: setting } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'error_logging_enabled')
        .single();

      if (setting && setting.value === 'true') {
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

  if (process.env.NODE_ENV !== 'production') {
    errorResponse.error.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
};

module.exports = errorHandler;
