const { apiError } = require('../utils/apiError');
const { supabase, supabaseAuth } = require('../services/supabase');
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
async function resolveStorePermissions(userId, storeId, options = {}) {
  // Cashier Role Isolation: restricted strictly to POS and store orders/products view
  if (options.role === 'cashier') {
    return [
      'tenant.orders.read', 'orders.read', 'orders.view',
      'tenant.orders.write', 'orders.create', 'orders.write',
      'tenant.products.read', 'products.view', 'products.read'
    ];
  }

  // Check if super_admin first (super admins have full capabilities across all stores)
  try {
    const { data: superAdmin } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (superAdmin && options.impersonated !== true) {
      const { data: allPerms } = await supabase
        .from('permissions')
        .select('name')
        .eq('is_deprecated', false);
      return (allPerms || []).map((p) => p.name);
    }

    // An impersonated platform administrator is deliberately reduced to the
    // tenant control plane. Do not require a matching user_roles row: the
    // platform administrator is entering the selected store as an operator,
    // not pretending to be a customer. Platform permissions are rejected in
    // verifyPermission below, so this list cannot restore platform access.
    if (superAdmin && options.impersonated === true) {
      const { data: tenantPerms } = await supabase
        .from('permissions')
        .select('name')
        .eq('is_deprecated', false)
        .not('name', 'like', 'platform.%');
      return (tenantPerms || []).map((p) => p.name);
    }
  } catch (saErr) {
    logger.warn('super_admin check in resolveStorePermissions failed:', saErr.message);
  }

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
async function verifyBearerToken(token) {
  try {
    return tokenVerifier.verify(token);
  } catch (legacyError) {
    // Supabase may issue tokens signed with a managed/JWKS key rather than the
    // legacy project JWT secret. Validate those through Auth instead of
    // treating a valid session as anonymous. Never log or return the token.
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user?.id) {
      logger.warn(`[verifyBearerToken] auth-server fallback failed: ${error ? error.message : 'no user'}`);
      throw legacyError;
    }
    return {
      sub: data.user.id,
      email: data.user.email,
      role: 'authenticated',
      user_metadata: data.user.user_metadata || {},
      app_metadata: data.user.app_metadata || {}
    };
  }
}

const verifyUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if ((!authHeader || !authHeader.startsWith('Bearer ')) && !(req.isImpersonated && req.user?.sub)) {
    return apiError(res, 401, 'Unauthorized: No token provided', `HTTP_401`);
  }

  try {
    if (!req.isImpersonated || !req.user?.sub) {
      req.user = await verifyBearerToken(authHeader.split(' ')[1]);
    }
    next();
  } catch (error) {
    logger.error('JWT verification error:', error.message);
    return apiError(res, 401, 'Unauthorized: Invalid or expired token', `HTTP_401`);
  }
};

// ─────────────────────────────────────────────────────────────
// Middleware: optionalAuth
// Like verifyUser but non-blocking (sets req.user = null if no token).
// ─────────────────────────────────────────────────────────────
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    req.user = await verifyBearerToken(authHeader.split(' ')[1]);
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
      return apiError(res, 403, 'Forbidden: Admin access required', `HTTP_403`);
    } catch (err) {
      logger.error('verifyAdmin lookup failed:', err.message);
      if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError' || err.message.includes('token')) { return apiError(res, 401, 'Unauthorized: Invalid or expired token', `HTTP_401`); } return apiError(res, 500, 'Internal server error', `HTTP_500`);
    }
  });
};

const PERMISSION_ALIASES = {
  'orders.write': ['orders.write', 'tenant.orders.write', 'orders.create'],
  'orders.read': ['orders.read', 'tenant.orders.read', 'orders.view'],
  'orders.create': ['orders.create', 'tenant.orders.write', 'orders.write'],
  'orders.view': ['orders.view', 'tenant.orders.read', 'orders.read'],
  'products.read': ['products.read', 'tenant.products.read', 'products.view'],
  'products.write': ['products.write', 'tenant.products.write', 'products.create', 'products.update'],
  'products.view': ['products.view', 'tenant.products.read', 'products.read'],
  'products.create': ['products.create', 'tenant.products.write', 'products.write'],
  'inventory.read': ['inventory.read', 'tenant.inventory.read'],
  'inventory.write': ['inventory.write', 'tenant.inventory.write'],
  'customers.read': ['customers.read', 'tenant.customers.read'],
  'customers.write': ['customers.write', 'tenant.customers.write'],
  'finance.read': ['finance.read', 'tenant.finance.read'],
  'reports.read': ['reports.read', 'tenant.reports.read'],
  'marketing.write': ['marketing.write', 'tenant.marketing.write'],
  'settings.write': ['settings.write', 'tenant.settings.write', 'settings.update'],
  'settings.view': ['settings.view', 'tenant.settings.read'],
  'support.write': ['support.write', 'tenant.support.write'],
  'branches.manage': ['branches.manage', 'tenant.branches.manage']
};

