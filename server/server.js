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

const app = express();


// ✅ Ensure Express trusts Render's proxy for Rate Limiting
app.set('trust proxy', 1);

const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const authRoutes = require('./routes/auth');
const blockedRoutes = require('./routes/blocked');
const whatsappService = require('./services/whatsappService');
const notificationWorker = require('./services/notificationWorker');
const path = require('path');

// ✅ 1. Startup Validation: Ensure critical ENV vars exist
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'FRONTEND_URL',
  'PORT',
  'DATABASE_ENCRYPTION_KEY'
];

const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`\n❌ FATAL ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please check your .env file or deployment settings.\n');
  process.exit(1);
}

// Validate byte length and uniqueness of all configured DATABASE_ENCRYPTION_KEY keys
const keyValues = new Set();
for (const key of Object.keys(process.env)) {
  if (key === 'DATABASE_ENCRYPTION_KEY' || key.startsWith('DATABASE_ENCRYPTION_KEY_V')) {
    const val = process.env[key];
    if (!val || !val.trim() || Buffer.byteLength(val, 'utf8') < 32) {
      console.error(`\n❌ FATAL ERROR: ${key} must be configured, not empty or whitespace, and at least 32 bytes long.\n`);
      process.exit(1);
    }
    if (keyValues.has(val)) {
      console.warn(`\n⚠️ WARNING: Duplicate encryption key value detected in ${key}. While allowed for key transition, this is discouraged in production.\n`);
    }
    keyValues.add(val);
  }
}

// ✅ Assign Unique Request ID & Logging
app.use((req, res, next) => {
  req.id = uuidv4();
  logger.info(`${req.method} ${req.url}`, { requestId: req.id });
  next();
});

// ✅ CORS — Allow only configured frontend URL(s), subdomains, Vercel preview apps, and localhost
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:5174',
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    let isAllowed = false;
    if (ALLOWED_ORIGINS.includes(origin)) {
      isAllowed = true;
    } else {
      try {
        const parsedUrl = new URL(origin);
        const hostname = parsedUrl.hostname;
        
        // 1. Local development
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
          isAllowed = true;
        }
        // 2. Main domain and tenant subdomains
        else if (
          hostname === 'egparts.gt.tc' || hostname.endsWith('.egparts.gt.tc') ||
          hostname === 'egparts.store' || hostname.endsWith('.egparts.store')
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
        if (process.env.FRONTEND_URL) {
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
      } catch (err) {
        // Invalid origin format
      }
    }

    if (isAllowed) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }
  }
  
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, X-Store-Subdomain, X-Original-Host, X-Impersonate-Session');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(helmet());

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


// ✅ Blocked IP check route (Must bypass IP blocking checks so blocked users can verify their status)
app.use('/api/blocked', tenantResolver, blockedRoutes);

// ===================================================================
// Bypass Endpoints — MUST be before tenantResolver
// ===================================================================

// Store Context — resolves store by subdomain (frontend StoreContext.jsx calls this)
app.get('/api/store-context', async (req, res) => {
  try {
    const subdomain = (req.headers['x-store-subdomain'] || '').toLowerCase().trim();
    if (!subdomain) {
      return res.status(400).json({ error: 'Missing X-Store-Subdomain header' });
    }
    const { supabase } = require('./services/supabase');
    const { data: store, error } = await supabase
      .from('stores')
      .select('id, name, subdomain, custom_domain, is_active, subscription_expires_at, status, created_at, updated_at')
      .eq('subdomain', subdomain)
      .single();
    if (error || !store) {
      return res.status(404).json({ error: 'Store not found' });
    }
    res.json(store);
  } catch (err) {
    console.error('Store context error:', err);
    res.status(500).json({ error: 'Failed to load store context' });
  }
});

// Admin Validation — checks admin permissions via Supabase JWT
app.post('/api/auth/validate-admin', async (req, res) => {
  try {
    const { store_id } = req.body || {};
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ isAuthorized: false, error: 'No auth token provided' });
    }
    const { supabase } = require('./services/supabase');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ isAuthorized: false, error: 'Invalid or expired token' });
    }
    // Super admin check (no store_id = platform admin)
    if (!store_id) {
      const { data: sa } = await supabase
        .from('super_admins')
        .select('user_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (sa) {
        return res.json({ isAuthorized: true, isSuperAdmin: true, role: 'super_admin' });
      }
      return res.status(403).json({ isAuthorized: false, error: 'Not a super admin' });
    }
    // Store admin check
    const { data: admin } = await supabase
      .from('store_admins')
      .select('user_id, store_id')
      .eq('user_id', user.id)
      .eq('store_id', store_id)
      .maybeSingle();
    if (admin) {
      return res.json({ isAuthorized: true, isSuperAdmin: false, role: 'store_admin' });
    }
    // Super admins have access to all stores
    const { data: isSuper } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (isSuper) {
      return res.json({ isAuthorized: true, isSuperAdmin: true, role: 'super_admin' });
    }
    return res.status(403).json({ isAuthorized: false, error: 'No admin access for this store' });
  } catch (err) {
    console.error('Admin validation error:', err);
    res.status(500).json({ isAuthorized: false, error: 'Validation failed' });
  }
});

// Invitation verification (before tenantResolver — no store context needed)
app.get('/api/auth/invitation/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const { supabase } = require('./services/supabase');
    const { data: invitation, error } = await supabase
      .from('store_admin_invitations')
      .select('*, store:stores(id, name, subdomain)')
      .eq('token', token)
      .eq('accepted', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    res.json({
      valid: true,
      store: invitation.store,
      email: invitation.email,
      role: invitation.role
    });
  } catch (err) {
    console.error('Invitation verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/auth/invitation/accept', async (req, res) => {
  try {
    const { token, user_id } = req.body;
    if (!token || !user_id) return res.status(400).json({ error: 'Missing token or user_id' });

    const { supabase } = require('./services/supabase');

    // Get invitation
    const { data: invitation, error: invErr } = await supabase
      .from('store_admin_invitations')
      .select('*')
      .eq('token', token)
      .eq('accepted', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (invErr || !invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    // Add store admin role
    const { error: adminErr } = await supabase
      .from('store_admins')
      .upsert({ user_id, store_id: invitation.store_id });

    if (adminErr) {
      return res.status(500).json({ error: 'Failed to add admin role' });
    }

    // Mark invitation as accepted
    await supabase
      .from('store_admin_invitations')
      .update({ accepted: true, accepted_at: new Date().toISOString() })
      .eq('id', invitation.id);

    res.json({ success: true, store_id: invitation.store_id });
  } catch (err) {
    console.error('Invitation accept error:', err);
    res.status(500).json({ error: 'Acceptance failed' });
  }
});

// Impersonation — super admin operates across tenants (before tenantResolver)
app.post('/api/platform/impersonate/start', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { store_id } = req.body;

    if (!token || !store_id) return res.status(400).json({ error: 'Missing token or store_id' });

    const { supabase } = require('./services/supabase');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    // Verify super admin
    const { data: sa } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!sa) return res.status(403).json({ error: 'Not a super admin' });

    // Get store info
    const { data: store } = await supabase.from('stores').select('id, name, subdomain, custom_domain').eq('id', store_id).maybeSingle();
    if (!store) return res.status(404).json({ error: 'Store not found' });

    // Create impersonation session
    const { v4: uuidv4Imp } = require('uuid');
    const session_token = uuidv4Imp();
    const { error: logErr } = await supabase.from('impersonation_logs').insert({
      super_admin_id: user.id,
      store_id,
      session_token,
      action: 'start'
    });

    res.json({ success: true, session_token, store });
  } catch (err) {
    console.error('Impersonate start error:', err);
    res.status(500).json({ error: 'Failed to start impersonation' });
  }
});

app.post('/api/platform/impersonate/stop', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { session_token } = req.body;

    if (!token) return res.status(400).json({ error: 'Missing token' });

    const { supabase } = require('./services/supabase');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    // End impersonation session
    if (session_token) {
      await supabase.from('impersonation_logs').insert({
        super_admin_id: user.id,
        session_token,
        action: 'end'
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Impersonate stop error:', err);
    res.status(500).json({ error: 'Failed to stop impersonation' });
  }
});

// Platform admin routes (cross-store, must bypass tenantResolver)
const platformAdminRoutes = require('./routes/platformAdmin');
// PUBLIC ENDPOINTS — Must be BEFORE platformAdminRoutes (which requires auth)
// These are already defined above (store-context, validate-admin, etc.)
// platformAdminRoutes only affects /platform/* paths, so /api/health, /api/store-context etc. are fine

app.use('/api', platformAdminRoutes);

// ✅ Resolve Tenant for all other API endpoints
app.use('/api/', tenantResolver);

// ✅ Blocked IPs Middleware (now scopes using req.store)
app.use('/api/', blockIPMiddleware);

// ✅ Ban Check Middleware (now scopes using req.store)
app.use('/api/', banCheckMiddleware);

// ✅ Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/', generalLimiter);

// ✅ Routes (tenant is already resolved globally above)
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/auth', authRoutes);
const storageRoutes = require('./routes/storage');
const limitsRoutes = require('./routes/limits');
const walletRoutes = require('./routes/wallet');
app.use('/api/storage', storageRoutes);
app.use('/api', limitsRoutes);
app.use('/api', walletRoutes);

// ✅ WhatsApp Auth Routes
app.post('/api/auth/qr-login', async (req, res) => {
  const { username, password, turnstileToken } = req.body;
  const { safeCompare, QR_USER, QR_PASS } = require('./middleware/qrAuth');
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'الرجاء إدخال اسم المستخدم وكلمة المرور' });
  }

  // Verify Turnstile — REQUIRED when TURNSTILE_SECRET_KEY is configured
  const secretKey = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (secretKey) {
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
        return res.status(403).json({ success: false, error: 'فشل التحقق الأمني (Turnstile) — حاول مرة أخرى' });
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

// ✅ WhatsApp QR Dashboard — ADMIN ONLY
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
        <li>الصفحة تُحدَث تلقائياً كل 30 ثانية عند عدم الاتصال</li>
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




// ✅ Route to aggressively clear session and restart — ADMIN ONLY
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

// ✅ New Centralized Error Handler
app.use(errorHandler);


// ═══════════════════════════════════════════════════════════════
// MISSING PLATFORM ENDPOINTS — Required by frontend
// ═══════════════════════════════════════════════════════════════

// Helper: verify super admin
async function verifySuperAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data: sa } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
  return sa ? user : null;
}

// GET /api/health/maintenance
app.get('/api/health/maintenance', (req, res) => {
  res.json({ maintenance: false });
});

// GET /api/store-usage
app.get('/api/store-usage', async (req, res) => {
  try {
    if (!req.store?.id) return res.json({});
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const [ordersRes, productsRes] = await Promise.all([
      supabase.from('orders').select('total', { count: 'exact' }).eq('store_id', req.store.id).gte('created_at', monthStart.toISOString()),
      supabase.from('products').select('id', { count: 'exact', head: true }).eq('store_id', req.store.id),
    ]);
    res.json({ orders_this_month: ordersRes.count || 0, products_count: productsRes.count || 0 });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/platform/stores
app.get('/api/platform/stores', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { data, error } = await supabase.from('stores')
      .select('id, name, subdomain, custom_domain, is_active, subscription_expires_at, created_at')
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: 'Failed to load stores' }); }
});

// GET /api/platform/users
app.get('/api/platform/users', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { data, error } = await supabase.from('user_profiles')
      .select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: 'Failed to load users' }); }
});

// GET /api/platform/store-admins
app.get('/api/platform/store-admins', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });

    // Auto-sync from user_roles
    try {
      const { data: ur } = await supabase.from('user_roles').select('user_id, store_id').not('store_id', 'is', null);
      if (ur?.length) await supabase.from('store_admins').upsert(ur.map(r => ({ user_id: r.user_id, store_id: r.store_id })), { onConflict: 'user_id,store_id', ignoreDuplicates: true }).catch(() => {});
    } catch (e) {}

    const { data: saData, error } = await supabase.from('store_admins').select('id, user_id, store_id, created_at');
    if (error) throw error;

    const [{ data: profiles }, { data: stores }] = await Promise.all([
      supabase.from('user_profiles').select('user_id, store_id, full_name, phone, email').catch(() => ({ data: [] })),
      supabase.from('stores').select('id, name, subdomain, is_active').neq('id', '00000000-0000-0000-0000-000000000000').catch(() => ({ data: [] })),
    ]);

    const pMap = {}; (profiles || []).forEach(p => { pMap[`${p.user_id}::${p.store_id}`] = p; });
    const sMap = {}; (stores || []).forEach(s => { sMap[s.id] = s; });

    res.json((saData || []).map(sa => {
      const p = pMap[`${sa.user_id}::${sa.store_id}`];
      const s = sMap[sa.store_id];
      return { id: sa.id, user_id: sa.user_id, store_id: sa.store_id, full_name: p?.full_name || '', phone: p?.phone || '', email: p?.email || '', store_name: s?.name || '', store_subdomain: s?.subdomain || '', store_active: s?.is_active ?? true, is_owner: false, created_at: sa.created_at };
    }));
  } catch (e) { res.status(500).json({ error: 'Failed to load store admins' }); }
});

// POST /api/platform/invitations
app.post('/api/platform/invitations', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { phone, store_id } = req.body;
    if (!phone || !store_id) return res.status(400).json({ error: 'phone and store_id required' });
    const cleanPhone = phone.replace(/[\s\+\-]/g, '');
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const waPhone = cleanPhone.startsWith('2') ? cleanPhone : '2' + cleanPhone;
    const { data: invitation, error } = await supabase.from('tenant_invitations').insert([{ phone: waPhone, store_id, token, status: 'pending', expires_at: new Date(Date.now() + 48*60*60*1000).toISOString(), invited_by: user.id, created_ip: req.ip }]).select().single();
    if (error) throw error;
    try { await whatsappService.sendMessage(waPhone, `مرحباً!\n\nتمت دعوتك لتكون مدير متجر على منصة EG-PARTS Cloud.\n\n🔗 ${process.env.FRONTEND_URL || 'https://egparts.store'}/accept-invitation?token=${token}\n\n⏰ صلاحية الرابط: 48 ساعة.`); } catch (e) {}
    res.json({ success: true, invitation });
  } catch (e) { res.status(500).json({ error: 'Failed: ' + e.message }); }
});

// GET /api/platform/invitations
app.get('/api/platform/invitations', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { data, error } = await supabase.from('tenant_invitations').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/platform/audit-logs
app.get('/api/platform/audit-logs', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/platform/plans
app.get('/api/platform/plans', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { data, error } = await supabase.from('plans').select('*').order('sort_order', { ascending: true });
    if (error) { const { data: fb } = await supabase.from('plans').select('*').order('created_at', { ascending: true }); return res.json(fb || []); }
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/platform/settings
app.get('/api/platform/settings', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { data, error } = await supabase.from('system_settings').select('*');
    if (error) return res.json({ maintenance_mode: 'false', allow_store_registration: 'true' });
    const settings = {}; (data || []).forEach(item => { settings[item.key] = item.value; });
    res.json(settings);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/platform/tenants/metrics
app.get('/api/platform/tenants/metrics', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { data: stores, error } = await supabase.from('stores')
      .select('id, name, subdomain, custom_domain, is_active, subscription_expires_at, created_at')
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const metrics = [];
    for (const store of stores || []) {
      const [ordersRes, productsRes] = await Promise.all([
        supabase.from('orders').select('total', { count: 'exact' }).eq('store_id', store.id).gte('created_at', monthStart.toISOString()),
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('store_id', store.id),
      ]);
      let plan = null;
      try { const { data: sub } = await supabase.from('store_subscriptions').select('plan_id, plans(id, code, display_name)').eq('store_id', store.id).order('created_at', { ascending: false }).limit(1).maybeSingle(); if (sub?.plans) plan = sub.plans; } catch (e) {}
      metrics.push({ ...store, orders_this_month: ordersRes.count || 0, products_count: productsRes.count || 0, sales_this_month: (ordersRes.data || []).reduce((s, o) => s + Number(o.total || 0), 0), plan, plan_id: null, subscription_status: null });
    }
    res.json(metrics);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/db-proxy
app.post('/api/db-proxy', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    if (!req.store?.id) return res.status(400).json({ error: 'Tenant context required' });

    const ALLOWED_TABLES = new Set(['products','banners','coupons','categories','site_settings','shipping_zones','user_profiles','user_addresses','reviews','wishlists','orders','stores','user_notifications']);
    const { table, action, payload, match } = req.body;
    if (!table || !action) return res.status(400).json({ error: 'Table and action required' });
    if (!ALLOWED_TABLES.has(table)) return res.status(403).json({ error: 'Table not allowed' });
    if (!['insert','update','delete','upsert'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const PROTECTED = ['id','created_at','updated_at','deleted_at'];
    const strip = (obj) => { if (!obj || typeof obj !== 'object') return obj; const c = {...obj}; PROTECTED.forEach(f => delete c[f]); return c; };
    let finalPayload = Array.isArray(payload) ? payload.map(strip) : strip(payload);
    if ((action === 'insert' || action === 'upsert') && table !== 'stores') {
      if (Array.isArray(finalPayload)) finalPayload = finalPayload.map(i => ({...i, store_id: req.store.id}));
      else if (finalPayload) finalPayload = {...finalPayload, store_id: req.store.id};
    }
    if (action === 'update' && finalPayload && !Array.isArray(finalPayload)) delete finalPayload.store_id;
    let query = supabase.from(table)[action](finalPayload);
    if (action === 'update' || action === 'delete') {
      const scopeCol = table === 'stores' ? 'id' : 'store_id';
      query = query.eq(scopeCol, req.store.id);
      if (match) for (const [k,v] of Object.entries(match)) if (k !== 'store_id') query = query.eq(k, v);
    }
    if (action !== 'delete') query = query.select();
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: 'Internal server error' }); }
});

// GET /api/payments/status/:orderId
app.get('/api/payments/status/:orderId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    const { orderId } = req.params;
    const { data: order, error } = await supabase.from('orders').select('id, payment_status, status, total, paymob_order_id, paymob_transaction_id').eq('id', orderId).maybeSingle();
    if (error || !order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order_id: order.id, payment_status: order.payment_status, order_status: order.status, amount: order.total, paymob_order_id: order.paymob_order_id, transaction_id: order.paymob_transaction_id });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/payments/active
app.get('/api/payments/active', async (req, res) => {
  try {
    if (!req.store?.id) return res.json([]);
    const { data: gateways } = await supabase.from('store_payment_gateways').select('provider_name, is_active').eq('store_id', req.store.id);
    const active = (gateways || []).filter(g => g.is_active).map(g => g.provider_name);
    res.json(active);
  } catch (e) { res.json([]); }
});

// GET /api/blocked/check
app.get('/api/blocked/check', (req, res) => {
  res.json({ blocked: false });
});



// POST /api/platform/impersonation/session — Get impersonated store
app.post('/api/platform/impersonation/session', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { data: superAdmin } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!superAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { token: impToken } = req.body;
    if (!impToken) return res.status(400).json({ error: 'Token required' });

    // Look up impersonation session
    const { data: session, error } = await supabase
      .from('impersonation_sessions')
      .select('*, stores(id, name, subdomain, custom_domain, is_active, subscription_expires_at)')
      .eq('session_token', impToken)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !session) return res.status(404).json({ error: 'Session not found' });

    // Check expiry
    if (new Date(session.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Session expired' });
    }

    res.json({ store: session.stores, session });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/platform/stores/:id/suspend
app.post('/api/platform/stores/:id/suspend', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const { data, error } = await supabase.from('stores').update({ is_active: false }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, store: data });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/platform/stores/:id/recover
app.post('/api/platform/stores/:id/recover', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const { data, error } = await supabase.from('stores').update({ is_active: true }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, store: data });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/platform/users/:userId/ban
app.post('/api/platform/users/:userId/ban', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { userId } = req.params;
    const { reason, scope, store_id } = req.body;
    const { data: profile } = await supabase.from('user_profiles').select('id').eq('user_id', userId).eq('store_id', store_id).maybeSingle();
    if (profile) {
      await supabase.from('user_profiles').update({ is_banned: true, ban_reason: reason || 'مخالفة' }).eq('id', profile.id);
      await supabase.from('ban_logs').insert([{ user_id: userId, store_id, ban_scope: scope || 'ALL', ban_type: 'Custom', reason: reason || 'مخالفة', created_by: user.id }]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/platform/users/:userId/unban
app.post('/api/platform/users/:userId/unban', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });
    const { userId } = req.params;
    const { store_id } = req.body;
    await supabase.from('user_profiles').update({ is_banned: false, ban_reason: null }).eq('user_id', userId).eq('store_id', store_id);
    await supabase.from('ban_logs').update({ is_active: false, lifted_at: new Date().toISOString(), lifted_by: user.id }).eq('user_id', userId).eq('store_id', store_id).eq('is_active', true);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/platform/resources/:resource — Generic resource lister
app.get('/api/platform/resources/:resource', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });

    const resourceMap = {
      feature_flags: 'feature_flags',
      apps: 'platform_apps',
      themes: 'platform_themes',
      role_templates: 'platform_role_templates',
      suspensions: 'platform_suspensions',
    };
    const table = resourceMap[req.params.resource];
    if (!table) return res.status(404).json({ error: 'Unknown resource' });

    const { data, error } = await supabase.from(table).select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/platform/store-admins/sync-from-roles
app.post('/api/platform/store-admins/sync-from-roles', async (req, res) => {
  try {
    const user = await verifySuperAdmin(req);
    if (!user) return res.status(403).json({ error: 'Forbidden' });

    let added = 0;
    const { data: userRoles } = await supabase.from('user_roles').select('user_id, store_id').not('store_id', 'is', null);
    for (const ur of userRoles || []) {
      const { error: insErr } = await supabase.from('store_admins').upsert([{ user_id: ur.user_id, store_id: ur.store_id }], { onConflict: 'user_id,store_id', ignoreDuplicates: true });
      if (!insErr) added++;
    }
    res.json({ success: true, synced: added, total: (userRoles || []).length });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/logs/client-error — Accept client error logs
app.post('/api/logs/client-error', async (req, res) => {
  // Just accept and discard (no DB write to avoid failures)
  res.json({ success: true });
});


const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, async () => {
  logger.info(`✅ Server running on port ${PORT}`);
  if (!process.env.QR_ADMIN_PASSWORD) {
    logger.warn('⚠️ QR_ADMIN_PASSWORD is not set — the WhatsApp QR pairing page (/qr) is DISABLED for browser access.');
  }
  
  try {
    // Feature Flag Check
    if (process.env.ENABLE_WHATSAPP === 'true') {
      await whatsappService.initialize();
      notificationWorker.start(); // 🟢 Start polling the queue
    } else {
      logger.warn('⚠️ WhatsApp service is disabled by feature flag.');
    }
  } catch (err) {
    logger.error('Failed to initialize WhatsApp service:', err);
  }
});

// ✅ Graceful Shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  
  server.close(async () => {
    logger.info('HTTP server closed.');
    
    try {
      await whatsappService.shutdown();
      notificationWorker.stop(); // 🛑 Stop polling
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
