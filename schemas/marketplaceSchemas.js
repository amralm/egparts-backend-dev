'use strict';

const { z } = require('zod');

// Safe regex patterns to prevent XSS and code injection
const PATTERNS = {
  DIGITS_ONLY: /^\d{10,25}$/,
  TIKTOK_PIXEL: /^[A-Z0-9]{15,30}$/i,
  GA4_MEASUREMENT_ID: /^G-[A-Z0-9]{8,15}$/i,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  CLEAN_KEY: /^[A-Za-z0-9_\-.:#@=]+$/,
  COUPON_CODE: /^[A-Za-z0-9_-]{3,30}$/
};

const metaPixelConfigSchema = z.object({
  pixel_id: z.string()
    .trim()
    .regex(PATTERNS.DIGITS_ONLY, 'معرّف Meta Pixel يجب أن يتكون من 10 إلى 25 رقماً فقط'),
  access_token: z.string()
    .trim()
    .max(500, 'رمز وصول CAPI طويل جداً')
    .optional()
    .or(z.literal('')),
  test_event_code: z.string()
    .trim()
    .max(50, 'رمز الاختبار يجب ألا يتجاوز 50 حرفاً')
    .optional()
    .or(z.literal(''))
});

const tikTokPixelConfigSchema = z.object({
  pixel_id: z.string()
    .trim()
    .regex(PATTERNS.TIKTOK_PIXEL, 'معرّف TikTok Pixel غير صالح، يجب أن يحتوي على أحرف وأرقام فقط (15-30 حرف)')
});

const ga4ConfigSchema = z.object({
  measurement_id: z.string()
    .trim()
    .regex(PATTERNS.GA4_MEASUREMENT_ID, 'معرّف Google Analytics 4 يجب أن يبدأ بـ G- متبوعاً بكود القياس (مثال: G-XXXXXXXXXX)')
});

const snapchatPixelConfigSchema = z.object({
  pixel_id: z.string()
    .trim()
    .regex(PATTERNS.UUID, 'معرّف Snapchat Pixel يجب أن يكون رمز UUID صالح (مثال: 12345678-1234-1234-1234-123456789abc)')
});

const bostaConfigSchema = z.object({
  api_key: z.string()
    .trim()
    .min(10, 'مفتاح API الخاص ببوسطة مطلوب')
    .max(250, 'مفتاح API طويل جداً'),
  is_test_mode: z.boolean().default(true)
});

const aramexConfigSchema = z.object({
  account_number: z.string().trim().min(1, 'رقم الحساب مطلوب').max(50),
  user_name: z.string().trim().min(1, 'اسم المستخدم مطلوب').max(100),
  password: z.string().trim().min(1, 'كلمة المرور مطلوبة').max(100),
  account_pin: z.string().trim().min(1, 'رمز الأمان مطلوب').max(50),
  account_entity: z.string().trim().min(1, 'كيان الحساب مطلوب').max(20)
});

const metaWhatsAppConfigSchema = z.object({
  phone_number_id: z.string()
    .trim()
    .regex(PATTERNS.DIGITS_ONLY, 'معرّف رقم الهاتف يجب أن يتكون من أرقام فقط'),
  access_token: z.string().trim().min(20, 'رمز وصول Meta مطلوب').max(500),
  waba_id: z.string()
    .trim()
    .regex(PATTERNS.DIGITS_ONLY, 'معرّف حساب واتساب للأعمال (WABA ID) يجب أن يتكون من أرقام فقط')
});

const cartRecoveryConfigSchema = z.object({
  delay_minutes: z.number().int().min(5, 'أقل وقت للتذكير هو 5 دقائق').max(1440, 'أقصى وقت للتذكير هو 24 ساعة (1440 دقيقة)'),
  discount_code: z.string()
    .trim()
    .regex(PATTERNS.COUPON_CODE, 'كود الخصم يجب أن يحتوي على أحرف إنجليزية وأرقام فقط')
    .optional()
    .or(z.literal(''))
});

const paymentGatewaysConfigSchema = z.object({
  api_key: z.string().trim().min(10, 'مفتاح Paymob API مطلوب').max(500),
  integration_id: z.string().trim().min(1, 'معرّف Integration ID مطلوب').max(50),
  iframe_id: z.string().trim().min(1, 'معرّف Iframe ID مطلوب').max(50),
  hmac_secret: z.string().trim().min(10, 'مفتاح Paymob HMAC Secret مطلوب لتأمين المعاملات من التزوير').max(500)
});

const APP_CONFIG_SCHEMAS = {
  'meta-pixel': metaPixelConfigSchema,
  'tiktok-pixel': tikTokPixelConfigSchema,
  'google-analytics': ga4ConfigSchema,
  'snapchat-pixel': snapchatPixelConfigSchema,
  'bosta-shipping': bostaConfigSchema,
  'aramex-shipping': aramexConfigSchema,
  'meta-whatsapp': metaWhatsAppConfigSchema,
  'cart-recovery': cartRecoveryConfigSchema,
  'payment-gateways': paymentGatewaysConfigSchema
};

/**
 * Validates configuration payload against the app schema
 */
function validateAppConfig(slug, payload) {
  const schema = APP_CONFIG_SCHEMAS[slug];
  if (!schema) {
    // Generic safe sanitizer: ensures no dangerous characters like <script>
    if (typeof payload !== 'object' || payload === null) {
      return { success: false, error: 'بيانات التكوين يجب أن تكون كائناً صالحاً' };
    }
    const jsonStr = JSON.stringify(payload);
    if (/<script|javascript:|onerror=|onload=/i.test(jsonStr)) {
      return { success: false, error: 'تم اكتشاف محتوى غير آمن في الإعدادات' };
    }
    return { success: true, data: payload };
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    const firstError = result.error?.issues?.[0]?.message || result.error?.errors?.[0]?.message || 'بيانات التكوين غير صحيحة';
    return { success: false, error: firstError };
  }
  return { success: true, data: result.data };
}

module.exports = {
  validateAppConfig,
  APP_CONFIG_SCHEMAS
};
