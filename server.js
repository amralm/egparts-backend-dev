require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const { blockIPMiddleware } = require('./middleware/blockIP');
const { banCheckMiddleware } = require('./middleware/banCheck');
const { verifyAdminOrLocal } = require('./middleware/qrAuth');
const cookieParser = require('cookie-parser');
const tenantResolver = require('./middleware/tenantResolver');
const { supabase } = require('./services/supabase');

const app = express();


// âœ… Ensure Express trusts Render's proxy for Rate Limiting
app.set('trust proxy', 1);

const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const paymentMethodsRoutes = require('./routes/paymentMethods');
const walletPaymentRoutes = require('./routes/walletPayments');
const authRoutes = require('./routes/auth');
const blockedRoutes = require('./routes/blocked');
const healthRoutes = require('./routes/health');
const platformRoutes = require('./routes/platform');
const limitsRoutes = require('./routes/limits');
const aiRoutes = require('./routes/ai');
const couponRoutes = require('./routes/coupons');
const shippingZoneRoutes = require('./routes/shippingZones');
const adminReviewRoutes = require('./routes/adminReviews');
const tenantSecurityRoutes = require('./routes/tenantSecurity');
const adminBannerRoutes = require('./routes/adminBanners');
const wishlistRoutes = require('./routes/wishlist');
const accountRoutes = require('./routes/account');
const productRoutes = require('./routes/products');
const adminContentRoutes = require('./routes/adminContent');
const adminProductRoutes = require('./routes/adminProducts');
const adminSettingsRoutes = require('./routes/adminSettings');
const adminDashboardRoutes = require('./routes/adminDashboard');
const storefrontRoutes = require('./routes/storefront');
const healthCollector = require('./services/healthCollector');
const whatsappService = require('./services/whatsappService');
const notificationWorker = require('./services/notificationWorker');
const domainValidator = require('./services/domainValidator');
const { startPaymentExpiryJob } = require('./services/paymentJobs');
const path = require('path');

// âœ… Start Background Jobs
startPaymentExpiryJob();

// âœ… 1. Startup Validation: Ensure critical ENV vars exist
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'FRONTEND_URL',
  'PORT',
  'DATABASE_ENCRYPTION_KEY',
  ...(process.env.NODE_ENV === 'production' ? ['OAUTH_ENCRYPTION_SECRET'] : [])
];

