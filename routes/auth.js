const express = require('express');
const router = express.Router();
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const otpService = require('../services/otpService');
const whatsappService = require('../services/whatsappService');
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const { verifyUser } = require('../middleware/auth');
const userProfileService = require('../services/userProfileService');
const twoFactorService = require('../services/twoFactorService');

async function recordOtpAudit(entry) {
  try {
    const { error } = await supabase.from('otp_audit_logs').insert([entry]);
    if (error) logger.warn('OTP audit insert failed:', error.message);
  } catch (err) {
    logger.warn('OTP audit insert failed:', err.message);
  }
}

// Health Check
router.get('/health', async (req, res) => {
  const status = {
    server: 'ok',
    whatsapp: whatsappService.getStatus(),
    db: 'unknown'
  };

  try {
    const { error } = await supabase.from('otp_codes').select('count', { count: 'exact', head: true });
    status.db = error ? `error: ${error.message || JSON.stringify(error)}` : 'connected';
  } catch (err) {
    status.db = `exception: ${err.message}`;
  }

  res.json(status);
});

// Validation Schemas
const sendOTPSchema = z.object({
  phone: z.string().min(10).max(15).regex(/^\+?[1-9]\d{1,14}$/, 'رقم هاتف غير صحيح'),
  turnstileToken: z.string().optional(),
});

const verifyOTPSchema = z.object({
  phone: z.string(),
  code: z.string().length(6, 'كود التحقق يجب أن يكون 6 أرقام'),
});

// Strict per-IP rate limiter for OTP send (2 req / 5 min per IP)
const otpRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 2,
  message: { error: 'طلبات كود التحقق كثيرة جداً، حاول بعد 5 دقائق' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-phone + per-IP rate limiter for OTP send (3 req / 1 hour per phone+IP)
const perPhoneOtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'تم تجاوز الحد المسموح من طلبات التحقق لهذا الرقم، حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    try {
      const { phone } = sendOTPSchema.parse(req.body);
      return `${req.ip}_${phone}`;
    } catch {
      return req.ip;
    }
  },
});

// Per-IP rate limiter for OTP verify (3 req / 1 min per IP) to prevent brute force
const verifyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'محاولات تحقق كثيرة جداً، حاول بعد دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for sensitive write operations (5 req / 1 min per IP)
const sensitiveWriteRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'طلبات كثيرة جداً، يرجى المحاولة لاحقاً' },
  standardHeaders: true,
  legacyHeaders: false,
});


// Route: Request OTP — IP limit + per-phone limit
router.post('/profile/sync', verifyUser, sensitiveWriteRateLimiter, async (req, res) => {
  try {
    const profile = await userProfileService.syncUserProfile(req.user, req.body?.store_id);
    return res.json({ success: true, profile });
  } catch (err) {
    logger.error('Profile sync failed:', err.message);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.statusCode === 401 ? 'Unauthorized' : 'Unable to sync profile'
    });
  }
});

router.post('/profile/mark-email-verified', verifyUser, sensitiveWriteRateLimiter, async (req, res) => {
  try {
    const profile = await userProfileService.markEmailVerified(req.user, req.body?.store_id);
    return res.json({ success: true, profile });
  } catch (err) {
    logger.error('Mark email verified failed:', err.message);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.statusCode === 401 ? 'Unauthorized' : 'Unable to update verification status'
    });
  }
});

router.post('/profile/phone', verifyUser, sensitiveWriteRateLimiter, async (req, res) => {
  try {
    const profile = await userProfileService.updateProfilePhone(req.user, req.body?.store_id, req.body?.phone);
    return res.json({ success: true, profile });
  } catch (err) {
    logger.error('Profile phone update failed:', err.message);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.statusCode === 400 ? 'Phone is required' : 'Unable to update phone'
    });
  }
});

