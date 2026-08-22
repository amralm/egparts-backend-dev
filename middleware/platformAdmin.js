const { apiError } = require('../utils/apiError');
const { supabase } = require('../services/supabase');
const tokenVerifier = require('../utils/tokenVerifier');
const logger = require('../utils/logger');

async function loadPlatformUser(req, res) {
  req.context = { type: 'platform' };
  req.store = null;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    apiError(res, 401, 'Unauthorized: No token provided', `HTTP_401`);
    return null;
  }

  try {
    const decoded = tokenVerifier.verify(authHeader.split(' ')[1]);
    req.user = decoded;

    const { data: superAdmin, error } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', decoded.sub)
      .maybeSingle();

    if (error) {
      logger.error('loadPlatformUser DB error:', error.message);
      apiError(res, 500, 'Internal Server Error', `HTTP_500`);
      return null;
    }

    if (!superAdmin) {
      logger.warn(`Unauthorized platform access attempt by user: ${decoded.sub}`);
      apiError(res, 403, 'Forbidden: Platform Admin access only', `HTTP_403`);
      return null;
    }

    // Platform-wide blocks must also apply to platform routes, which bypass the
    // tenant middleware by design. This closes the old enforcement gap.
    const clientIp = req.clientIp || req.ip || null;
    const [ipResult, banResult] = await Promise.all([
      clientIp
        ? supabase.from('blocked_ips').select('id').is('store_id', null).eq('ip_address', clientIp).limit(1)
        : Promise.resolve({ data: [], error: null }),
      supabase.from('ban_logs').select('id,banned_until').is('store_id', null).eq('user_id', decoded.sub).eq('is_active', true).limit(20)
    ]);
    if (ipResult.error || banResult.error) {
      logger.error('Platform security policy lookup failed:', ipResult.error?.message || banResult.error?.message);
      apiError(res, 503, 'Security policy is temporarily unavailable', `HTTP_503`);
      return null;
    }
    const activeUserBan = (banResult.data || []).some((ban) => !ban.banned_until || new Date(ban.banned_until).getTime() > Date.now());
    if ((ipResult.data || []).length || activeUserBan) {
      apiError(res, 403, 'Platform access is blocked by security policy', `HTTP_403`);
      return null;
    }

    return decoded;
  } catch (err) {
    logger.error('verifyPlatformAdmin token error:', err.message);
    apiError(res, 401, 'Unauthorized: Invalid token', `HTTP_401`);
    return null;
  }
}

const verifyPlatformAdmin = async (req, res, next) => {
  const decoded = await loadPlatformUser(req, res);
  if (!decoded) return;
  next();
};

const verifyPlatformPermission = (requiredPermission) => async (req, res, next) => {
  const decoded = await loadPlatformUser(req, res);
  if (!decoded) return;

  const { data: roles, error } = await supabase
    .from('roles')
    .select(`
      id,
      role_permissions (
        permissions (
          name,
          is_deprecated
        )
      )
    `)
    .eq('role_type', 'platform')
    .eq('name', 'super_admin')
    .is('store_id', null);

  if (error) {
    logger.error('verifyPlatformPermission lookup failed:', error.message);
    return apiError(res, 500, 'Internal Server Error: Unable to verify permissions', `HTTP_500`);
  }

  const role = roles && roles[0];

  // Verify that they have the required permission.
  const hasPermission = role && role?.role_permissions?.some((rp) =>
      rp.permissions?.name === requiredPermission && !rp.permissions?.is_deprecated
  );

  if (!hasPermission) {
    logger.warn(`Super Admin missing platform permission ${requiredPermission}, access denied.`);
    return apiError(res, 403, 'Forbidden: Insufficient permissions', `HTTP_403`);
  }

  next();
};

module.exports = { verifyPlatformAdmin, verifyPlatformPermission };
