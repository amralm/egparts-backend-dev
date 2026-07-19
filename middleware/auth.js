const { supabase } = require('../services/supabase');
const tokenVerifier = require('../utils/tokenVerifier');
const logger = require('../utils/logger');

// ============================================================
// UNIFIED AUTHORIZATION MIDDLEWARE
// ============================================================
// ARCHITECTURE: Identity → Membership → Role → Permission
//
//   Identity   = auth.users (global, unique per human)
//   Membership = user_profiles (scoped to store)
//   Role       = store_roles (scoped to store/platform)
//   Permission = permissions (granular capability name)
//
// HOW TO USE:
//   verifyUser         → confirms valid JWT, sets req.user
//   verifyAdmin        → confirms store admin or super admin (loose check)
//   verifyPermission('products.create') → granular store-level permission check
//   verifyPlatformRole → only for platform/ routes (super admins)
//
// ADDING A NEW PERMISSION:
//   1. Add the permission name string to the `permissions` table in the DB.
//   2. Assign it to the appropriate role via `role_permissions`.
//   3. Use verifyPermission('my.new.permission') on the route.
//   NO CODE CHANGES in this file are required.
// ============================================================

/**
 * Resolves the full permission set for a user in a specific store.
 * This is the single source of truth for store-level authorization.
 *
 * @param {string} userId  - auth.users UUID
 * @param {string} storeId - store UUID
 * @returns {Promise<string[]>} Array of granted permission names
 */
async function resolveStorePermissions(userId, storeId) {
  const { data, error } = await supabase
    .from('user_roles')
    .select(`
      roles!inner (
        id,
        role_type,
        role_permissions (
          permissions (
            name,
            is_deprecated
          )
        )
      )
    `)
    .eq('user_id', userId)
    .eq('store_id', storeId)
    .in('roles.role_type', ['tenant', 'tenant_template']);

  if (error) throw error;

  const permissions = [];
  (data || []).forEach((ur) => {
    (ur.roles?.role_permissions || []).forEach((rp) => {
      if (rp.permissions?.name && !rp.permissions?.is_deprecated) {
        permissions.push(rp.permissions.name);
      }
    });
  });

  return [...new Set(permissions)]; // deduplicate
}

/**
 * Resolves the full permission set for a super admin.
 * Always queries the 'super_admin' platform role for its permissions.
 *
 * @param {string} userId - auth.users UUID
 * @returns {Promise<string[]>} Array of granted permission names
 */
async function resolvePlatformPermissions(userId) {
  // First confirm this user is actually a super_admin
  const { data: superAdmin, error: saErr } = await supabase
    .from('super_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (saErr) throw saErr;
  if (!superAdmin) return null; // not a super admin

  const { data: role, error } = await supabase
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
    .is('store_id', null)
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  const permissions = [];
  (role?.role_permissions || []).forEach((rp) => {
    if (rp.permissions?.name && !rp.permissions?.is_deprecated) {
      permissions.push(rp.permissions.name);
    }
  });

  return [...new Set(permissions)];
}

// ─────────────────────────────────────────────────────────────
// Middleware: verifyUser
// Validates the Bearer JWT and sets req.user.
// Does NOT check any DB table.
// ─────────────────────────────────────────────────────────────
const verifyUser = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    req.user = tokenVerifier.verify(authHeader.split(' ')[1]);
    next();
  } catch (error) {
    logger.error('JWT verification error:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

// ─────────────────────────────────────────────────────────────
// Middleware: optionalAuth
// Like verifyUser but non-blocking (sets req.user = null if no token).
// ─────────────────────────────────────────────────────────────
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    req.user = tokenVerifier.verify(authHeader.split(' ')[1]);
  } catch {
    req.user = null;
  }

  next();
};

// ─────────────────────────────────────────────────────────────
// Middleware: verifyAdmin
// Checks if the user is a store admin OR a super admin.
// Used for broad admin-only sections (not permission-specific).
// Prefer verifyPermission() for granular access control.
// ─────────────────────────────────────────────────────────────
const verifyAdmin = (req, res, next) => {
  verifyUser(req, res, async () => {
    const userId = req.user?.sub;
    const storeId = req.store?.id;

    try {
      const [{ data: superAdmin, error: saErr }, { data: storeAdmin, error: saStoreErr }] = await Promise.all([
        supabase.from('super_admins').select('user_id').eq('user_id', userId).maybeSingle(),
        storeId
          ? supabase.from('user_roles')
              .select('role_id')
              .eq('user_id', userId)
              .eq('store_id', storeId)
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null })
      ]);

      if (saErr) throw saErr;
      if (saStoreErr) throw saStoreErr;

      if (superAdmin || storeAdmin) return next();
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    } catch (err) {
      logger.error('verifyAdmin lookup failed:', err.message);
      if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError' || err.message.includes('token')) { return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' }); } return res.status(500).json({ error: 'Internal server error' });
    }
  });
};

// ─────────────────────────────────────────────────────────────
// Middleware: verifyPermission(permissionName)
// The PRIMARY authorization primitive. Use this everywhere.
//
// For store-level permissions: verifyPermission('products.create')
// For platform-level permissions: verifyPermission('platform.stores.view')
//
// Permission names starting with 'platform.' are checked against
// the super_admin platform role. All others are checked against
// the user's store membership (user_roles).
// ─────────────────────────────────────────────────────────────
const verifyPermission = (permissionName) => {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    try {
      const decoded = tokenVerifier.verify(authHeader.split(' ')[1]);
      req.user = decoded;

      const userId = decoded.sub;
      const isPlatformPermission = permissionName.startsWith('platform.');

      if (isPlatformPermission) {
        const platformPermissions = await resolvePlatformPermissions(userId);

        if (platformPermissions === null) {
          return res.status(403).json({ error: 'Forbidden: Platform access required' });
        }

        if (!platformPermissions.includes(permissionName)) {
          return res.status(403).json({ error: `Forbidden: Missing permission '${permissionName}'` });
        }

        return next();
      }

      // Store-level permission check
      const storeId = req.store?.id;
      if (!storeId) {
        return res.status(403).json({ error: 'Forbidden: Tenant context required' });
      }

      const storePermissions = await resolveStorePermissions(userId, storeId);

      if (!storePermissions.includes(permissionName)) {
        return res.status(403).json({ error: `Forbidden: Missing permission '${permissionName}'` });
      }

      return next();
    } catch (err) {
      logger.error(`verifyPermission('${permissionName}') failed:`, err.message);
      if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError' || err.message.includes('token')) { return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' }); } return res.status(500).json({ error: 'Internal server error' });
    }
  };
};

// ─────────────────────────────────────────────────────────────
// Utility: attachPermissions(req)
// Attaches the full permission set to req.permissions.
// Call AFTER verifyUser in routes that need dynamic permission checks.
// ─────────────────────────────────────────────────────────────
const attachPermissions = async (req, res, next) => {
  const userId = req.user?.sub;
  const storeId = req.store?.id;

  if (!userId) return next();

  try {
    if (storeId) {
      req.permissions = await resolveStorePermissions(userId, storeId);
    } else {
      req.permissions = [];
    }
  } catch (err) {
    logger.error('attachPermissions failed:', err.message);
    req.permissions = [];
  }

  next();
};

module.exports = {
  verifyUser,
  verifyAdmin,
  optionalAuth,
  verifyPermission,
  attachPermissions,
  // Export resolvers for use in other services (e.g., SessionAssembler)
  resolveStorePermissions,
  resolvePlatformPermissions,
};