router.post('/send-otp', otpRateLimiter, perPhoneOtpLimiter, async (req, res) => {
  const { phone, user_id, purpose, turnstileToken } = { ...req.body, ...sendOTPSchema.parse(req.body) };

  if (!req.store?.id) {
    return res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'OTP is only available inside a tenant store.' });
  }

  // Turnstile Verification
  if (!global.DEV_MODE_ENABLED) {
    if (!turnstileToken) {
      return res.status(400).json({ success: false, error: 'التحقق الأمني مطلوب (Turnstile Token Missing)' });
    }

    try {
      const secretKey = (process.env.TURNSTILE_SECRET_KEY || '').trim();

      if (!secretKey) {
        logger.error('TURNSTILE_SECRET_KEY is not configured on the server.');
        return res.status(500).json({ success: false, error: 'خدمة التحقق الأمني غير مهيأة' });
      }
      
      const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          secret: secretKey,
          response: turnstileToken
        })
      });
      const cfData = await cfRes.json();
      
      if (!cfData.success) {
        logger.warn('Turnstile verification failed', cfData);
        return res.status(403).json({ 
          success: false, 
          error: 'فشل التحقق الأمني، تأكد من أنك لست روبوت'
        });
      }
    } catch (err) {
      logger.error('Turnstile verification error:', err);
      return res.status(500).json({ success: false, error: 'خطأ داخلي أثناء التحقق الأمني' });
    }
  }

  const localPhone = phone.startsWith('2') ? phone.slice(1) : phone;

  // تأكد إن الرقم مش مرتبط بحساب تاني
  // لو purpose = forgot → سيبها (نسيان كلمة المرور)
  // لو معانا user_id → بلوك بس لو الرقم مملوك لغير صاحب الـ user_id
  // لو مفيش user_id (إنشاء حساب جديد) → بلوك لو الرقم موجود أصلاً
  const { data: existing } = await supabase
    .from('user_profiles')
    .select('user_id')
    .eq('phone', localPhone)
    .eq('store_id', req.store.id)
    .maybeSingle();
  if (existing && purpose !== 'forgot') {
    if (!user_id || existing.user_id !== user_id) {
      return res.status(409).json({ success: false, error: 'هذا الرقم مسجل بحساب آخر من قبل. برجاء تسجيل الدخول أو استخدام رقم آخر.' });
    }
  }

  let reservationKey = null;
  try {
    reservationKey = `otp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const reserved = await subscriptionLimitService.reserveFeatureUsage(req.store.id, 'otp_messages_month', 1, reservationKey, 5);
    if (!reserved) {
      return res.status(403).json({ success: false, code: 'FEATURE_LIMIT_EXCEEDED', error: 'Monthly OTP quota reached for this store.' });
    }
  } catch (limitErr) {
    logger.error('OTP limit check failed:', limitErr.message);
    return res.status(500).json({ success: false, error: 'Internal Server Error: Unable to verify quota limits.' });
  }

  try {
    await otpService.sendOTP(phone, req.store);
    if (reservationKey) await subscriptionLimitService.commitFeatureUsage(reservationKey);
    
    await recordOtpAudit({
      store_id: req.store.id,
      phone,
      purpose: purpose || 'login',
      status: 'sent',
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null
    });
  } catch (err) {
    if (reservationKey) await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
    
    await recordOtpAudit({
      store_id: req.store.id,
      phone,
      purpose: purpose || 'login',
      status: 'failed',
      error_message: err.message,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null
    });
    throw err;
  }
  
  res.json({ success: true, message: 'تم إرسال كود التحقق بنجاح' });
});

// Route: Verify OTP — IP rate limited (10 req/min)
router.post('/verify-otp', verifyRateLimiter, async (req, res) => {
  const { phone, code } = verifyOTPSchema.parse(req.body);

  if (!req.store?.id) {
    return res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'OTP is only available inside a tenant store.' });
  }

  const isValid = await otpService.verifyOTP(phone, code, req.store);

  if (isValid) {
    res.json({ success: true, message: 'تم التحقق بنجاح' });
  } else {
    res.status(400).json({ success: false, error: 'كود التحقق غير صحيح أو انتهت صلاحيته' });
  }
});

// Validation Schema for Reset Password
const resetPasswordSchema = z.object({
  phone: z.string(),
  code: z.string().length(6),
  new_password: z.string().min(6, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
});

// Route: Reset Password via OTP (forgot password)
router.post('/reset-password', otpRateLimiter, verifyRateLimiter, async (req, res) => {
  try {
    const { phone, code, new_password } = resetPasswordSchema.parse(req.body);

    // 1. Verify OTP
    if (!req.store?.id) {
      return res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'OTP is only available inside a tenant store.' });
    }

    const isValid = await otpService.verifyOTP(phone, code, req.store);
    if (!isValid) {
      return res.status(400).json({ success: false, error: 'كود التحقق غير صحيح أو انتهت صلاحيته' });
    }

    // 2. Extract local phone number (remove country code "2")
    const localPhone = phone.startsWith('2') ? phone.slice(1) : phone;

    // 3. Look up user by phone in user_profiles
    const { data: profiles, error: profileError } = await supabase
      .from('user_profiles')
      .select('user_id')
      .eq('phone', localPhone)
      .eq('store_id', req.store.id)
      .single();

    if (profileError || !profiles) {
      return res.status(404).json({ success: false, error: 'لم يتم العثور على حساب مرتبط بهذا الرقم' });
    }

    // 4. Update password using Supabase Admin API (service role)
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      profiles.user_id,
      { password: new_password }
    );

    if (updateError) {
      logger.error('Password reset error:', updateError);
      return res.status(500).json({ success: false, error: 'فشل في تحديث كلمة المرور' });
    }

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: err.errors[0].message });
    }
    logger.error('Reset password error:', err);
    res.status(500).json({ success: false, error: 'حدث خطأ غير متوقع' });
  }
});

// OAuth Broker v2 implementation
const { encrypt, decrypt, signState, verifyState } = require('../utils/crypto');
const crypto = require('crypto');

function getBrowserFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /mobile/i.test(userAgent);
  const os = /windows/i.test(userAgent) ? 'windows' :
             /macintosh/i.test(userAgent) ? 'mac' :
             /linux/i.test(userAgent) ? 'linux' :
             /android/i.test(userAgent) ? 'android' :
             /iphone|ipad/i.test(userAgent) ? 'ios' : 'other';
             
  const browser = /chrome/i.test(userAgent) ? 'chrome' :
                  /safari/i.test(userAgent) && !/chrome/i.test(userAgent) ? 'safari' :
                  /firefox/i.test(userAgent) ? 'firefox' :
                  /edg/i.test(userAgent) ? 'edge' : 'other';
                  
  return `${os}-${browser}-${isMobile ? 'mobile' : 'desktop'}`;
}

function getRelaxedIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.slice(0, 3).join('.'); // first 3 octets
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':'); // first 3 blocks
  }
  return ip;
}

// GET /api/auth/oauth/login
router.get('/oauth/login', async (req, res) => {
  const { provider, store, redirect_to, origin_host } = req.query;
  if (!provider) return res.status(400).json({ error: 'OAuth provider is required' });

  try {
    const safeRedirect = typeof redirect_to === 'string' && redirect_to.startsWith('/') && !redirect_to.startsWith('//')
      ? redirect_to
      : '/';

    const { data: targetStore, error: storeError } = await supabase
      .from('stores')
      .select('id, subdomain, custom_domain')
      .eq('subdomain', store || 'egparts')
      .maybeSingle();

    if (storeError || !targetStore) {
      return res.status(404).json({ error: 'Store not found for OAuth login' });
    }

    const platformDomain = (process.env.PRIMARY_DOMAIN || 'egparts.store').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
    const canonicalHost = targetStore.custom_domain || `${targetStore.subdomain}.${platformDomain}`;
    
    // Validate origin host to prevent open redirects
    const rawOriginHost = (origin_host || '').toString().toLowerCase().trim();
    const normalizedOrigin = rawOriginHost.split(':')[0].replace(/^www\./, '');
    
    let frontendUrlHost = 'localhost';
    try {
      frontendUrlHost = new URL(process.env.FRONTEND_URL || 'http://localhost:5173').hostname.replace(/^www\./, '');
    } catch(e) {}

    const isLocalhost = normalizedOrigin === 'localhost' || normalizedOrigin === '127.0.0.1';
    const isFrontendUrl = normalizedOrigin === frontendUrlHost || normalizedOrigin.endsWith('.' + frontendUrlHost);
    const isCanonical = normalizedOrigin === canonicalHost.replace(/^www\./, '');
    const isPlatform = normalizedOrigin.endsWith('.' + platformDomain) || normalizedOrigin === platformDomain;
    const isNewDomain = normalizedOrigin === 'egparts.store' || normalizedOrigin.endsWith('.egparts.store');
    
    const allowedOrigin = normalizedOrigin && (isLocalhost || isFrontendUrl || isCanonical || isPlatform || isNewDomain);

    const stateToken = signState({
      store_id: targetStore.id,
      store: targetStore.subdomain,
      redirect_to: safeRedirect,
      origin_host: allowedOrigin ? rawOriginHost : null,
      nonce: crypto.randomBytes(16).toString('hex')
    });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const callbackBase = process.env.BACKEND_PUBLIC_URL || process.env.VITE_BACKEND_URL || `${protocol}://${host}`;
    
    const redirectUrl = `${process.env.SUPABASE_URL}/auth/v1/authorize?provider=${provider}&response_type=code&redirect_to=${encodeURIComponent(
      `${callbackBase}/api/auth/oauth/callback?broker_token=${encodeURIComponent(stateToken)}`
    )}`;

    res.json({ url: redirectUrl });
  } catch (err) {
    logger.error('OAuth login initialization failed', { message: err.message });
    res.status(500).json({ error: 'Failed to initialize OAuth login' });
  }
});

