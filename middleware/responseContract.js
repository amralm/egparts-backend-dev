'use strict';

/**
 * ============================================================================
 * ARCHITECTURAL CONTRACT: CANONICAL API ERROR & RESPONSE NORMALIZER
 * ============================================================================
 * STANDARD: EG-Parts Cloud Unified Contract Architecture (RFC 7807 Compliant)
 * 
 * PURPOSE:
 * Enforces machine-readable error codes (`code`), standardized human messages
 * (`message`), correlation tracking (`requestId`), and typed payload wrappers (`data`).
 * 
 * CANONICAL ERROR SHAPE:
 * {
 *   success: false,
 *   code: string (e.g. 'INSUFFICIENT_STOCK', 'UNAUTHORIZED', 'HTTP_404'),
 *   message: string (Human-readable Arabic text),
 *   requestId: string ('req_uuid'),
 *   data: null
 * }
 * ============================================================================
 */
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
