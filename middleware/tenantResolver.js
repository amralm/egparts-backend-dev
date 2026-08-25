const { apiError } = require('../utils/apiError');
const { supabase } = require('../services/supabase');

// Load reserved subdomains from env or fallback list
const reservedEnv = process.env.RESERVED_SUBDOMAINS || 'media,api,admin,www,cdn,assets,status,docs,mail,smtp';
const RESERVED_SUBDOMAINS = reservedEnv.split(',').map(s => s.trim().toLowerCase());
const PRIMARY_DOMAIN = (process.env.PRIMARY_DOMAIN || 'egparts.store').toLowerCase();
const DEFAULT_STORE_SUBDOMAIN = (process.env.DEFAULT_STORE_SUBDOMAIN || 'egparts').toLowerCase();

module.exports = async function tenantResolver(req, res, next) {
  try {
    // Bypass tenant resolver for webhooks, payment redirects, and OAuth authentication flows
    if (
      req.path.endsWith('/webhook') || 
      req.path.includes('/webhook') ||
      req.path.includes('/api/auth/oauth/') ||
      req.path.includes('/oauth/callback') ||
      req.path.includes('/verify-redirect')
    ) {
      req.store = null;
      req.context = { type: 'platform' };
      return next();
    }

    function getSubdomainFromHost(host) {
      if (!host) return null;
      let cleanHost = host.toLowerCase().trim().split(':')[0]; // Strip port
      if (cleanHost.startsWith('www.')) {
        cleanHost = cleanHost.substring(4);
      }
      if (!cleanHost) return null;

      const isPlatformDomain = cleanHost === PRIMARY_DOMAIN || cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === 'onrender.com';
      const isPlatformSubdomain = cleanHost.endsWith(`.${PRIMARY_DOMAIN}`) || cleanHost.endsWith('.localhost') || cleanHost.endsWith('.onrender.com');

      if (isPlatformDomain) {
        return DEFAULT_STORE_SUBDOMAIN;
      } else if (isPlatformSubdomain) {
        return cleanHost.split('.')[0];
      } else {
        // Custom domain: search as a full domain name (e.g. mypartsstore.com)
        return cleanHost;
      }
    }

    // Normalized full host (port + www stripped) — keeps the complete domain
    // so custom domains inside the primary zone resolve by their full name.
    function getCleanHost(host) {
      if (!host) return null;
      let cleanHost = String(host).toLowerCase().trim().split(':')[0];
      if (cleanHost.startsWith('www.')) cleanHost = cleanHost.substring(4);
      return cleanHost || null;
    }

    let subdomain = req.headers['x-store-subdomain'] || req.query.store_subdomain;

    if (!subdomain) {
      const host = req.headers['x-original-host'] || req.headers['x-forwarded-host'] || req.headers.host;
      subdomain = getSubdomainFromHost(host);
    }

    // Fallback to Origin/Referer if subdomain is resolved as the backend domain itself
    const isBackendHost = subdomain === 'egparts-backend' || subdomain === 'egparts-router' || (subdomain && subdomain.endsWith('-backend'));
    if (!subdomain || isBackendHost) {
      const origin = req.headers.origin || req.headers.referer;
      if (origin) {
        try {
          const url = new URL(origin);
          const originSub = getSubdomainFromHost(url.hostname);
          if (originSub && originSub !== 'egparts-backend' && originSub !== 'egparts-router' && !originSub.endsWith('-backend')) {
            subdomain = originSub;
          }
        } catch (e) {
          // ignore
        }
      }
    }

    if (!subdomain) {
      subdomain = DEFAULT_STORE_SUBDOMAIN;
    }

    // Clean subdomain and handle staging/testing subdomains mapping
    subdomain = subdomain.toLowerCase().trim();

    // Only a DNS label or a normalized custom domain is valid here. Keeping
    // this strict also prevents user input from being interpreted as a
    // PostgREST filter expression.
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(subdomain)) {
      return apiError(res, 400, 'معرف المتجر غير صالح', 'INVALID_TENANT_IDENTIFIER');
    }
    
    const isReserved = 
      subdomain === 'egparts-frontend' ||
      subdomain === 'egparts-backend' ||
      subdomain === 'egparts-router' ||
      RESERVED_SUBDOMAINS.includes(subdomain);

    if (isReserved) {
      // Platform / System context - bypass database query entirely and skip tenant resolution
      req.store = null;
      req.context = { type: 'platform' };
      return next();
    }

    const { tenantCache } = require('../utils/cache');
    
    // Check cache first
    let store = tenantCache.get(subdomain);

    if (!store) {
      // Query store status
      const { data: subdomainStore, error: subdomainError } = await supabase
        .from('stores').select('*').eq('subdomain', subdomain).maybeSingle();
      let data = subdomainStore;
      let error = subdomainError;
      let resolvedKey = subdomain;
      if (!data && !error) {
        const customResult = await supabase.from('stores').select('*').eq('custom_domain', subdomain).maybeSingle();
        data = customResult.data;
        error = customResult.error;
      }

      // Custom domains INSIDE the primary zone (e.g. client.egparts.store)
      // arrive with x-store-subdomain reduced to the first label ('client').
      // When both lookups above miss, retry using the FULL original host so
      // registered custom domains inside the platform zone resolve too.
      const rawHost = getCleanHost(
        req.headers['x-original-host'] || req.headers['x-forwarded-host'] || req.headers.host
      );
      if (!data && !error && rawHost && rawHost !== subdomain) {
        const hostResult = await supabase
          .from('stores').select('*').eq('custom_domain', rawHost).maybeSingle();
        if (!hostResult.error && hostResult.data) {
          data = hostResult.data;
          resolvedKey = rawHost;
        }
      }

      if (error || !data) {
        return apiError(res, 404, 'المتجر غير موجود', `HTTP_404`);
      }

      store = data;
      tenantCache.set(resolvedKey, store);
    }

    // Check subscription status
    const isExpired = new Date(store.subscription_expires_at) < new Date();
    if (!store.is_active || isExpired) {
      const isContextOrUsage = req.path === '/store-context' || req.path === '/store-usage';
      if (!isContextOrUsage) {
        return apiError(
          res,
          403,
          isExpired ? 'انتهت صلاحية اشتراك هذا المتجر.' : 'هذا المتجر معلق حاليًا.',
          isExpired ? 'STORE_SUBSCRIPTION_EXPIRED' : 'STORE_SUSPENDED',
          { is_suspended: true }
        );
      }
    }

    // Attach store context and set context type
    req.store = store;
    req.context = { type: 'tenant' };
    next();
  } catch (err) {
    console.error('Tenant resolver error:', err);
    return apiError(res, 500, 'خطأ داخلي في الخادم أثناء تحديد هوية المتجر', `HTTP_500`);
  }
};