// GET /api/auth/oauth/callback
router.get('/oauth/callback', async (req, res) => {
  const { code, state, broker_token } = req.query;
  const oauthState = broker_token || state;
  const stateData = verifyState(oauthState);
  if (!stateData) return res.status(400).send('طلب غير صالح أو تم التلاعب به.');

  if (!code) {
    // Override CSP header to allow inline scripts for processing the hash token
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    // If no code is present in query parameters, return the HTML page to handle implicit flow via Hash
    return res.send(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>جاري مصادقة الدخول...</title>
        <style>
          body {
            background-color: #0b0f19;
            color: #ffffff;
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
          }
          .spinner {
            border: 4px solid rgba(255, 255, 255, 0.1);
            width: 42px;
            height: 42px;
            border-radius: 50%;
            border-left-color: #3b82f6;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
          }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          .message { font-size: 16px; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="spinner"></div>
        <div class="message" id="msg">جاري التحقق من بيانات الدخول، يرجى الانتظار...</div>
        <script>
          (async function() {
            const hash = window.location.hash;
            const msgEl = document.getElementById('msg');
            if (hash && hash.includes('access_token=')) {
              const params = new URLSearchParams(hash.replace(/^#/, '?'));
              const accessToken = params.get('access_token');
              const refreshToken = params.get('refresh_token');
              
              try {
                const response = await fetch('/api/auth/oauth/implicit-callback', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    broker_token: ${JSON.stringify(oauthState)},
                    access_token: accessToken,
                    refresh_token: refreshToken
                  })
                });
                const data = await response.json();
                if (data.redirectUrl) {
                  window.location.href = data.redirectUrl;
                } else {
                  msgEl.innerText = 'فشلت عملية المصادقة: ' + (data.error || 'خطأ غير معروف');
                }
              } catch (err) {
                msgEl.innerText = 'حدث خطأ أثناء الاتصال بالخادم: ' + err.message;
              }
            } else {
              msgEl.innerText = 'كود التحقق غير موجود في الرابط.';
            }
          })();
        </script>
      </body>
      </html>
    `);
  }

  try {
    // Perform cleanup of expired exchanges inline on callback
    await supabase.from('oauth_exchanges').delete().lt('expires_at', new Date().toISOString());

    // Exchange code for Supabase Session
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data?.session) throw error || new Error('فشل توليد الجلسة');

    const session = data.session;
    const userId = session.user.id;

    // Load store context
    let storeQuery = supabase
      .from('stores')
      .select('*');

    storeQuery = stateData.store_id
      ? storeQuery.eq('id', stateData.store_id)
      : storeQuery.eq('subdomain', stateData.store);

    const { data: store, error: storeError } = await storeQuery.maybeSingle();
    if (storeError) {
      logger.error('Failed to query store during OAuth callback:', { error: storeError.message, stateData });
      throw new Error(`حدث خطأ أثناء جلب بيانات المتجر: ${storeError.message}`);
    }
    if (!store) throw new Error('المتجر غير موجود');

    // Pre-validate tenant membership / ban status
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('is_banned')
      .eq('user_id', userId)
      .eq('store_id', store.id)
      .maybeSingle();

    if (profile?.is_banned) {
      return res.status(403).send('هذا الحساب محظور في هذا المتجر.');
    }

    // Encrypt session (access + refresh tokens)
    const sessionStr = JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    });
    const encrypted = encrypt(sessionStr);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30000).toISOString(); // 30s expiry

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const fingerprint = getBrowserFingerprint(req);
    const relaxedIp = getRelaxedIp(clientIp);

    await supabase.from('oauth_exchanges').insert({
      token,
      encrypted_session: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      ip_address: relaxedIp,
      user_agent: fingerprint,
      expires_at: expiresAt
    });

    const safeRedirect = typeof stateData.redirect_to === 'string' && stateData.redirect_to.startsWith('/') && !stateData.redirect_to.startsWith('//')
      ? stateData.redirect_to
      : '/';
    const platformDomain = (process.env.PRIMARY_DOMAIN || 'egparts.store').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
    const canonicalHost = store.custom_domain || `${store.subdomain}.${platformDomain}`;
    
    let targetHost = `https://${canonicalHost}`;
    if (stateData.origin_host) {
      const isLocalhost = stateData.origin_host.startsWith('localhost') || stateData.origin_host.startsWith('127.0.0.1');
      targetHost = isLocalhost ? `http://${stateData.origin_host}` : `https://${stateData.origin_host}`;
    }

    logger.info('OAuth callback redirecting user', {
      targetHost,
      canonicalHost,
      originHost: stateData.origin_host,
      storeSubdomain: store.subdomain,
      safeRedirect
    });

    res.redirect(`${targetHost}/auth/callback?exchange_token=${token}&redirect_to=${encodeURIComponent(safeRedirect)}`);
  } catch (err) {
    logger.error('OAuth callback process failed', { message: err.message });
    res.status(500).send('حدث خطأ أثناء مصادقة الهوية.');
  }
});

// POST /api/auth/oauth/implicit-callback
router.post('/oauth/implicit-callback', async (req, res) => {
  const { broker_token, access_token, refresh_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'access_token required' });

  const stateData = verifyState(broker_token);
  if (!stateData) return res.status(400).json({ error: 'طلب غير صالح أو تم التلاعب به.' });

  try {
    // Perform cleanup of expired exchanges inline
    await supabase.from('oauth_exchanges').delete().lt('expires_at', new Date().toISOString());

    // Retrieve user details using access token
    const { data: { user }, error: userError } = await supabase.auth.getUser(access_token);
    if (userError || !user) throw userError || new Error('فشل جلب بيانات المستخدم');

    const userId = user.id;

    // Load store context
    let storeQuery = supabase
      .from('stores')
      .select('*');

    storeQuery = stateData.store_id
      ? storeQuery.eq('id', stateData.store_id)
      : storeQuery.eq('subdomain', stateData.store);

    const { data: store, error: storeError } = await storeQuery.maybeSingle();
    if (storeError) {
      logger.error('Failed to query store during implicit callback:', { error: storeError.message, stateData });
      throw new Error(`حدث خطأ أثناء جلب بيانات المتجر: ${storeError.message}`);
    }
    if (!store) throw new Error('المتجر غير موجود');

    // Pre-validate tenant membership / ban status
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('is_banned')
      .eq('user_id', userId)
      .eq('store_id', store.id)
      .maybeSingle();

    if (profile?.is_banned) {
      return res.status(403).json({ error: 'هذا الحساب محظور في هذا المتجر.' });
    }

    // Encrypt session (access + refresh tokens)
    const sessionStr = JSON.stringify({
      access_token: access_token,
      refresh_token: refresh_token
    });
    const encrypted = encrypt(sessionStr);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30000).toISOString(); // 30s expiry

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const fingerprint = getBrowserFingerprint(req);
    const relaxedIp = getRelaxedIp(clientIp);

    await supabase.from('oauth_exchanges').insert({
      token,
      encrypted_session: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      ip_address: relaxedIp,
      user_agent: fingerprint,
      expires_at: expiresAt
    });

    const safeRedirect = typeof stateData.redirect_to === 'string' && stateData.redirect_to.startsWith('/') && !stateData.redirect_to.startsWith('//')
      ? stateData.redirect_to
      : '/';
    const platformDomain = (process.env.PRIMARY_DOMAIN || 'egparts.store').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
    const canonicalHost = store.custom_domain || `${store.subdomain}.${platformDomain}`;
    
    let targetHost = `https://${canonicalHost}`;
    if (stateData.origin_host) {
      const isLocalhost = stateData.origin_host.startsWith('localhost') || stateData.origin_host.startsWith('127.0.0.1');
      targetHost = isLocalhost ? `http://${stateData.origin_host}` : `https://${stateData.origin_host}`;
    }

    logger.info('Implicit OAuth callback redirecting user', {
      targetHost,
      canonicalHost,
      originHost: stateData.origin_host,
      storeSubdomain: store.subdomain,
      safeRedirect
    });

    const redirectUrl = `${targetHost}/auth/callback?exchange_token=${token}&redirect_to=${encodeURIComponent(safeRedirect)}`;
    res.json({ redirectUrl });
  } catch (err) {
    logger.error('Implicit OAuth callback process failed:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء مصادقة الهوية.' });
  }
});

