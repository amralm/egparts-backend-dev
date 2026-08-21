'use strict';

// Keep unknown API routes inside the machine-readable API contract.
// Express's default 404 handler returns HTML and breaks JSON clients.
module.exports = function apiNotFound(req, res, next) {
  if (!req.path.startsWith('/api')) return next();

  return res.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: 'المسار المطلوب غير موجود.',
    requestId: req.correlationId || req.id || null,
    data: null
  });
};
