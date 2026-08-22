'use strict';

function apiError(res, status, message, code, _data = null) {
  const requestId = res.req?.id || res.req?.correlationId || null;
  return res.status(status).json({
    success: false,
    code: code || `HTTP_${status}`,
    message,
    requestId,
    // Error responses intentionally never echo route-specific objects. This
    // keeps one stable contract and prevents accidental leakage of DB/provider
    // details through a convenience `data` argument.
    data: null
  });
}

module.exports = { apiError };