// POST /api/auth/oauth/exchange
router.post('/oauth/exchange', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'رمز التبادل مطلوب' });

  try {
    const { data: exchange, error } = await supabase
      .from('oauth_exchanges')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error || !exchange) return res.status(400).json({ error: 'الرمز غير صالح أو منتهي الصلاحية' });

    if (new Date(exchange.expires_at) < new Date()) {
      await supabase.from('oauth_exchanges').delete().eq('token', token);
      return res.status(400).json({ error: 'الرمز منتهي الصلاحية' });
    }

    // Verify browser context matching
    const currentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const currentFingerprint = getBrowserFingerprint(req);
    const currentRelaxedIp = getRelaxedIp(currentIp);

    if (exchange.user_agent !== currentFingerprint || exchange.ip_address !== currentRelaxedIp) {
      logger.warn('Fingerprint/IP mismatch in session exchange (non-blocking)', {
        expectedIp: exchange.ip_address,
        actualIp: currentRelaxedIp,
        expectedFingerprint: exchange.user_agent,
        actualFingerprint: currentFingerprint
      });
    }

    // Consume token
    await supabase.from('oauth_exchanges').delete().eq('token', token);

    // Decrypt session details
    const decryptedJson = decrypt(exchange.encrypted_session, exchange.iv, exchange.auth_tag);
    const sessionData = JSON.parse(decryptedJson);

    res.json({ success: true, session: sessionData });
  } catch (err) {
    logger.error('Session exchange exception occurred', { message: err.message });
    res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء معالجة الرمز' });
  }
});

