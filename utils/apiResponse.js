'use strict';

const RESERVED_ENVELOPE_KEYS = new Set(['success', 'code', 'message', 'requestId', 'data']);
/**
 * Canonical success sender: { success, code, message, requestId, data }.
 *
 * Transition bridge (documented, temporary): business fields are also spread
 * at the top level so legacy consumers that read them outside `data` keep
 * working while every caller is migrated to the envelope. The contract audit
 * tracks remaining raw res.json sites; once the frontend reads exclusively
 * through envelope.data, drop LEGACY_SPREAD_ENABLED and this bridge.
 */
const LEGACY_SPREAD_ENABLED = true;

function sendSuccess(res, data = {}, options = {}) {
  const status = Number.isInteger(options.status) ? options.status : 200;
  const code = options.code || 'OK';
  const payload = data === undefined || data === null ? {} : data;
  // Promote an explicit business message so legacy consumers reading
  // payload.message keep seeing the route's own text, not the default.
  const businessMessage =
    typeof payload?.message === 'string' && payload.message.length ? payload.message : null;
  const message = options.message || businessMessage || 'تم بنجاح.';
  const requestId = res.req?.id || res.req?.correlationId || null;

  const body = {
    success: true,
    code,
    message,
    requestId,
    data: payload
  };

  if (LEGACY_SPREAD_ENABLED && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (!RESERVED_ENVELOPE_KEYS.has(key)) body[key] = value;
    }
  }

  return res.status(status).json(body);
}

module.exports = { sendSuccess, RESERVED_ENVELOPE_KEYS, LEGACY_SPREAD_ENABLED };
