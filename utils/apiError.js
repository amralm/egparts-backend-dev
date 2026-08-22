'use strict';

function apiError(res, status, message, code, data = null) {
  const requestId = res.req?.id || res.req?.correlationId || null;
  return res.status(status).json({
    success: false,
    code: code || `HTTP_${status}`,
    message,
    requestId,
    data
  });
}

module.exports = { apiError };