// GET /api/auth/invitation/verify - Validate an invitation token
router.get('/invitation/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'رمز الدعوة مطلوب' });
  }

  try {
    const { data: invitation, error } = await supabase
      .from('tenant_invitations')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error || !invitation) {
      return res.status(404).json({ error: 'الدعوة غير موجودة أو انتهت صلاحيتها' });
    }

    const isClosed = !['pending', 'sent', 'opened'].includes(invitation.status);
    if (isClosed) {
      return res.status(400).json({ error: 'تم قبول أو إلغاء هذه الدعوة بالفعل' });
    }

    const isExpired = new Date(invitation.expires_at) < new Date();
    if (isExpired) {
      await supabase
        .from('tenant_invitations')
        .update({ status: 'expired' })
        .eq('id', invitation.id);
      return res.status(400).json({ error: 'انتهت صلاحية هذه الدعوة' });
    }

    // Set status to opened if it was pending or sent
    if (invitation.status === 'pending' || invitation.status === 'sent') {
      await supabase
        .from('tenant_invitations')
        .update({ status: 'opened' })
        .eq('id', invitation.id);
    }

    res.json({
      success: true,
      email: invitation.email,
      phone: invitation.phone,
      store_id: invitation.store_id
    });
  } catch (err) {
    logger.error('Invitation verify error:', err.message);
    res.status(500).json({ error: 'خطأ داخلي أثناء التحقق من الدعوة' });
  }
});

