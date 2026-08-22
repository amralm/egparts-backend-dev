'use strict';

// Compatibility boundary for older routes. New handlers should return the
// canonical shape directly, but this prevents legacy `{ error }` responses
// from reaching clients with a different contract.
module.exports = function responseContract(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (payload && typeof payload === 'object' && (res.statusCode >= 400 || payload.success === false)) {
      const nested = payload.error && typeof payload.error === 'object' ? payload.error : {};
      const message = payload.message || nested.message || (typeof payload.error === 'string' ? payload.error : 'تعذر تنفيذ الطلب.');
      const code = payload.code || nested.code || `HTTP_${res.statusCode}`;
      const canonical = {
        ...payload,
        success: false,
        code,
        message,
        requestId: payload.requestId || nested.requestId || req.id || req.correlationId || null,
        data: payload.data ?? null
      };
      delete canonical.error;
      payload = canonical;
    }
    return originalJson(payload);
  };
  next();
};
