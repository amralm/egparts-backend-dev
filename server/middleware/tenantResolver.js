const { createClient } = require('@supabase/supabase-js');

// Initialize a service-role client for backend resolving (bypasses RLS to fetch store status)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function tenantResolver(req, res, next) {
  try {
    // Bypass tenant resolver for platform/admin endpoints (no store context needed)
    const bypassPaths = ['/platform/', '/health/', '/db-proxy', '/payments/status/', '/payments/active', '/blocked/check', '/auth/validate-admin', '/auth/qr-login', '/store-context', '/store-usage'];
    if (bypassPaths.some(p => req.path.startsWith(p) || req.path.includes(p))) {
      req.store = null;
      req.context = { type: 'platform' };
      return next();
    }

    // Bypass tenant resolver for webhooks
    if (req.path.endsWith('/webhook') || req.path.includes('/webhook')) {
      return next();
    }

    let subdomain = req.headers['x-store-subdomain'] || req.query.store_subdomain;

    // Check for proxy forwarding headers (like Cloudflare Worker or custom CDN) first
    if (!subdomain) {
      const forwardedHost = req.headers['x-original-host'] || req.headers['x-forwarded-host'];
      if (forwardedHost) {
        const parts = forwardedHost.split('.');
        if (parts.length > 2) {
          subdomain = parts[0];
        } else {
          subdomain = 'egparts';
        }
      }
    }

    // If not provided in headers or query, try parsing from Origin or Referer header
    if (!subdomain) {
      const origin = req.headers.origin || req.headers.referer;
      if (origin) {
        try {
          const url = new URL(origin);
          const hostname = url.hostname; // e.g., shop1.egparts.com or localhost
          
          // If it is localhost or IP, fallback to default or let query param handle it
          if (hostname === 'localhost' || hostname === '127.0.0.1') {
            subdomain = 'egparts';
          } else {
            const parts = hostname.split('.');
            if (parts.length > 2) {
              subdomain = parts[0]; // e.g., 'shop1' from 'shop1.egparts.com'
            } else {
              subdomain = 'egparts'; // fallback
            }
          }
        } catch (e) {
          subdomain = 'egparts';
        }
      } else {
        subdomain = 'egparts'; // fallback
      }
    }

    // Clean subdomain and handle staging/testing subdomains mapping
    subdomain = subdomain.toLowerCase().trim();
    if (subdomain === 'egparts-frontend' || subdomain === 'egparts-backend' || subdomain === 'egparts-router') {
      subdomain = 'egparts';
    }

    // Query store status (with subdomain validation for security)
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
      return res.status(404).json({ success: false, error: 'المتجر غير موجود' });
    }
    const { data: store, error } = await supabase
      .from('stores')
      .select('*')
      .or(`subdomain.eq.${subdomain},custom_domain.eq.${subdomain}`)
      .single();

    if (error || !store) {
      return res.status(404).json({ success: false, error: 'المتجر غير موجود' });
    }

    // Check subscription status
    const isExpired = new Date(store.subscription_expires_at) < new Date();
    if (!store.is_active || isExpired) {
      return res.status(402).json({
        success: false,
        error: 'عذراً، هذا المتجر متوقف مؤقتاً لانتهاء فترة الاشتراك. يرجى التواصل مع الإدارة للتجديد.',
        is_suspended: true
      });
    }

    // Attach store context to the request
    req.store = store;
    next();
  } catch (err) {
    console.error('Tenant resolver error:', err);
    return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم أثناء تحديد هوية المتجر' });
  }
};