// POST /api/auth/invitation/accept - Provision tenant and accept owner invitation
router.post('/invitation/accept', sensitiveWriteRateLimiter, async (req, res) => {
  const { token, password, name, email } = req.body;
  if (!token || !password || !name) {
    return res.status(400).json({ error: 'الاسم وكلمة المرور مطلوبان' });
  }

  try {
    // 1. Verify invitation
    const { data: invitation, error } = await supabase
      .from('tenant_invitations')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error || !invitation) {
      return res.status(404).json({ error: 'الدعوة غير موجودة أو غير صالحة' });
    }

    if (!['pending', 'sent', 'opened'].includes(invitation.status)) {
      return res.status(400).json({ error: 'تم تفعيل الدعوة أو إلغاؤها مسبقاً' });
    }

    if (new Date(invitation.expires_at) < new Date()) {
      await supabase.from('tenant_invitations').update({ status: 'expired' }).eq('id', invitation.id);
      return res.status(400).json({ error: 'انتهت صلاحية الدعوة' });
    }

    // Use the email stored in the invitation as the authoritative source.
    // This prevents tampering: the user cannot change the email via the form.
    const userEmail = invitation.email
      ? invitation.email.trim().toLowerCase()
      : (email ? email.trim().toLowerCase() : null);

    // 2. Manage Auth User creation (Idempotent check)
    let authUserId = null;

    if (!userEmail) {
      return res.status(400).json({ error: 'البريد الإلكتروني مطلوب لإنشاء الحساب' });
    }

    let existingUser = null;
    const { data: rpcUser, error: rpcError } = await supabase.rpc('get_auth_user_by_email', { p_email: userEmail });
    if (!rpcError && rpcUser && rpcUser.id) {
      existingUser = rpcUser;
    } else {
      const { data: usersData, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      if (!listError && usersData?.users) {
        existingUser = usersData.users.find(u => u.email && u.email.toLowerCase() === userEmail);
      }
    }

    if (existingUser) {
      authUserId = existingUser.id;
    } else {
      const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
        email: userEmail,
        password,
        email_confirm: true,
        phone: invitation.phone || undefined,
        user_metadata: { name, phone: invitation.phone || undefined }
      });

      if (createErr) throw createErr;
      authUserId = newUser.user.id;
    }

    // 2b. If user already existed without a phone, patch it now
    if (invitation.phone) {
      await supabase.auth.admin.updateUserById(authUserId, {
        phone: invitation.phone,
        user_metadata: { name, phone: invitation.phone }
      }).catch(err => logger.warn('Could not update phone on auth user:', err.message));
    }

    // 3. Clone template roles into the store (Idempotent)
    const { data: templateRoles } = await supabase
      .from('roles')
      .select('*')
      .eq('role_type', 'tenant_template');

    const roleMapping = {}; // Map templates role ID -> new tenant role ID
    let ownerRoleId = null;

    if (templateRoles && templateRoles.length > 0) {
      for (const tRole of templateRoles) {
        // Check if role already exists for this store
        const { data: existingStoreRole } = await supabase
          .from('roles')
          .select('id')
          .eq('store_id', invitation.store_id)
          .eq('name', tRole.name)
          .maybeSingle();

        let targetRoleId;
        if (existingStoreRole) {
          targetRoleId = existingStoreRole.id;
        } else {
          const { data: newRole, error: roleInsErr } = await supabase
            .from('roles')
            .insert([{
              store_id: invitation.store_id,
              name: tRole.name,
              display_name: tRole.display_name,
              priority: tRole.priority,
              system_role: tRole.system_role,
              editable: tRole.editable,
              role_type: 'tenant',
              description: tRole.description
            }])
            .select('id')
            .single();

          if (roleInsErr) throw roleInsErr;
          targetRoleId = newRole.id;
        }

        roleMapping[tRole.id] = targetRoleId;
        if (tRole.name === 'owner') {
          ownerRoleId = targetRoleId;
        }

        // Copy permissions for this role
        const { data: permMappings } = await supabase
          .from('role_permissions')
          .select('permission_id')
          .eq('role_id', tRole.id);

        if (permMappings && permMappings.length > 0) {
          const permInserts = permMappings.map(pm => ({
            role_id: targetRoleId,
            permission_id: pm.permission_id
          }));
          await supabase
            .from('role_permissions')
            .upsert(permInserts, { onConflict: 'role_id,permission_id', ignoreDuplicates: true });
        }
      }
    }

    // 4. Map user to owner role in the store
    if (ownerRoleId) {
      await supabase
        .from('user_roles')
        .upsert([{
          user_id: authUserId,
          store_id: invitation.store_id,
          role_id: ownerRoleId
        }], { onConflict: 'user_id,store_id,role_id', ignoreDuplicates: true });
    }

    // 4b. Upsert user_profiles so the manager's phone & name are linked immediately
    await supabase
      .from('user_profiles')
      .upsert([{
        user_id: authUserId,
        store_id: invitation.store_id,
        email: userEmail,
        phone: invitation.phone || null,
        full_name: name,
        role: 'owner'
      }], { onConflict: 'user_id,store_id', ignoreDuplicates: false })
      .catch(err => logger.warn('user_profiles upsert failed (non-fatal):', err.message));

    // 5. Build branch hierarchy (Idempotent)
    let branchId = null;
    const { data: existingBranch } = await supabase
      .from('branches')
      .select('id')
      .eq('store_id', invitation.store_id)
      .limit(1)
      .maybeSingle();

    if (existingBranch) {
      branchId = existingBranch.id;
    } else {
      const { data: newBranch, error: branchErr } = await supabase
        .from('branches')
        .insert([{
          store_id: invitation.store_id,
          name: 'الفرع الرئيسي',
          address: 'المقر الرئيسي للمتجر'
        }])
        .select('id')
        .single();

      if (branchErr) throw branchErr;
      branchId = newBranch.id;
    }

    // 6. Build warehouse (Idempotent)
    let warehouseId = null;
    const { data: existingWarehouse } = await supabase
      .from('warehouses')
      .select('id')
      .eq('branch_id', branchId)
      .limit(1)
      .maybeSingle();

    if (existingWarehouse) {
      warehouseId = existingWarehouse.id;
    } else {
      const { data: newWarehouse, error: whErr } = await supabase
        .from('warehouses')
        .insert([{
          branch_id: branchId,
          name: 'المخزن الرئيسي'
        }])
        .select('id')
        .single();

      if (whErr) throw whErr;
      warehouseId = newWarehouse.id;
    }

    // 7. Build default shelf (Idempotent)
    const { data: existingShelf } = await supabase
      .from('shelves')
      .select('id')
      .eq('warehouse_id', warehouseId)
      .limit(1)
      .maybeSingle();

    if (!existingShelf) {
      await supabase
        .from('shelves')
        .insert([{
          warehouse_id: warehouseId,
          label: 'الرف الرئيسي'
        }]);
    }

    // 8. Update invitation status to completed
    await supabase
      .from('tenant_invitations')
      .update({
        status: 'completed',
        email: userEmail,
        accepted_at: new Date().toISOString(),
        accepted_by: authUserId,
        accepted_ip: req.ip
      })
      .eq('id', invitation.id);

    // 9. Update store status to active
    const { data: store } = await supabase
      .from('stores')
      .update({ is_active: true })
      .eq('id', invitation.store_id)
      .select('subdomain, custom_domain')
      .single();

    res.json({
      success: true,
      message: 'تم تفعيل حساب صاحب المتجر وتهيئة البنية التحتية بنجاح',
      subdomain: store?.subdomain,
      custom_domain: store?.custom_domain
    });
  } catch (err) {
    logger.error('Invitation accept error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء تفعيل وتجهيز المتجر.' });
  }
});

