'use strict';
const { apiError } = require('../utils/apiError');

const ALLOWED_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'application/octet-stream'
];

/**
 * Enforce the JSON request contract on /api mutations: a non-empty body must
 * declare an allowed Content-Type (JSON for normal payloads, multipart/binary
 * for uploads). This is the server-side guard for the recurring production
 * failure where fetch() sent JSON as text/plain and req.body arrived empty
 * (415 UNSUPPORTED_CONTENT_TYPE).
 */
function isAllowedContentType(contentType) {
  return ALLOWED_CONTENT_TYPES.some((allowed) => contentType.startsWith(allowed));
}

function hasRequestBody(req) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > 0) return true;
  const transferEncoding = String(req.headers['transfer-encoding'] || '').toLowerCase();
  if (transferEncoding.includes('chunked')) return true;
  // express.text()-parsed legacy payloads prove a body was sent.
  if (typeof req.body === 'string' && req.body.trim().length > 0) return true;
  return false;
}

module.exports = function jsonContract(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!hasRequestBody(req)) return next();

  const contentType = String(req.headers['content-type'] || '').toLowerCase().trim();

  if (!contentType || !isAllowedContentType(contentType)) {
    return apiError(res, 415, 'صيغة الطلب غير مدعومة.', 'UNSUPPORTED_CONTENT_TYPE');
  }

  next();
};
