const { supabase } = require('../services/supabase');

// Load reserved subdomains from env or fallback list
const reservedEnv = process.env.RESERVED_SUBDOMAINS || 'media,api,admin,www,cdn,assets,status,docs,mail,smtp';
const RESERVED_SUBDOMAINS = reservedEnv.split(',').map(s => s.trim().toLowerCase());
const PRIMARY_DOMAIN = (process.env.PRIMARY_DOMAIN || 'egparts.store').toLowerCase();
const DEFAULT_STORE_SUBDOMAIN = (process.env.DEFAULT_STORE_SUBDOMAIN || 'egparts').toLowerCase();

module.exports = async function tenantResolver(req, res, next) {
  try {
    // Bypass tenant resolver for webhooks and OAuth authentication flows
    if (
      req.path.endsWith('/webhook') || 
      req.path.includes('/webhook') ||
      req.path.includes('/api/auth/oauth/') ||
      req.path.includes('/oauth/callback')
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
      const { data, error } = await supabase
        .from('stores')
        .select('*')
        .or(`subdomain.eq.${subdomain},custom_domain.eq.${subdomain}`)
        .single();

      if (error || !data) {
        return res.status(404).json({ success: false, error: 'المتجر غير موجود' });
      }
      
      store = data;
      tenantCache.set(subdomain, store);
    }

    // Check subscription status
    const isExpired = new Date(store.subscription_expires_at) < new Date();
    if (!store.is_active || isExpired) {
      const isContextOrUsage = req.path === '/store-context' || req.path === '/store-usage';
      if (!isContextOrUsage) {
        return res.status(403).json({
          success: false,
          code: isExpired ? 'STORE_SUBSCRIPTION_EXPIRED' : 'STORE_SUSPENDED',
          error: 'عذراً، هذا المتجر متوقف مؤقتاً لانتهاء فترة الاشتراك. يرجى التواصل مع الإدارة للتجديد.',
          is_suspended: true
        });
      }
    }

    // Attach store context and set context type
    req.store = store;
    req.context = { type: 'tenant' };
    next();
  } catch (err) {
    console.error('Tenant resolver error:', err);
    return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم أثناء تحديد هوية المتجر' });
  }
};