// POST /api/auth/validate-admin - Validate admin access for a user session
router.post('/validate-admin', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const { store_id } = req.body;

  try {
    const tokenVerifier = require('../utils/tokenVerifier');
    const token = authHeader.split(' ')[1];
    const decoded = tokenVerifier.verify(token);
    const userId = decoded.sub;

    const [{ data: superAdmin }, { data: storeAdmin }] = await Promise.all([
      supabase.from('super_admins').select('user_id').eq('user_id', userId).maybeSingle(),
      store_id
        ? supabase.from('store_admins').select('id').eq('user_id', userId).eq('store_id', store_id).maybeSingle()
        : supabase.from('store_admins').select('id').eq('user_id', userId).limit(1).maybeSingle()
    ]);

    res.json({
      success: true,
      isSuperAdmin: !!superAdmin,
      isStoreAdmin: !!storeAdmin,
      isAuthorized: !!(superAdmin || storeAdmin)
    });
  } catch (err) {
    logger.error('Admin validation endpoint error:', err.message);
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
});

// ============================================================
// 2FA Routes
// ============================================================

// GET /api/auth/2fa/status — get 2FA status for current user in this store
router.get('/2fa/status', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ error: 'store context required' });
    const status = await twoFactorService.get2FAStatus(req.user.sub, req.store.id);
    res.json({ success: true, ...status });
  } catch (err) {
    logger.error('2FA status error:', err.message);
    res.status(500).json({ error: 'فشل تحميل إعدادات الأمان' });
  }
});

