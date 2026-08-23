'use strict';

const crypto = require('crypto');
const { apiError } = require('../utils/apiError');
const { supabase } = require('../services/supabase');
const { verifyBearerToken } = require('./auth');
const logger = require('../utils/logger');

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Canonical tenant impersonation boundary.
 *
 * The browser sends an opaque bearer in x-impersonate-session. Only its
 * SHA-256 hash is stored. The incoming hostname/header never selects the
 * tenant while this boundary is active; the session row does.
 */
module.exports = async function impersonationMiddleware(req, res, next) {
  const rawToken = req.headers['x-impersonate-session'];
  if (!rawToken) return next();

  try {
    if (!req.user) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        req.user = await verifyBearerToken(authHeader.slice(7));
      } else {
        // Cross-subdomain handoff: the opaque session token is itself the
        // authenticated, tenant-scoped credential after redemption.
        req.user = { sub: null, role: 'platform_impersonated' };
      }
    }

    const tokenHash = hashToken(rawToken);
    const { data: session, error: sessionError } = await supabase
      .from('impersonation_sessions')
      .select('id, store_id, admin_id, reason, is_active, expires_at, absolute_expires_at, revoked_at, last_used_at')
      .eq('token_hash', tokenHash)
      .eq('is_active', true)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (sessionError || !session) {
      return apiError(res, 401, 'جلسة الانتحال غير صالحة أو منتهية.', 'IMPERSONATION_SESSION_INVALID');
    }

    if (req.user.sub && req.user.sub !== session.admin_id) {
      return apiError(res, 403, 'جلسة الانتحال تخص مديرًا آخر.', 'IMPERSONATION_ADMIN_MISMATCH');
    }
    req.user = {
      sub: session.admin_id,
      role: 'platform_impersonated',
      impersonated: true
    };

    if (session.absolute_expires_at && new Date(session.absolute_expires_at).getTime() <= Date.now()) {
      await supabase.from('impersonation_sessions').update({ is_active: false, revoked_at: new Date().toISOString() }).eq('id', session.id);
      return apiError(res, 401, 'انتهت جلسة الانتحال.', 'IMPERSONATION_SESSION_EXPIRED');
    }

    const lastUsed = session.last_used_at ? new Date(session.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > 60_000) {
      await supabase.from('impersonation_sessions').update({ last_used_at: new Date().toISOString() }).eq('id', session.id);
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', session.store_id)
      .maybeSingle();

    if (storeError || !store) return apiError(res, 404, 'المتجر المنتحل غير موجود.', 'IMPERSONATED_STORE_NOT_FOUND');

    req.store = store;
    req.context = { type: 'tenant', source: 'impersonation' };
    req.isImpersonated = true;
    req.impersonationSessionId = session.id;
    req.impersonatorId = session.admin_id;
    req.impersonationReason = session.reason;
    return next();
  } catch (err) {
    logger.error('[ImpersonationMiddleware] verification failed:', err.message);
    return apiError(res, 500, 'تعذر التحقق من جلسة الانتحال.', 'IMPERSONATION_VERIFICATION_FAILED');
  }
};

module.exports.hashToken = hashToken;