const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`\nâŒ FATAL ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please check your .env file or deployment settings.\n');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && process.env.OAUTH_ENCRYPTION_SECRET === 'a-very-secure-encryption-secret-32b-key') {
  console.error('\nâŒ FATAL ERROR: OAUTH_ENCRYPTION_SECRET is insecure in production!\n');
  process.exit(1);
}

// Validate byte length and uniqueness of all configured DATABASE_ENCRYPTION_KEY keys
const keyValues = new Set();
for (const key of Object.keys(process.env)) {
  if (key === 'DATABASE_ENCRYPTION_KEY' || key.startsWith('DATABASE_ENCRYPTION_KEY_V')) {
    const val = process.env[key];
    if (!val || !val.trim() || Buffer.byteLength(val, 'utf8') < 32) {
      console.error(`\nâŒ FATAL ERROR: ${key} must be configured, not empty or whitespace, and at least 32 bytes long.\n`);
      process.exit(1);
    }
    if (keyValues.has(val)) {
      console.warn(`\nâš ï¸ WARNING: Duplicate encryption key value detected in ${key}. While allowed for key transition, this is discouraged in production.\n`);
    }
    keyValues.add(val);
  }
}

// ✅ CORS — Allow only configured frontend URL(s), subdomains, Vercel preview apps, and localhost
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:5174',
].filter(Boolean);

// In-memory cache for validated custom domains to avoid database queries on every request
const customDomainsCache = new Set();
let lastCacheUpdate = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// âœ… Global Development Mode & Telemetry Middleware
app.use((req, res, next) => {
  if (global.DEV_MODE_ENABLED) {
    const start = process.hrtime();
    
    // Cache Bypass
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Diagnostic Headers
    res.setHeader('X-Debug-Request-ID', req.id || 'unknown');
    res.setHeader('X-Dev-Mode', 'Active');
    
    // Telemetry
    res.on('finish', () => {
      const diff = process.hrtime(start);
      const timeMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2);
      const memoryMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.debug(`[DEV] ${req.method} ${req.url} - ${timeMs}ms - Mem: ${memoryMB}MB`);
    });
  }
  next();
});

app.use(async (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    let isAllowed = false;
    if (ALLOWED_ORIGINS.includes(origin)) {
      isAllowed = true;
    } else {
      try {
        const parsedUrl = new URL(origin);
        const hostname = parsedUrl.hostname.toLowerCase();
        
        // 1. Local development
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
          isAllowed = true;
        }
        // 2. Main domain and tenant subdomains
        else if (
          hostname === (process.env.PRIMARY_DOMAIN || 'egparts.store') ||
          hostname.endsWith(`.${process.env.PRIMARY_DOMAIN || 'egparts.store'}`)
        ) {
          isAllowed = true;
        }
        // 3. Vercel deployment preview / main apps
        else if (hostname === 'vercel.app' || hostname.endsWith('.vercel.app')) {
          isAllowed = true;
        }
        // 4. Cloudflare Workers/Pages subdomains
        else if (hostname === 'workers.dev' || hostname.endsWith('.workers.dev')) {
          isAllowed = true;
        }

        // 5. Configured Frontend URL domain and subdomains
        if (!isAllowed && process.env.FRONTEND_URL) {
          try {
            const frontendUrl = new URL(process.env.FRONTEND_URL);
            if (hostname === frontendUrl.hostname || hostname.endsWith('.' + frontendUrl.hostname)) {
              isAllowed = true;
            }
          } catch (e) {
            if (hostname === process.env.FRONTEND_URL || hostname.endsWith('.' + process.env.FRONTEND_URL)) {
              isAllowed = true;
            }
          }
        }

        // 6. Dynamic Tenant Custom Domains (Database lookup with cache)
        if (!isAllowed) {
          const now = Date.now();
          if (now - lastCacheUpdate > CACHE_TTL) {
            try {
              const { data: stores } = await supabase
                .from('stores')
                .select('custom_domain')
                .not('custom_domain', 'is', null);
              
              customDomainsCache.clear();
              if (stores) {
                stores.forEach(s => {
                  if (s.custom_domain) {
                    customDomainsCache.add(s.custom_domain.toLowerCase().trim());
                  }
                });
              }
              lastCacheUpdate = now;
            } catch (err) {
              logger.error('Error fetching custom domains for CORS:', err.message);
            }
          }

          const cleanHost = hostname.trim();
          const noWwwHost = cleanHost.startsWith('www.') ? cleanHost.substring(4) : cleanHost;
          const wwwHost = 'www.' + cleanHost;
          
          if (customDomainsCache.has(cleanHost) || customDomainsCache.has(noWwwHost) || customDomainsCache.has(wwwHost)) {
            isAllowed = true;
          }
        }
      } catch (err) {
        // Invalid origin format
      }
    }

    if (isAllowed) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }
  }
  
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,PATCH,OPTIONS');
  // x-store-subdomain and x-original-host are required for multi-tenant store context resolution
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Content-Length, X-Requested-With, x-store-subdomain, X-Store-Subdomain, x-original-host, X-Original-Host, X-Correlation-ID, X-Request-ID, x-impersonate-session, X-Impersonate-Session'
  );
  // Expose correlation ID and developer diagnostics to the client for debugging
  res.header('Access-Control-Expose-Headers', 'X-Correlation-ID, X-Dev-Mode, X-Debug-Request-ID');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(helmet());

// ✅ Global Correlation ID — attached to every request before any route
const correlationId = require('./middleware/correlationId');
app.use(correlationId);



// ✅ Custom CSP for /qr pages — allows Turnstile CDN, Google Fonts, inline scripts (canvas particles)
// Must come AFTER helmet() to override its default strict CSP
const QR_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com 'unsafe-inline'",
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com data:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "img-src 'self' data: https://api.qrserver.com https://challenges.cloudflare.com",
  "worker-src blob:"
].join('; ');

app.use(['/qr', '/qr/reset', '/qr/logout', '/api/auth/qr-login'], (req, res, next) => {
  res.setHeader('Content-Security-Policy', QR_CSP);
  next();
});

// ✅ Raw body for Paymob webhook
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cookieParser());

// ✅ Enforce UTF-8 charset on all JSON responses to prevent garbled Arabic text
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return originalJson(data);
  };
  next();
});

// âœ… Platform Health Check Dashboard (bypasses tenantResolver for super-admin access)
app.use('/api/health', healthRoutes);

// ✅ Platform SaaS Administration APIs (bypasses tenantResolver, verified via public.super_admins)
app.use('/api/platform', platformRoutes);

// ✅ Client Error Logger Endpoint (bypasses tenantResolver)
app.post('/api/logs/client-error', async (req, res) => {
  try {
    const fs = require('fs');
    const { message, stack, url, timestamp, storeName, userAgent } = req.body;
    
    // 1. Local File Logging (Fallback / local debugging convenience)
    const logEntry = `[${timestamp || new Date().toISOString()}]