// GET /api/auth/2fa/totp/setup — generate TOTP secret + QR code
router.get('/2fa/totp/setup', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ error: 'store context required' });
    const { data: profile } = await supabase.from('user_profiles')
      .select('email, full_name').eq('user_id', req.user.sub).eq('store_id', req.store.id).maybeSingle();
    const { data: store } = await supabase.from('stores')
      .select('name').eq('id', req.store.id).maybeSingle();
    const result = await twoFactorService.setupTOTP(
      req.user.sub, req.store.id,
      store?.name || 'EG Parts',
      profile?.email || req.user.email || 'user'
    );
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('TOTP setup error:', err.message);
    res.status(500).json({ error: 'فشل إعداد Google Authenticator' });
  }
});

// POST /api/auth/2fa/totp/verify-setup — confirm TOTP is working before enabling
router.post('/2fa/totp/verify-setup', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ error: 'store context required' });
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'كود التحقق مطلوب' });
    const result = await twoFactorService.verifyTOTPSetup(req.user.sub, req.store.id, token);
    if (!result.success) return res.status(400).json({ success: false, error: 'الكود غير صحيح، تأكد من التوقيت على هاتفك' });
    res.json({ success: true, backup_codes: result.backup_codes });
  } catch (err) {
    logger.error('TOTP verify-setup error:', err.message);
    res.status(500).json({ error: err.message || 'فشل التحقق من الإعداد' });
  }
});

// POST /api/auth/2fa/enable — enable WhatsApp 2FA (no TOTP needed)
router.post('/2fa/enable', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ error: 'store context required' });
    const result = await twoFactorService.enableWhatsApp2FA(req.user.sub, req.store.id);
    res.json({ success: true, backup_codes: result.backup_codes });
  } catch (err) {
    logger.error('Enable 2FA error:', err.message);
    res.status(500).json({ error: 'فشل تفعيل التحقق بخطوتين' });
  }
});

// POST /api/auth/2fa/disable — disable 2FA
router.post('/2fa/disable', verifyUser, async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ error: 'store context required' });
    await twoFactorService.disable2FA(req.user.sub, req.store.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Disable 2FA error:', err.message);
    res.status(500).json({ error: 'فشل إلغاء التحقق بخطوتين' });
  }
});

// POST /api/auth/2fa/challenge — send WhatsApp OTP challenge (called right after login if 2FA enabled)
router.post('/2fa/challenge', async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ error: 'store context required' });
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });
    const result = await twoFactorService.sendChallenge(user_id, req.store.id, req.store);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('2FA challenge error:', err.message);
    res.status(500).json({ error: err.message || 'فشل إرسال كود التحقق' });
  }
});

// POST /api/auth/2fa/verify — verify challenge + confirm login is complete
router.post('/2fa/verify', async (req, res) => {
  try {
    if (!req.store?.id) return res.status(400).json({ error: 'store context required' });
    const { user_id, token } = req.body;
    if (!user_id || !token) return res.status(400).json({ error: 'user_id والكود مطلوبان' });
    const result = await twoFactorService.verifyChallenge(user_id, req.store.id, token, req.store);
    if (!result.success) return res.status(400).json({ success: false, error: 'الكود غير صحيح أو انتهت صلاحيته' });
    res.json({ success: true, used_backup_code: result.used_backup_code || false });
  } catch (err) {
    logger.error('2FA verify error:', err.message);
    res.status(500).json({ error: err.message || 'فشل التحقق' });
  }
});

// Resolve Membership (SaaS architecture)
const resolveMembershipRouter = require('./resolveMembership');
router.use('/', resolveMembershipRouter);

module.exports = router;
