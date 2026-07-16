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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
  
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
app.use('/api/storage', storageRoutes);

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
// CRITICAL MISSING ENDPOINTS — Added to fix broken frontend
// ═══════════════════════════════════════════════════════════════

// 1. GET /api/store-context — Resolve store from subdomain
app.get('/api/store-context', async (req, res) => {
  try {
    const subdomain = req.headers['x-store-subdomain'] || req.query.store_subdomain;
    if (!subdomain) return res.status(400).json({ error: 'Subdomain required' });

    const { data: store, error } = await supabase
      .from('stores')
      .select('*')
      .or(`subdomain.eq.${subdomain},custom_domain.eq.${subdomain}`)
      .maybeSingle();

    if (error || !store) return res.status(404).json({ error: 'Store not found' });
    res.json(store);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load store context' });
  }
});

// 2. GET /api/store-usage — Store usage stats
app.get('/api/store-usage', async (req, res) => {
  try {
    if (!req.store?.id) return res.json({});
    const storeId = req.store.id;
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);

    const [ordersRes, productsRes] = await Promise.all([
      supabase.from('orders').select('total', { count: 'exact' }).eq('store_id', storeId).gte('created_at', monthStart.toISOString()),
      supabase.from('products').select('id', { count: 'exact', head: true }).eq('store_id', storeId),
    ]);

    res.json({
      orders_this_month: ordersRes.count || 0,
      products_count: productsRes.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// 3. POST /api/auth/validate-admin — Validate admin access (bypasses RLS)
app.post('/api/auth/validate-admin', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const { store_id } = req.body || {};
  const token = authHeader.split(' ')[1];

  try {
    // Use Supabase auth.getUser() to verify token
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const userId = user.id;

    // Check super_admins
    const { data: superAdmin } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (superAdmin) {
      return res.json({ success: true, isSuperAdmin: true, isStoreAdmin: true, isAuthorized: true, store_id: store_id || null });
    }

    // Check store_admins
    let storeAdmin = null;
    let resolvedStoreId = store_id;

    if (store_id) {
      const { data: sa } = await supabase
        .from('store_admins')
        .select('id, store_id')
        .eq('user_id', userId)
        .eq('store_id', store_id)
        .maybeSingle();
      storeAdmin = sa;
    }

    if (!storeAdmin) {
      const { data: saAny } = await supabase
        .from('store_admins')
        .select('id, store_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
      storeAdmin = saAny;
      if (saAny?.store_id) resolvedStoreId = saAny.store_id;
    }

    // Fallback: check user_roles
    if (!storeAdmin) {
      let userRole = null;
      if (store_id) {
        const { data: ur } = await supabase
          .from('user_roles')
          .select('id, store_id')
          .eq('user_id', userId)
          .eq('store_id', store_id)
          .maybeSingle();
        userRole = ur;
      }
      if (!userRole) {
        const { data: urAny } = await supabase
          .from('user_roles')
          .select('id, store_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();
        userRole = urAny;
        if (urAny?.store_id) resolvedStoreId = urAny.store_id;
      }

      if (userRole) {
        // Self-heal: create store_admins entry
        const targetStoreId = store_id || userRole.store_id;
        if (targetStoreId) {
          await supabase.from('store_admins').insert([{ user_id: userId, store_id: targetStoreId }]).catch(() => {});
          storeAdmin = { id: 'auto-created', store_id: targetStoreId };
          resolvedStoreId = targetStoreId;
        }
      }
    }

    res.json({
      success: true,
      isSuperAdmin: !!superAdmin,
      isStoreAdmin: !!storeAdmin,
      isAuthorized: !!(superAdmin || storeAdmin),
      store_id: resolvedStoreId || null
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// 4. GET /api/platform/stores — List all stores (super admin)
app.get('/api/platform/stores', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { data: superAdmin } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!superAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { data: stores, error } = await supabase
      .from('stores')
      .select('id, name, subdomain, custom_domain, is_active, subscription_expires_at, created_at')
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(stores || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stores' });
  }
});

// 5. GET /api/platform/users — List all users (super admin)
app.get('/api/platform/users', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { data: superAdmin } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!superAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;
    res.json(profiles || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// 6. GET /api/platform/store-admins — List store admins (super admin)
app.get('/api/platform/store-admins', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { data: superAdmin } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!superAdmin) return res.status(403).json({ error: 'Forbidden' });

    // Auto-sync from user_roles
    try {
      const { data: userRoles } = await supabase
        .from('user_roles')
        .select('user_id, store_id')
        .not('store_id', 'is', null);
      if (userRoles?.length > 0) {
        const entries = userRoles.map(ur => ({ user_id: ur.user_id, store_id: ur.store_id }));
        await supabase.from('store_admins').upsert(entries, { onConflict: 'user_id,store_id', ignoreDuplicates: true }).catch(() => {});
      }
    } catch (e) {}

    const { data: saData, error } = await supabase
      .from('store_admins')
      .select('id, user_id, store_id, created_at');

    if (error) throw error;

    // Get profiles for names
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('user_id, store_id, full_name, phone, email')
      .catch(() => ({ data: [] }));

    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[`${p.user_id}::${p.store_id}`] = p; });

    // Get stores
    const { data: stores } = await supabase
      .from('stores')
      .select('id, name, subdomain, is_active')
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .catch(() => ({ data: [] }));

    const storeMap = {};
    (stores || []).forEach(s => { storeMap[s.id] = s; });

    const results = (saData || []).map(sa => {
      const profile = profileMap[`${sa.user_id}::${sa.store_id}`];
      const store = storeMap[sa.store_id];
      return {
        id: sa.id,
        user_id: sa.user_id,
        store_id: sa.store_id,
        full_name: profile?.full_name || '',
        phone: profile?.phone || '',
        email: profile?.email || '',
        store_name: store?.name || '',
        store_subdomain: store?.subdomain || '',
        store_active: store?.is_active ?? true,
        is_owner: false,
        created_at: sa.created_at
      };
    });

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load store admins' });
  }
});

// 7. POST /api/platform/invitations — Create invitation (super admin)
app.post('/api/platform/invitations', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { data: superAdmin } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!superAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { phone, store_id } = req.body;
    if (!phone || !store_id) return res.status(400).json({ error: 'phone and store_id required' });

    const cleanPhone = phone.replace(/[\s\+\-]/g, '');
    const crypto = require('crypto');
    const invitationToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const whatsappPhone = cleanPhone.startsWith('2') ? cleanPhone : '2' + cleanPhone;

    const { data: invitation, error } = await supabase
      .from('tenant_invitations')
      .insert([{
        phone: whatsappPhone,
        store_id,
        token: invitationToken,
        status: 'pending',
        expires_at: expiresAt,
        invited_by: user.id,
        created_ip: req.ip
      }])
      .select()
      .single();

    if (error) throw error;

    // Try to send via WhatsApp
    const frontendUrl = process.env.FRONTEND_URL || 'https://egparts.store';
    const activationLink = `${frontendUrl}/accept-invitation?token=${invitationToken}`;
    try {
      const message = `مرحباً!\n\nتمت دعوتك لتكون مدير متجر على منصة EG-PARTS Cloud.\n\n🔗 اضغط على الرابط التالي لتفعيل حسابك:\n${activationLink}\n\n⏰ صلاحية الرابط: 48 ساعة.`;
      await whatsappService.sendMessage(whatsappPhone, message);
    } catch (waErr) {
      // Still return success — admin can copy the link
    }

    res.json({ success: true, invitation });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create invitation: ' + err.message });
  }
});

// 8. GET /api/platform/invitations — List invitations (super admin)
app.get('/api/platform/invitations', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { data: superAdmin } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!superAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { data: invitations, error } = await supabase
      .from('tenant_invitations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(invitations || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invitations' });
  }
});

// 9. GET /api/platform/audit-logs — List audit logs (super admin)
app.get('/api/platform/audit-logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { data: superAdmin } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!superAdmin) return res.status(403).json({ error: 'Forbidden' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { data: logs, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(logs || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

// 10. POST /api/db-proxy — Generic mutation proxy (bypasses RLS)
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
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 11. GET /api/health/maintenance — Maintenance mode check
app.get('/api/health/maintenance', (req, res) => {
  res.json({ maintenance: false });
});

// 12. GET /api/payments/status/:orderId — Payment status polling
app.get('/api/payments/status/:orderId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    const { orderId } = req.params;
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, payment_status, status, total, paymob_order_id, paymob_transaction_id')
      .eq('id', orderId)
      .maybeSingle();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });
    res.json({
      order_id: order.id,
      payment_status: order.payment_status,
      order_status: order.status,
      amount: order.total,
      paymob_order_id: order.paymob_order_id,
      transaction_id: order.paymob_transaction_id
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
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
