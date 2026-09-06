-- ==============================================================================
-- Migration 99: App Marketplace & Integrations Seed
-- Adds metadata columns to platform_apps and populates curated built-in apps
-- ==============================================================================

-- 1. Enhance platform_apps schema
ALTER TABLE public.platform_apps
  ADD COLUMN IF NOT EXISTS slug text UNIQUE,
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'marketing',
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS badge text,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS config_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2. Enhance store_apps schema
ALTER TABLE public.store_apps
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_platform_apps_slug ON public.platform_apps (slug);
CREATE INDEX IF NOT EXISTS idx_platform_apps_category ON public.platform_apps (category);
CREATE INDEX IF NOT EXISTS idx_store_apps_store_active ON public.store_apps (store_id, is_active);

-- 3. Upsert Curated Built-in Apps
INSERT INTO public.platform_apps (
  id,
  name,
  slug,
  category,
  description,
  developer,
  api_key_required,
  icon,
  badge,
  sort_order,
  config_schema
)
VALUES
  (
    '10000000-0000-0000-0000-000000000001'::uuid,
    'Meta Pixel & CAPI',
    'meta-pixel',
    'marketing',
    'تتبع زوار متجرك وقياس مبيعات حملات فيسبوك وإنستغرام بدقة متناهية مع دعم Conversions API لتعويض حظر ملفات الارتباط.',
    'Meta / Facebook',
    true,
    'campaign',
    'الأكثر استخداماً',
    10,
    '{
      "fields": [
        {"key": "pixel_id", "label": "معرّف البكسل (Pixel ID)", "type": "text", "placeholder": "مثال: 123456789012345", "required": true, "help": "أدخل المعرّف الرقمي المكون من 10 إلى 20 رقماً من Facebook Events Manager."},
        {"key": "access_token", "label": "رمز وصول CAPI (اختياري)", "type": "password", "placeholder": "EAA...", "required": false, "help": "رمز التحويلات البرمجية من Meta لربط الخادم المباشر."},
        {"key": "test_event_code", "label": "رمز اختبار الأحداث (اختياري)", "type": "text", "placeholder": "TEST12345", "required": false, "help": "يُستخدم فقط أثناء فحص الأحداث في وضع الاختبار داخل Events Manager."}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000002'::uuid,
    'TikTok Pixel',
    'tiktok-pixel',
    'marketing',
    'اربط بكسل تيك توك لتتبع المبيعات والتحويلات الإعلانية وتحسين أداء حملاتك على منصة TikTok For Business.',
    'TikTok',
    true,
    'smart_display',
    'رائج',
    20,
    '{
      "fields": [
        {"key": "pixel_id", "label": "معرّف بكسل تيك توك (Pixel ID)", "type": "text", "placeholder": "مثال: C6123456789ABCDEF00", "required": true, "help": "رمز البكسل المكون من أحرف وأرقام من TikTok Ads Manager."}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000003'::uuid,
    'Google Analytics 4',
    'google-analytics',
    'marketing',
    'تحليلات شاملة لرحلة العميل ومصادر الزيارات وسلوك الشراء وسلات التسوق عبر منصة Google Analytics الرسمية.',
    'Google',
    true,
    'analytics',
    'أساسي',
    30,
    '{
      "fields": [
        {"key": "measurement_id", "label": "معرّف القياس (Measurement ID)", "type": "text", "placeholder": "مثال: G-XXXXXXXXXX", "required": true, "help": "المعرّف الذي يبدأ بـ G- من لوحة تحكم Google Analytics 4."}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000004'::uuid,
    'Snapchat Pixel',
    'snapchat-pixel',
    'marketing',
    'تتبع تفاعل عملاء سناب شات مع منتجات متجرك وقياس العائد على الإنفاق الإعلاني (ROAS) لحملات سناب شات.',
    'Snapchat',
    true,
    'photo_camera',
    'موصى به',
    40,
    '{
      "fields": [
        {"key": "pixel_id", "label": "معرّف بكسل سناب شات (Pixel ID)", "type": "text", "placeholder": "مثال: 12345678-1234-1234-1234-123456789abc", "required": true, "help": "رمز الـ UUID الخاص بالبكسل من Snap Ads Manager."}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000005'::uuid,
    'بوسطة (Bosta Shipping)',
    'bosta-shipping',
    'shipping',
    'إنشاء بوالص الشحن تلقائياً لشركة بوسطة بنقرة زر من تفاصيل الطلب، ومزامنة حالات التوصيل وتتبع الشحنات لحظياً.',
    'Bosta Logistics',
    true,
    'local_shipping',
    'ربط مباشر',
    50,
    '{
      "fields": [
        {"key": "api_key", "label": "مفتاح API الخاص ببوسطة", "type": "password", "placeholder": "bosta_live_...", "required": true, "help": "احصل عليه من حسابك التجاري في لوحة Bosta Business."},
        {"key": "is_test_mode", "label": "وضع التجربة والبيئة الاختبارية (Sandbox)", "type": "boolean", "default": true, "required": false}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000006'::uuid,
    'أرامكس (Aramex)',
    'aramex-shipping',
    'shipping',
    'توصيل سريع محلي ودولي، إصدار بوالص الشحن، وإدارة الاستلام من مقر التاجر عبر شبكة أرامكس العالمية.',
    'Aramex Global',
    true,
    'flight_takeoff',
    'شحن دولي',
    60,
    '{
      "fields": [
        {"key": "account_number", "label": "رقم الحساب (Account Number)", "type": "text", "placeholder": "مثال: 123456", "required": true},
        {"key": "user_name", "label": "اسم المستخدم (Username)", "type": "text", "placeholder": "user@domain.com", "required": true},
        {"key": "password", "label": "كلمة المرور (Password)", "type": "password", "placeholder": "••••••••", "required": true},
        {"key": "account_pin", "label": "رمز الأمان (Account PIN)", "type": "password", "placeholder": "••••", "required": true},
        {"key": "account_entity", "label": "كيان الحساب (Entity)", "type": "text", "placeholder": "CAI", "required": true}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000007'::uuid,
    'واتساب كلاود (Meta Cloud API)',
    'meta-whatsapp',
    'sales',
    'إرسال إشعارات فورية للعملاء برقم موثق بعلامة خضراء عبر منصة Meta الرسمية لتأكيد الطلبات والشحن.',
    'Meta Business',
    true,
    'chat',
    'موثق',
    70,
    '{
      "fields": [
        {"key": "phone_number_id", "label": "Phone Number ID", "type": "text", "required": true},
        {"key": "access_token", "label": "System User Access Token", "type": "password", "required": true},
        {"key": "waba_id", "label": "WhatsApp Business Account ID", "type": "text", "required": true}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000008'::uuid,
    'استعادة السلات المتروكة (Cart Recovery)',
    'cart-recovery',
    'sales',
    'استعد حتى 25% من المبيعات الضائعة عبر إرسال رسائل تذكير تلقائية ومجدولة عبر الواتساب للعملاء الذين لم يكملوا الشراء.',
    'EG-PARTS Cloud',
    false,
    'shopping_cart_checkout',
    'زيادة مبيعات',
    80,
    '{
      "fields": [
        {"key": "delay_minutes", "label": "وقت الانتظار قبل التذكير (بالدقائق)", "type": "number", "default": 30, "required": true},
        {"key": "discount_code", "label": "كوبون خصم تشجيعي (اختياري)", "type": "text", "placeholder": "SAVE10", "required": false}
      ]
    }'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000009'::uuid,
    'بوابات الدفع الإلكتروني (Paymob & Wallets)',
    'payment-gateways',
    'payments',
    'تحصيل المدفوعات عبر البطاقات البنكية، فودافون كاش، محافظ الهاتف المحمول، وخدمة إنستاباي بنقرة واحدة.',
    'Paymob / Gateways',
    true,
    'payments',
    'دفع فوري',
    90,
    '{
      "fields": [
        {"key": "api_key", "label": "Paymob API Key", "type": "password", "placeholder": "ZXlKaGJHY2lPaUpJVXpVN...", "required": true, "help": "احصل عليه من حسابك في Paymob Dashboard -> Settings."},
        {"key": "integration_id", "label": "Card Integration ID", "type": "text", "placeholder": "مثال: 123456", "required": true, "help": "معرف التكامل الخاص ببطاقات الفيزا والماستركارد."},
        {"key": "iframe_id", "label": "Iframe ID", "type": "text", "placeholder": "مثال: 789101", "required": true, "help": "معرف الـ Iframe المخصص لعرض نموذج الدفع."},
        {"key": "hmac_secret", "label": "Paymob HMAC Secret (حماية المعاملات)", "type": "password", "placeholder": "A4B7C9...", "required": true, "help": "ضروري جداً: يمنع تزوير إشعارات الدفع والتأكد من صحة العمليات البنكية."}
      ]
    }'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  developer = EXCLUDED.developer,
  api_key_required = EXCLUDED.api_key_required,
  icon = EXCLUDED.icon,
  badge = EXCLUDED.badge,
  sort_order = EXCLUDED.sort_order,
  config_schema = EXCLUDED.config_schema,
  is_active = EXCLUDED.is_active,
  updated_at = now();
