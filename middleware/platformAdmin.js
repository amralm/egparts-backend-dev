const { supabase } = require('../services/supabase');
const tokenVerifier = require('../utils/tokenVerifier');
const logger = require('../utils/logger');

async function loadPlatformUser(req, res) {
  req.context = { type: 'platform' };
  req.store = null;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
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
      res.status(500).json({ error: 'Internal Server Error' });
      return null;
    }

    if (!superAdmin) {
      logger.warn(`Unauthorized platform access attempt by user: ${decoded.sub}`);
      res.status(403).json({ error: 'Forbidden: Platform Admin access only' });
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
      res.status(503).json({ error: 'Security policy is temporarily unavailable' });
      return null;
    }
    const activeUserBan = (banResult.data || []).some((ban) => !ban.banned_until || new Date(ban.banned_until).getTime() > Date.now());
    if ((ipResult.data || []).length || activeUserBan) {
      res.status(403).json({ error: 'Platform access is blocked by security policy' });
      return null;
    }

    return decoded;
  } catch (err) {
    logger.error('verifyPlatformAdmin token error:', err.message);
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
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
    return res.status(500).json({ error: 'Internal Server Error: Unable to verify permissions' });
  }

  const role = roles && roles[0];

  // Verify that they have the required permission.
  const hasPermission = role && role?.role_permissions?.some((rp) =>
      rp.permissions?.name === requiredPermission && !rp.permissions?.is_deprecated
  );

  if (!hasPermission) {
    logger.warn(`Super Admin missing platform permission ${requiredPermission}, access denied.`);
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  }

  next();
};

module.exports = { verifyPlatformAdmin, verifyPlatformPermission };
