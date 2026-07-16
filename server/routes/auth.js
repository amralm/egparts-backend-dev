const express = require('express');
const router = express.Router();
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const otpService = require('../services/otpService');
const whatsappService = require('../services/whatsappService');
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

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

// Per-IP rate limiter for OTP verify (10 req / 1 min per IP)
const verifyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'محاولات تحقق كثيرة جداً، حاول بعد دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Route: Request OTP — IP limit + per-phone limit
router.post('/send-otp', otpRateLimiter, perPhoneOtpLimiter, async (req, res) => {
  const { phone, user_id, purpose, turnstileToken } = { ...req.body, ...sendOTPSchema.parse(req.body) };

  // Turnstile Verification
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

  await otpService.sendOTP(phone, req.store);
  
  res.json({ success: true, message: 'تم إرسال كود التحقق بنجاح' });
});

// Route: Verify OTP — IP rate limited (10 req/min)
router.post('/verify-otp', verifyRateLimiter, async (req, res) => {
  const { phone, code } = verifyOTPSchema.parse(req.body);

  const isValid = await otpService.verifyOTP(phone, code);

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
router.post('/reset-password', otpRateLimiter, async (req, res) => {
  try {
    const { phone, code, new_password } = resetPasswordSchema.parse(req.body);

    // 1. Verify OTP
    const isValid = await otpService.verifyOTP(phone, code);
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

// ===== Google OAuth =====
// Google OAuth login - returns the Google auth URL
router.post('/oauth/login', async (req, res) => {
  try {
    const { provider } = req.body || {};
    if (provider !== 'google') return res.status(400).json({ error: 'Only Google OAuth is supported' });

    const redirectUri = `${process.env.BACKEND_PUBLIC_URL || process.env.FRONTEND_URL}/api/auth/oauth/exchange`;
    const redirectUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline'
    });

    res.json({ url: redirectUrl });
  } catch (err) {
    logger.error('OAuth login error:', err);
    res.status(500).json({ error: 'OAuth initiation failed' });
  }
});

// Google OAuth exchange - exchanges code for user info
router.get('/oauth/exchange', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing authorization code' });

    const redirectUri = `${process.env.BACKEND_PUBLIC_URL || process.env.FRONTEND_URL}/api/auth/oauth/exchange`;

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();

    if (!tokens.id_token) {
      return res.status(400).json({ error: 'Failed to get ID token from Google' });
    }

    // Get user info from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const googleUser = await userRes.json();

    res.json({
      email: googleUser.email,
      name: googleUser.name,
      picture: googleUser.picture,
      provider: 'google'
    });
  } catch (err) {
    logger.error('OAuth exchange error:', err);
    res.status(500).json({ error: 'OAuth exchange failed' });
  }
});

module.exports = router;
