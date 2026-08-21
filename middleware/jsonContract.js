'use strict';

/**
 * Reject JSON-like mutation payloads sent as text/plain before they reach a
 * route. This is the server-side guard for the recurring "req.body is empty"
 * production failure. Multipart uploads, webhooks and non-API pages are not
 * affected.
 */
module.exports = function jsonContract(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const isTextPayload = contentType.startsWith('text/plain');
  const rawBody = typeof req.body === 'string' ? req.body.trim() : '';
  const looksLikeJson = rawBody.startsWith('{') || rawBody.startsWith('[');

  if (isTextPayload && looksLikeJson) {
    return res.status(415).json({
      success: false,
      code: 'UNSUPPORTED_CONTENT_TYPE',
      error: 'يجب إرسال بيانات JSON مع Content-Type: application/json.',
      message: 'صيغة الطلب غير مدعومة.',
      requestId: req.requestId || req.correlationId || req.id || null
    });
  }

  if (isTextPayload && req.body !== undefined && req.body !== '') {
    return res.status(415).json({
      success: false,
      code: 'UNSUPPORTED_CONTENT_TYPE',
      error: 'هذا المسار لا يقبل نصًا خامًا.',
      message: 'صيغة الطلب غير مدعومة.',
      requestId: req.requestId || req.correlationId || req.id || null
    });
  }

  next();
};
