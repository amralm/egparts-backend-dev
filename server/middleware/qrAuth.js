const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const QR_USER = (process.env.QR_ADMIN_USERNAME || 'admin').trim();
const QR_PASS = (process.env.QR_ADMIN_PASSWORD || '').trim();
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '0x4AAAAAADF4VfOFuztpzj9u';

const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
};

const isLoopback = (req) => {
  const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
};

const checkAuth = (req) => {
  if (isLoopback(req)) return true;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], SUPABASE_JWT_SECRET);
      if (decoded?.app_metadata?.role === 'admin' || decoded?.role === 'qr_admin') return true;
    } catch {}
  }
  const cookieToken = req.cookies?.qr_admin_token;
  if (cookieToken) {
    try {
      const decoded = jwt.verify(cookieToken, SUPABASE_JWT_SECRET);
      if (decoded?.role === 'qr_admin' || decoded?.app_metadata?.role === 'admin') return true;
    } catch {}
  }
  return false;
};

// ─────────────────────────────────────────────────────────
//  LOGIN PAGE — Ultra-premium dark design with animated red particles
// ─────────────────────────────────────────────────────────
const LOGIN_PAGE_HTML = (siteKey) => `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>دخول المشرف — EG-PARTS</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&display=swap" rel="stylesheet">
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --red: #dc2626; --red-glow: rgba(220,38,38,0.6); --red-soft: rgba(220,38,38,0.14);
      --card: rgba(14,14,18,0.88); --border: rgba(255,255,255,0.06);
      --text: #f4f4f5; --muted: #52525b;
    }
    html, body { height: 100%; font-family: 'Cairo', system-ui, sans-serif; background: #050507; color: var(--text); overflow: hidden; }
    #canvas { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
    .grid { position: fixed; inset: 0; z-index: 1; pointer-events: none;
      background-image: linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
      background-size: 55px 55px; }
    .vig { position: fixed; inset: 0; z-index: 2; pointer-events: none;
      background: radial-gradient(ellipse 80% 80% at 50% 50%, transparent 35%, rgba(5,5,7,0.9) 100%); }
    .page { position: relative; z-index: 10; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .card {
      width: 100%; max-width: 430px;
      background: var(--card); backdrop-filter: blur(36px); -webkit-backdrop-filter: blur(36px);
      border: 1px solid var(--border); border-radius: 28px; padding: 3rem 2.5rem 2.5rem;
      position: relative;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.03), 0 32px 64px -16px rgba(0,0,0,0.95), 0 0 90px -24px var(--red-soft);
    }
    .card::before { content:''; position:absolute; top:0; left:15%; right:15%; height:1px;
      background: linear-gradient(90deg, transparent, var(--red-glow), transparent); }
    .logo-area { text-align: center; margin-bottom: 2.5rem; }
    .logo-mark { width:56px; height:56px; margin:0 auto 1rem; border-radius:16px;
      background: var(--red-soft); border: 1px solid rgba(220,38,38,0.25); display:flex; align-items:center; justify-content:center;
      box-shadow: 0 0 40px var(--red-soft), inset 0 1px 0 rgba(255,255,255,0.05); }
    .logo-mark svg { width:26px; height:26px; stroke: var(--red); }
    .brand { font-size:1.6rem; font-weight:900; letter-spacing:-0.5px; }
    .brand-accent { color: var(--red); }
    .tagline { font-size:0.7rem; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.12em; margin-top:0.5rem; }
    .field { margin-bottom:1.2rem; }
    .label { display:block; font-size:0.68rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:0.45rem; }
    .input-wrap { position:relative; }
    .input-icon { position:absolute; left:1rem; top:50%; transform:translateY(-50%); color:var(--muted); display:flex; align-items:center; pointer-events:none; }
    .input-icon svg { width:16px; height:16px; }
    .input { width:100%; background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.07); border-radius:14px;
      padding:.9rem 1rem .9rem 3rem; color:var(--text); font-family:'Cairo',sans-serif; font-size:.95rem; direction:ltr; outline:none;
      transition: border-color .25s, box-shadow .25s, background .25s; }
    .input:focus { border-color:rgba(220,38,38,.45); background:rgba(0,0,0,.7); box-shadow: 0 0 0 3px rgba(220,38,38,.08); }
    .input::placeholder { color:#3f3f46; }
    .input:-webkit-autofill, .input:-webkit-autofill:focus { -webkit-box-shadow:0 0 0 40px #0d0d10 inset!important; -webkit-text-fill-color:#f4f4f5!important; }
    .ts-wrap { display:flex; justify-content:center; margin:1.4rem 0; min-height:65px; align-items:center; }
    .btn { width:100%; padding:1rem; background:linear-gradient(135deg,#dc2626,#991b1b); color:#fff;
      font-family:'Cairo',sans-serif; font-size:.98rem; font-weight:800; border:none; border-radius:14px; cursor:pointer;
      display:flex; align-items:center; justify-content:center; gap:.6rem;
      transition: all .3s cubic-bezier(.34,1.56,.64,1); position:relative; overflow:hidden;
      box-shadow: 0 4px 25px rgba(220,38,38,.35); }
    .btn::before { content:''; position:absolute; top:0; left:-100%; width:100%; height:100%;
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent); transition:left .5s; }
    .btn:hover { transform:translateY(-2px); box-shadow:0 8px 35px rgba(220,38,38,.5); }
    .btn:hover::before { left:100%; }
    .btn:active { transform:translateY(0); }
    .btn:disabled { opacity:.55; cursor:not-allowed; transform:none; }
    .error-box { display:none; background:rgba(239,68,68,.08); border:1px solid rgba(239,68,68,.2); border-radius:12px;
      padding:.8rem 1rem; color:#f87171; font-size:.82rem; font-weight:700; text-align:center; margin-bottom:1.2rem; }
    .spinner { width:18px; height:18px; border:2px solid rgba(255,255,255,.25); border-top-color:#fff;
      border-radius:50%; animation:spin .65s linear infinite; flex-shrink:0; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .footer { display:flex; align-items:center; justify-content:center; gap:.5rem; margin-top:1.5rem; color:#3f3f46; font-size:.7rem; font-weight:600; }
    .footer svg { width:11px; height:11px; }
  </style>
</head>
<body>
  <canvas id="canvas"></canvas>
  <div class="grid"></div>
  <div class="vig"></div>
  <div class="page">
    <div class="card">
      <div class="logo-area">
        <div class="logo-mark">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div class="brand">EG<span class="brand-accent">-</span>PARTS</div>
        <div class="tagline">بوابة ربط واتساب — وصول المشرف</div>
      </div>
      <div class="error-box" id="errorBox"></div>
      <form id="loginForm" autocomplete="on">
        <div class="field">
          <label class="label" for="username">اسم المستخدم</label>
          <div class="input-wrap">
            <span class="input-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
            </span>
            <input class="input" type="text" id="username" name="username" autocomplete="username" required placeholder="admin">
          </div>
        </div>
        <div class="field">
          <label class="label" for="password">كلمة المرور</label>
          <div class="input-wrap">
            <span class="input-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </span>
            <input class="input" type="password" id="password" name="password" autocomplete="current-password" required placeholder="••••••••••••">
          </div>
        </div>
        <div class="ts-wrap">
          <div class="cf-turnstile" data-sitekey="${siteKey}" data-theme="dark" data-language="ar"></div>
        </div>
        <button type="submit" class="btn" id="submitBtn">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
          </svg>
          <span>دخول لوحة الواتساب</span>
        </button>
      </form>
      <div class="footer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        محمية بـ Cloudflare · اتصال مشفر
      </div>
    </div>
  </div>
  <script>
    // ── Animated red glowing particles ──
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
    resize(); addEventListener('resize', resize);
    const rand = (a,b) => Math.random()*(b-a)+a;
    class P {
      reset(init) {
        this.x = rand(0, canvas.width); this.y = init ? rand(0, canvas.height) : canvas.height + 10;
        this.r = rand(1.5, 5); this.vx = rand(-0.3, 0.3); this.vy = rand(-0.5, -1.3);
        this.a = rand(0.25, 0.85); this.pulse = rand(0, Math.PI*2); this.ps = rand(0.012, 0.04); this.g = rand(8, 24);
      }
      constructor() { this.reset(true); }
      tick() {
        this.x += this.vx; this.y += this.vy; this.pulse += this.ps;
        this.ca = this.a * (0.55 + 0.45 * Math.sin(this.pulse));
        if (this.y < -20 || this.x < -20 || this.x > canvas.width+20) this.reset(false);
      }
      draw() {
        ctx.save();
        const g = ctx.createRadialGradient(this.x,this.y,0,this.x,this.y,this.g+this.r);
        g.addColorStop(0,\`rgba(220,38,38,\${this.ca})\`);
        g.addColorStop(0.45,\`rgba(220,38,38,\${this.ca*0.35})\`);
        g.addColorStop(1,'rgba(220,38,38,0)');
        ctx.beginPath(); ctx.arc(this.x,this.y,this.g+this.r,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
        ctx.beginPath(); ctx.arc(this.x,this.y,this.r,0,Math.PI*2);
        ctx.fillStyle=\`rgba(255,90,90,\${Math.min(this.ca*1.5,1)})\`;
        ctx.shadowColor='#dc2626'; ctx.shadowBlur=14; ctx.fill();
        ctx.restore();
      }
    }
    const pts = Array.from({length:60}, () => new P());
    const blobs = [{x:.12,y:.18,r:300,sp:.0003,ph:0},{x:.88,y:.82,r:240,sp:.0005,ph:2.1},{x:.5,y:.45,r:190,sp:.00025,ph:4.2}];
    function drawBlobs(t) {
      blobs.forEach(b => {
        const cx=(b.x+.07*Math.sin(t*b.sp*1000+b.ph))*canvas.width;
        const cy=(b.y+.05*Math.cos(t*b.sp*1000+b.ph))*canvas.height;
        const g=ctx.createRadialGradient(cx,cy,0,cx,cy,b.r);
        g.addColorStop(0,'rgba(185,20,20,0.065)'); g.addColorStop(1,'rgba(185,20,20,0)');
        ctx.beginPath(); ctx.arc(cx,cy,b.r,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
      });
    }
    function loop(t) { ctx.clearRect(0,0,canvas.width,canvas.height); drawBlobs(t); pts.forEach(p=>{p.tick();p.draw();}); requestAnimationFrame(loop); }
    requestAnimationFrame(loop);

    // ── Login ──
    document.getElementById('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const err = document.getElementById('errorBox');
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const tsEl = document.querySelector('[name="cf-turnstile-response"]');
      const turnstileToken = tsEl ? tsEl.value : '';
      err.style.display = 'none';

      // Turnstile is now REQUIRED — block submission if not completed
      if (!turnstileToken) {
        err.textContent = 'يجب إتمام بوابة التحقق الأمني أولاً';
        err.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span><span>جاري التحقق...</span>';

      try {
        const r = await fetch('/api/auth/qr-login', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({username,password,turnstileToken}) });
        const d = await r.json();
        if (d.success) {
          btn.style.background = 'linear-gradient(135deg,#16a34a,#15803d)';
          btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>تم التحقق بنجاح</span>';
          setTimeout(() => location.reload(), 600);
        } else {
          err.textContent = d.error || 'بيانات الدخول غير صحيحة'; err.style.display='block';
          btn.disabled=false; btn.innerHTML='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg><span>دخول لوحة الواتساب</span>';
          if (typeof turnstile !== 'undefined') turnstile.reset();
        }
      } catch { err.textContent='تعذر الاتصال — حاول مرة أخرى'; err.style.display='block'; btn.disabled=false; btn.innerHTML='<span>دخول لوحة الواتساب</span>'; }
    });
  </script>
</body>
</html>`;

const verifyAdminOrLocal = (req, res, next) => {
  if (!QR_PASS) {
    logger.error('QR page accessed but QR_ADMIN_PASSWORD is not set — refusing access.');
    return res.status(503).send('QR pairing is disabled. Set QR_ADMIN_PASSWORD on the server.');
  }
  if (checkAuth(req)) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.status(200).send(LOGIN_PAGE_HTML(TURNSTILE_SITE_KEY));
  return res.status(401).json({ error: 'Authentication required' });
};

module.exports = { verifyAdminOrLocal, checkAuth, safeCompare, QR_USER, QR_PASS };