URL: ${url || 'unknown'}
Store: ${storeName || 'unknown'}
User Agent: ${userAgent || 'unknown'}
Message: ${message || 'No message'}
Stack Trace:
${stack || 'No stack trace available'}
--------------------------------------------------------------------------------\n`;

    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }
    fs.appendFileSync(path.join(logsDir, 'client_errors.log'), logEntry, 'utf8');

    // 2. Database Logging (Shared / Production convenience)
    const { supabase } = require('./services/supabase');
    const { error } = await supabase
      .from('client_error_logs')
      .insert([{
        message,
        stack,
        url,
        store_name: storeName,
        user_agent: userAgent,
        created_at: timestamp || new Date().toISOString()
      }]);

    if (error) {
      logger.error('Failed to write client error to Supabase:', error.message);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('Failed to log client error:', err.message);
    res.status(500).json({ error: 'Failed to record log' });
  }
});

// âœ… Maintenance Mode Middleware (blocks visitors if maintenance is active, allows super admins)
const maintenanceMiddleware = require('./middleware/maintenance');
app.use('/api/', maintenanceMiddleware);


// âœ… Blocked IP check route (Must bypass IP blocking checks so blocked users can verify their status)
app.use('/api/blocked', tenantResolver, blockedRoutes);

// âœ… Resolve Tenant for all other API endpoints
app.use('/api/', tenantResolver);

app.get('/api/store-context', (req, res) => {
  if (!req.store?.id) {
    return res.status(404).json({ success: false, code: 'STORE_NOT_FOUND', error: 'Store context not found' });
  }

  const store = req.store;
  res.json({
    id: store.id,
    name: store.name,
    subdomain: store.subdomain,
    custom_domain: store.custom_domain,
    logo_url: store.logo_url,
    primary_color: store.primary_color,
    is_active: store.is_active,
    status: store.status,
    subscription_expires_at: store.subscription_expires_at,
    created_at: store.created_at,
    updated_at: store.updated_at
  });
});

app.get('/api/store-usage', async (req, res) => {
  if (!req.store?.id) {
    return res.status(404).json({ success: false, code: 'STORE_NOT_FOUND', error: 'Store context not found' });
  }

  try {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now);
    monthStart.setDate(1);
    // Sync image usage count to ensure accuracy
    try {
      await supabase.rpc('sync_store_image_usage', { p_store_id: req.store.id });
    } catch (syncErr) {
      logger.warn(`Failed to sync store image usage for ${req.store.id}:`, syncErr.message);
    }

    const [
      subscriptionResult,
      productsCountResult,
      branchesCountResult,
      couponsCountResult,
      staffCountResult,
      todayOtp,
      monthOtp,
      failedOtp,
      usageResult
    ] = await Promise.all([
      supabase
        .from('store_subscriptions')
        .select('id, plan_id, status, expires_at, plans(id, code, display_name)')
        .eq('store_id', req.store.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', req.store.id),
      supabase
        .from('branches')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', req.store.id),
      supabase
        .from('coupons')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', req.store.id),
      supabase
        .from('user_roles')
        .select('user_id', { count: 'exact', head: true })
        .eq('store_id', req.store.id),
      supabase
        .from('otp_audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', req.store.id)
        .eq('status', 'sent')
        .gte('created_at', dayStart.toISOString()),
      supabase
        .from('otp_audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', req.store.id)
        .eq('status', 'sent')
        .gte('created_at', monthStart.toISOString()),
      supabase
        .from('otp_audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', req.store.id)
        .eq('status', 'failed')
        .gte('created_at', monthStart.toISOString()),
      supabase
        .from('feature_usage')
        .select('feature_key, usage_count')
        .eq('store_id', req.store.id)
    ]);

    const PolicyEngine = require('./services/policyEngine');
    const limits = await PolicyEngine.getStoreLimits(req.store.id);

    const usagesMap = Object.fromEntries((usageResult.data || []).map(u => [u.feature_key, u.usage_count]));

    // Fetch OTP limits from otp_messages_month or fallback to whatsapp_notifications
    const otpLimit = limits['otp_messages_month']?.max_value ?? 
                     limits['whatsapp_notifications']?.max_value ?? 1000;

    res.json({
      store: {
        id: req.store.id,
        name: req.store.name,
        subdomain: req.store.subdomain,
        is_active: req.store.is_active,
        status: req.store.status,
        subscription_expires_at: req.store.subscription_expires_at
      },
      subscription: subscriptionResult.data ? {
        ...subscriptionResult.data,
        plans: subscriptionResult.data.plans ? {
          ...subscriptionResult.data.plans,
          name: subscriptionResult.data.plans.display_name
        } : null
      } : null,
      otp: {
        sent_today: todayOtp.count || 0,
        sent_this_month: monthOtp.count || 0,
        failed_this_month: failedOtp.count || 0,
        daily_limit: parseInt(process.env.OTP_DAILY_PHONE_LIMIT || '5', 10),
        monthly_limit: otpLimit,
        is_unlimited: otpLimit === null
      },
      limits: {
        products: {
          usage: productsCountResult.count || 0,
          limit: limits['products']?.max_value ?? null,
          is_unlimited: !limits['products'] || limits['products'].max_value === null
        },
        branches: {
          usage: branchesCountResult.count || 0,
          limit: limits['branches']?.max_value ?? 1,
          is_unlimited: limits['branches']?.max_value === null
        },
        coupons: {
          usage: couponsCountResult.count || 0,
          limit: limits['coupons']?.max_value ?? 0,
          enabled: limits['coupons'] ? (limits['coupons'].limit_type === 'boolean' ? !!limits['coupons'].limit_config?.enabled : limits['coupons'].limit_type !== 'disabled') : false
        },
        staff_users: {
          usage: staffCountResult.count || 0,
          limit: limits['staff_users']?.max_value ?? 1,
          is_unlimited: limits['staff_users']?.max_value === null
        },
        custom_domain: {
          enabled: limits['custom_domain'] ? (limits['custom_domain'].limit_type === 'boolean' ? !!limits['custom_domain'].limit_config?.enabled : limits['custom_domain'].limit_type !== 'disabled') : false
        },
        storage_bytes: {
          usage: usagesMap['storage_bytes'] || 0,
          limit: limits['storage_bytes']?.max_value ?? null,
          is_unlimited: !limits['storage_bytes'] || limits['storage_bytes'].max_value === null
        },
        uploaded_images: {
          usage: usagesMap['uploaded_images'] || 0,
          limit: limits['uploaded_images']?.max_value ?? null,
          is_unlimited: !limits['uploaded_images'] || limits['uploaded_images'].max_value === null
        },
        api_requests_day: {
          usage: usagesMap['api_requests_day'] || 0,
          limit: limits['api_requests_day']?.max_value ?? 0,
          enabled: limits['api_requests_day'] ? limits['api_requests_day'].limit_type !== 'disabled' : false
        },
        ai_requests_month: {
          usage: usagesMap['ai_requests_month'] || 0,
          limit: limits['ai_requests_month']?.max_value ?? null,
          is_unlimited: !limits['ai_requests_month'] || limits['ai_requests_month'].max_value === null
        },
        export_formats: {
          allowed: limits['export_formats']?.limit_config?.allowed_formats || 'csv'
        }
      }
    });
  } catch (err) {
    logger.error('Failed to load store usage:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load store usage' });
  }
});

// âœ… Blocked IPs Middleware (now scopes using req.store)
app.use('/api/', blockIPMiddleware);

// âœ… Ban Check Middleware (now scopes using req.store)
app.use('/api/', banCheckMiddleware);

// âœ… Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/', generalLimiter);

// âœ… Routes (tenant is already resolved globally above)
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/payments/methods', paymentMethodsRoutes);
app.use('/api/payments/wallet', walletPaymentRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/shipping-zones', shippingZoneRoutes);
app.use('/api/admin/reviews', adminReviewRoutes);
app.use('/api/security', tenantSecurityRoutes);
app.use('/api/admin/banners', adminBannerRoutes);
app.use('/api/admin/content', adminContentRoutes);
app.use('/api/admin/products', adminProductRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/storefront', storefrontRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/products', productRoutes);
const storageRoutes = require('./routes/storage');
app.use('/api/storage', storageRoutes);
app.use('/api/limits', limitsRoutes);
app.use('/api/copilot', aiRoutes);

// âœ… WhatsApp Auth Routes
app.post('/api/auth/qr-login', async (req, res) => {
  const { username, password, turnstileToken } = req.body;
  const { safeCompare, QR_USER, QR_PASS } = require('./middleware/qrAuth');
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'الرجاء إدخال اسم المستخدم وكلمة المرور' });
  }

  // Verify Turnstile — REQUIRED when TURNSTILE_SECRET_KEY is configured
  const secretKey = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (secretKey && !global.DEV_MODE_ENABLED) {
    if (!turnstileToken) {
      return res.status(403).json({ success: false, error: 'يجب إتمام بوابة التحقق الأمني (Turnstile) أولاً' });
    }
    try {
      const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: secretKey, response: turnstileToken })
      });
      const tsData = await tsRes.json();
      if (!tsData.success) {
        return res.status(403).json({ success: false, error: 'Ù Ø´Ù„ Ø§Ù„ØªØ­Ù‚Ù‚ Ø§Ù„Ø£Ù…Ù†ÙŠ (Turnstile) â€” Ø­Ø§ÙˆÙ„ Ù…Ø±Ø© Ø£Ø®Ø±Ù‰' });
      }
    } catch (err) {
      logger.error('Turnstile API error:', err.message);
      return res.status(500).json({ success: false, error: 'تعذر الاتصال بخدمة التحقق — حاول مرة أخرى' });
    }
  }Ø±Ù‰' });
      }
    } catch (err) {
      logger.error('Turnstile API error:', err.message);
      return res.status(500).json({ success: false, error: 'تعذر الاتصال بخدمة التحقق — حاول مرة أخرى' });
    }
  }

  // Validate Credentials
  if (safeCompare(username, QR_USER) && safeCompare(password, QR_PASS)) {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ role: 'qr_admin' }, process.env.SUPABASE_JWT_SECRET, { expiresIn: '1d' });
    res.cookie('qr_admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 1 day
    });
    return res.json({ success: true });
  }

  return res.status(401).json({ success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

app.post('/qr/logout', (req, res) => {
  res.clearCookie('qr_admin_token');
  res.redirect('/qr');
});

// âœ… WhatsApp QR Dashboard â€” ADMIN ONLY
app.get('/qr', verifyAdminOrLocal, async (req, res) => {
  const { phone } = req.query;
  const isConnected = whatsappService.isReady;
  let pairingCode = whatsappService.pairingCode;
  const qr = whatsappService.lastQR;

  if (phone) {
    try {
      let cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.startsWith('0')) cleanPhone = '2' + cleanPhone;
      pairingCode = await whatsappService.requestPairingCode(cleanPhone);
    } catch (err) { console.error('Pairing code error:', err); }
  }

  const sColor = isConnected ? '#22c55e' : '#f59e0b';
  const sBg    = isConnected ? 'rgba(34,197,94,0.1)'  : 'rgba(245,158,11,0.1)';
  const sBdr   = isConnected ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.25)';
  const sTxt   = isConnected ? 'متصل ونشط' : 'في انتظار المصادقة';
  const qrSrc  = qr ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&color=ffffff&bgcolor=0d0d10&data=${encodeURIComponent(qr)}` : '';

  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>لوحة الواتساب — EG-PARTS</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{--red:#dc2626;--bg:#060608;--card:rgba(18,18,24,0.88);--border:rgba(255,255,255,0.07);--text:#f1f1f3;--muted:#71717a;}
    html,body{min-height:100%;font-family:'Cairo',system-ui,sans-serif;background:var(--bg);color:var(--text);}
    #cv{position:fixed;inset:0;z-index:0;pointer-events:none;}
    .gr{position:fixed;inset:0;z-index:1;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,0.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.018) 1px,transparent 1px);background-size:55px 55px;}
    .vg{position:fixed;inset:0;z-index:2;pointer-events:none;background:radial-gradient(ellipse 90% 90% at 50% 50%,transparent 40%,rgba(6,6,8,0.8) 100%);}
    .wrap{position:relative;z-index:10;max-width:700px;margin:0 auto;padding:2rem 1.5rem 4rem;}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2.5rem;flex-wrap:wrap;gap:1rem;}
    .brand{font-size:1.4rem;font-weight:900;letter-spacing:-.5px;}
    .brand span{color:var(--red);}
    .sp{display:inline-flex;align-items:center;gap:.5rem;padding:.4rem 1rem;border-radius:50px;font-size:.78rem;font-weight:700;background:${sBg};border:1px solid ${sBdr};color:${sColor};}
    .sd{width:8px;height:8px;border-radius:50%;background:${sColor};${isConnected ? 'animation:pulse 2s ease-in-out infinite;' : ''}}
    @keyframes pulse{0%,100%{box-shadow:0 0 0 0 ${sColor}88;}50%{box-shadow:0 0 0 6px ${sColor}00;}}
    .card{background:var(--card);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid var(--border);border-radius:20px;padding:1.75rem;position:relative;overflow:hidden;margin-bottom:1.25rem;}
    .card::before{content:'';position:absolute;top:0;left:20%;right:20%;height:1px;background:linear-gradient(90deg,transparent,rgba(220,38,38,0.4),transparent);}
    .ct{font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:1.25rem;}
    .qw{display:flex;align-items:center;justify-content:center;min-height:260px;border-radius:14px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.04);}
    .qi{border-radius:12px;box-shadow:0 0 40px rgba(220,38,38,0.15),0 0 0 8px rgba(255,255,255,0.04);display:block;}
    .qp{text-align:center;padding:2.5rem;color:var(--muted);font-size:.85rem;}
    .qp svg{display:block;margin:0 auto .75rem;}
    .cb{background:rgba(0,0,0,0.4);border:1px dashed rgba(34,197,94,0.3);border-radius:14px;padding:1.5rem;text-align:center;margin-bottom:1.5rem;}
    .cl{font-size:.72rem;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.75rem;}
    .cv{font-size:2.5rem;font-weight:900;letter-spacing:.2em;color:#fff;direction:ltr;}
    .ch{font-size:.78rem;color:var(--muted);margin-top:.6rem;}
    .pf{display:flex;gap:.75rem;flex-wrap:wrap;}
    .pi{flex:1;min-width:180px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:.8rem 1rem;color:var(--text);font-family:'Cairo',sans-serif;font-size:.9rem;direction:ltr;outline:none;transition:border-color .2s;}
    .pi:focus{border-color:rgba(220,38,38,.4);}
    .pi::placeholder{color:#3f3f46;}
    .btn{padding:.8rem 1.5rem;border:none;border-radius:12px;cursor:pointer;font-family:'Cairo',sans-serif;font-weight:700;font-size:.85rem;display:inline-flex;align-items:center;gap:.5rem;transition:all .2s;}
    .bp{background:linear-gradient(135deg,#dc2626,#991b1b);color:#fff;box-shadow:0 4px 18px rgba(220,38,38,.3);}
    .bp:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(220,38,38,.45);}
    .bd{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#f87171;}
    .bd:hover{background:rgba(239,68,68,.18);}
    .bg{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--muted);}
    .bg:hover{background:rgba(255,255,255,.09);color:var(--text);}
    .bi svg{width:16px;height:16px;}
    .acts{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.25rem;}
    .dv{height:1px;background:var(--border);margin:1.5rem 0;}
    .ol{display:inline-flex;align-items:center;gap:.4rem;color:var(--red);font-size:.82rem;font-weight:700;text-decoration:none;padding:.5rem .9rem;border-radius:10px;border:1px solid rgba(220,38,38,.2);background:rgba(220,38,38,.07);margin-top:1rem;transition:all .2s;}
    .ol:hover{background:rgba(220,38,38,.14);}
    .ol svg{width:14px;height:14px;}
    .rb{height:3px;background:linear-gradient(90deg,var(--red),transparent);border-radius:3px;margin-top:1rem;animation:shrink 30s linear infinite;}
    @keyframes shrink{from{width:100%}to{width:0%}}
    .hl{list-style:none;display:flex;flex-direction:column;gap:.6rem;}
    .hl li{display:flex;align-items:flex-start;gap:.6rem;font-size:.82rem;color:var(--muted);}
    .hl li::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--red);margin-top:.45rem;flex-shrink:0;}
  </style>
</head>
<body>
  <canvas id="cv"></canvas><div class="gr"></div><div class="vg"></div>
  <div class="wrap">
    <header>
      <div class="brand">EG<span>-</span>PARTS <span style="font-weight:400;font-size:1rem;color:var(--muted)">/ واتساب</span></div>
      <div class="sp"><div class="sd"></div>${sTxt}</div>
    </header>

    <div class="card">
      <div class="ct">رمز الاستجابة السريعة (QR Code)</div>
      ${pairingCode ? `<div class="cb"><div class="cl">كود الربط</div><div class="cv">${pairingCode}</div><div class="ch">ادخل هذا الكود في تطبيق واتساب على هاتفك</div></div>` : ''}
      <div class="qw">
        ${qr
          ? `<img class="qi" src="${qrSrc}" width="240" height="240" alt="QR Code">`
          : `<div class="qp"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#3f3f46" stroke-width="1.2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="3" height="3"/></svg>لا يوجد رمز QR حالياً — استخدم زر إعادة التعيين أدناه</div>`
        }
      </div>
      ${qr ? `
        <a class="ol" href="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}" target="_blank">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          فتح الرمز بحجم كبير في نافذة جديدة
        </a>
        <div class="rb"></div>` : ''}
    </div>

    <div class="card">
      <div class="ct">الربط عبر رقم الهاتف (Pairing Code)</div>
      <form action="/qr" method="GET" class="pf">
        <input class="pi" type="tel" name="phone" placeholder="2010xxxxxxxx" required>
        <button type="submit" class="btn bp bi">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13 19.79 19.79 0 0 1 1.61 4.38 2 2 0 0 1 3.58 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.18 6.18l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          طلب كود الربط
        </button>
      </form>
    </div>

    <div class="card">
      <div class="ct">الإجراءات</div>
      <div class="acts">
        <button onclick="location.reload()" class="btn bg bi">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          تحديث الصفحة
        </button>
        <form action="/qr/reset" method="POST" style="margin:0" onsubmit="return confirm('سيتم مسح الجلسة وإعادة التشغيل. متأكد؟')">
          <button type="submit" class="btn bd bi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
            إعادة تعيين الجلسة
          </button>
        </form>
        <form action="/qr/logout" method="POST" style="margin:0">
          <button type="submit" class="btn bg bi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            تسجيل الخروج
          </button>
        </form>
      </div>
      <div class="dv"></div>
      <ul class="hl">
        <li>افتح تطبيق واتساب — المزيد من الخيارات — الأجهزة المرتبطة — ربط جهاز</li>
        <li>وجّه كاميرا الهاتف نحو رمز QR أو أدخل كود الربط يدوياً</li>
        <li>بعد الربط الناجح ستتحول حالة الاتصال إلى “متصل ونشط” تلقائياً</li>
        <li>الصفحة تُحدَّث تلقائياً كل 30 ثانية عند عدم الاتصال</li>
      </ul>
    </div>
  </div>
  <script>
    const cv=document.getElementById('cv'),ctx=cv.getContext('2d');
    function rz(){cv.width=innerWidth;cv.height=innerHeight;}rz();addEventListener('resize',rz);
    const rnd=(a,b)=>Math.random()*(b-a)+a;
    class P{reset(i){this.x=rnd(0,cv.width);this.y=i?rnd(0,cv.height):cv.height+10;this.r=rnd(1,3.5);this.vx=rnd(-.2,.2);this.vy=rnd(-.3,-.8);this.a=rnd(.15,.5);this.p=rnd(0,Math.PI*2);this.ps=rnd(.01,.03);this.g=rnd(6,18);}constructor(){this.reset(true);}tick(){this.x+=this.vx;this.y+=this.vy;this.p+=this.ps;this.ca=this.a*(.5+.5*Math.sin(this.p));if(this.y<-20||this.x<-20||this.x>cv.width+20)this.reset(false);}draw(){ctx.save();const g=ctx.createRadialGradient(this.x,this.y,0,this.x,this.y,this.g+this.r);g.addColorStop(0,\`rgba(220,38,38,\${this.ca})\`);g.addColorStop(1,'rgba(220,38,38,0)');ctx.beginPath();ctx.arc(this.x,this.y,this.g+this.r,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();ctx.beginPath();ctx.arc(this.x,this.y,this.r,0,Math.PI*2);ctx.fillStyle=\`rgba(255,90,90,\${Math.min(this.ca*1.6,1)})\`;ctx.shadowColor='#dc2626';ctx.shadowBlur=10;ctx.fill();ctx.restore();}}
    const pts=Array.from({length:35},()=>new P());
    const bl=[{x:.1,y:.15,r:250,sp:.0003,ph:0},{x:.9,y:.85,r:200,sp:.0004,ph:2},{x:.5,y:.4,r:160,sp:.00025,ph:4}];
    function dbl(t){bl.forEach(b=>{const cx=(b.x+.06*Math.sin(t*b.sp*1000+b.ph))*cv.width,cy=(b.y+.05*Math.cos(t*b.sp*1000+b.ph))*cv.height;const g=ctx.createRadialGradient(cx,cy,0,cx,cy,b.r);g.addColorStop(0,'rgba(180,20,20,0.05)');g.addColorStop(1,'rgba(180,20,20,0)');ctx.beginPath();ctx.arc(cx,cy,b.r,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();});}
    function loop(t){ctx.clearRect(0,0,cv.width,cv.height);dbl(t);pts.forEach(p=>{p.tick();p.draw();});requestAnimationFrame(loop);}requestAnimationFrame(loop);
    ${!isConnected ? 'setTimeout(()=>location.reload(),30000);' : ''}
  </script>
</body></html>`);
});

// Remove the old /qr/raw route since the external API handles it perfectly now.




// âœ… Route to aggressively clear session and restart â€” ADMIN ONLY
app.post('/qr/reset', verifyAdminOrLocal, async (req, res) => {
  try {
    // Attempt graceful shutdown
    if (whatsappService.sock) {
      whatsappService.sock.end();
      whatsappService.sock = null;
    }
    whatsappService.isReady = false;
    whatsappService.lastQR = null;
    whatsappService.pairingCode = null;

    // Hard delete from DB using the shared Supabase client.
    const { supabase } = require('./services/supabase');
    await supabase.from('whatsapp_sessions').delete().like('id', `${whatsappService.sessionId}:%`);

    // Reinitialize
    setTimeout(() => whatsappService.initialize(), 2000);

    res.send('<script>alert("تم مسح الجلسة القديمة! سيتم تحويلك لصفحة الربط وتوليد باركود جديد الآن."); window.location.href="/qr";</script>');
  } catch (err) {
    logger.error('QR reset error:', err);
    res.status(500).send('Error resetting session.');
  }
});


app.get('/', (req, res) => {
  const whatsappStatus = whatsappService.getStatus();
  
  res.status(200).json({
    status: 'online',
    server: 'ok',
    whatsapp: whatsappStatus,
    timestamp: new Date().toISOString()
  });
});

// âœ… New Centralized Error Handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
let oauthCleanupInterval;

const server = app.listen(PORT, async () => {
  logger.info(`âœ… Server running on port ${PORT}`);
  if (!process.env.QR_ADMIN_PASSWORD) {
    logger.warn('âš ï¸ QR_ADMIN_PASSWORD is not set â€” the WhatsApp QR pairing page (/qr) is DISABLED for browser access.');
  }
  
  try {
    // âœ… Load Global Development Mode Setting on Boot
    const { data: settingsData } = await supabase.from('system_settings').select('*');
    if (settingsData) {
      const devModeSetting = settingsData.find(s => s.key === 'dev_mode_enabled');
      if (devModeSetting && devModeSetting.value === 'true') {
        global.DEV_MODE_ENABLED = true;
        logger.level = 'debug';
        logger.info('âš ï¸  Global Development Mode is ENABLED. Internal caching and CDN caching are disabled.');
      } else {
        global.DEV_MODE_ENABLED = false;
        logger.level = 'info';
      }
    }

    // Feature Flag Check
    if (process.env.ENABLE_WHATSAPP === 'true') {
      await whatsappService.initialize();
      notificationWorker.start(); // ðŸŸ¢ Start polling the queue
    } else {
      logger.warn('âš ï¸ WhatsApp service is disabled by feature flag.');
    }
  } catch (err) {
    logger.error('Failed to initialize WhatsApp service:', err);
  }

  // Start operational health collector
  healthCollector.startCollector();

  // Start custom domain validation cron
  domainValidator.startDomainCheckCron();
  
  // Start stale subscription limit reservations cleanup
  const staleReservationCleanup = require('./services/staleReservationCleanup');
  staleReservationCleanup.startCleanupJob();

  // Start payment proof retention cleanup (deletes R2 images per store retention policy)
  const { startProofRetentionJob } = require('./services/proofRetentionJob');
  startProofRetentionJob();


  // Periodic cleanup of expired oauth exchanges (every 10 minutes)
  oauthCleanupInterval = setInterval(async () => {
    try {
      healthCollector.registerCronRun();
      const { supabase: dbInstance } = require('./services/supabase');
      const { error } = await dbInstance.rpc('cleanup_expired_oauth_exchanges');
      if (error) {
        // Fallback to manual delete if RPC is not declared
        await dbInstance.from('oauth_exchanges').delete().lt('expires_at', new Date().toISOString());
      }
    } catch (err) {
      logger.error('Background cleanup of expired oauth exchanges failed:', err);
    }
  }, 10 * 60 * 1000);
});

// âœ… Graceful Shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  healthCollector.stopCollector();
  domainValidator.stopDomainCheckCron();

  if (oauthCleanupInterval) {
    clearInterval(oauthCleanupInterval);
  }
  
  server.close(async () => {
    logger.info('HTTP server closed.');
    
    try {
      await whatsappService.shutdown();
      notificationWorker.stop(); // ðŸ›‘ Stop polling
      logger.info('WhatsApp connection closed.');
    } catch (err) {
      logger.error('Error during WhatsApp shutdown:', err);
    }
    
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down.');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