function expandPermissions(perms) {
  const permList = Array.isArray(perms) ? perms : [perms];
  const expanded = new Set();
  for (const p of permList) {
    if (!p) continue;
    expanded.add(p);
    if (PERMISSION_ALIASES[p]) {
      for (const alias of PERMISSION_ALIASES[p]) {
        expanded.add(alias);
      }
    }
  }
  return [...expanded];
}

// ─────────────────────────────────────────────────────────────
// Middleware: verifyPermission(permissionName)
// The PRIMARY authorization primitive. Use this everywhere.
//
// Supports single permission string or array of permissions (OR logic).
// Transparently handles permission aliases (e.g. legacy vs tenant.* names).
//
// For store-level permissions: verifyPermission('products.create')
// For platform-level permissions: verifyPermission('platform.stores.view')
// ─────────────────────────────────────────────────────────────
const verifyPermission = (permissionName) => {
  const rawPerms = Array.isArray(permissionName) ? permissionName : [permissionName];
  const expandedPerms = expandPermissions(rawPerms);
  const isPlatformPermission = rawPerms.some((p) => typeof p === 'string' && p.startsWith('platform.'));

  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if ((!authHeader || !authHeader.startsWith('Bearer ')) && !(req.isImpersonated && req.user?.sub)) {
      return apiError(res, 401, 'Unauthorized: No token provided', `HTTP_401`);
    }

    try {
      const decoded = req.isImpersonated && req.user?.sub
        ? req.user
        : await verifyBearerToken(authHeader.split(' ')[1]);
      req.user = decoded;

      const userId = decoded.sub;

      if (isPlatformPermission) {
        if (req.isImpersonated === true) {
          return apiError(res, 403, 'Platform permissions are unavailable during tenant impersonation', 'IMPERSONATION_PLATFORM_SCOPE');
        }
        const platformPermissions = await resolvePlatformPermissions(userId);

        if (platformPermissions === null) {
          return apiError(res, 403, 'Forbidden: Platform access required', `HTTP_403`);
        }

        const hasPlatformPerm = expandedPerms.some((p) => platformPermissions.includes(p));
        if (!hasPlatformPerm) {
          return apiError(res, 403, `Forbidden: Missing permission '${rawPerms.join(', ')}'`, `HTTP_403`);
        }

        return next();
      }

      // Store-level permission check
      const storeId = req.store?.id;
      if (!storeId) {
        return apiError(res, 403, 'Forbidden: Tenant context required', `HTTP_403`);
      }

      const isCashierSession = decoded.role === 'cashier' || req.headers['x-pos-session-role'] === 'cashier';

      const storePermissions = await resolveStorePermissions(userId, storeId, {
        impersonated: req.isImpersonated === true,
        role: isCashierSession ? 'cashier' : decoded.role
      });

      const hasStorePerm = expandedPerms.some((p) => storePermissions.includes(p));
      if (!hasStorePerm) {
        return apiError(res, 403, `Forbidden: Missing permission '${rawPerms.join(', ')}'`, `HTTP_403`);
      }

      return next();
    } catch (err) {
      logger.error(`verifyPermission('${JSON.stringify(permissionName)}') failed:`, err.message);
      if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError' || err.message.includes('token')) {
        return apiError(res, 401, 'Unauthorized: Invalid or expired token', `HTTP_401`);
      }
      return apiError(res, 500, 'Internal server error', `HTTP_500`);
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
      req.permissions = await resolveStorePermissions(userId, storeId, {
        impersonated: req.isImpersonated === true
      });
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
  verifyBearerToken,
};
