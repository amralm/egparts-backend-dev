'use strict';

const { RESERVED_ENVELOPE_KEYS, LEGACY_SPREAD_ENABLED } = require('./apiResponse');

function apiError(res, status, message, code, data = null) {
  const requestId = res.req?.id || res.req?.correlationId || null;
  const body = {
    success: false,
    code: code || `HTTP_${status}`,
    message,
    requestId,
    // Error responses intentionally never echo route-specific objects unless
    // the caller explicitly passes a minimal, UI-required scalar payload
    // (e.g. { min_order_value }). This keeps one stable contract.
    data
  };

  // Transition bridge (documented, temporary): mirror explicit data fields at
  // the top level while consumers still read them outside `data`.
  if (
    LEGACY_SPREAD_ENABLED &&
    data &&
    typeof data === 'object' &&
    !Array.isArray(data)
  ) {
    for (const [key, value] of Object.entries(data)) {
      if (!RESERVED_ENVELOPE_KEYS.has(key)) body[key] = value;
    }
  }

  return res.status(status).json(body);
}

module.exports = { apiError };
