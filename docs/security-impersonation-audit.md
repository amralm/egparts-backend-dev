# Security Audit — Canonical Impersonation Contract
**نطاق التدقيق:** سطح الهجوم المُضاف بتطبيق عقد الانتحال الموحّد (start/handoff/redeem/middleware/guards/banner)
**Commit تحت التدقيق:** backend `1028b21` · frontend `cc8a4b2` (+7963cff)
**التاريخ:** 2026-08-23 · **المنهجية:** قراءة كود ساكنة + probes حية على الإنتاج + إعادة استخدام مصفوفات E2E (19/19 انتحال، 22/22 دورة حياة)

---

## ضوابط مُتحقق من إلزامها فعلياً (مع الدليل)

| # | الضابط | الدليل |
|---|--------|--------|
| 1 | توكن معتم 256-bit، يُخزَّن **SHA-256 hash فقط** (`token_hash` unique partial index) | migration 86 + E2E «session token stored as sha256 only» ✓ |
| 2 | Handoff code: TTL 120 ثانية، **single-use ذرياً** (UPDATE … IS used_at NULL)، hash فقط في `impersonation_handoff_codes` | E2E: expired→401، replay→409 ✓ + فحص الكود routes/auth.js:1830-1845 |
| 3 | فرض ثلاثي `expires_at / absolute_expires_at / revoked_at` + إغلاق ذاتي للمنتهي | middleware/impersonation.js:37-62 + E2E expired/replayed → 401 ✓ |
| 4 | ربط الهوية: Bearer sub ≠ session.admin_id → 403 OWNER_MISMATCH؛ بلا Bearer يُسمح بالامتلاك فقط (possession-based، مقصود لتجاوز حاجز الدومينات) | E2E owner-mismatch PASS ✓ |
| 5 | **العزل بين المتاجر**: `req.store` يُفرض من صف الجلسة مهما تغيّر `x-store-subdomain`؛ تضارب الهيدر لا يسرب شيئاً | E2E hostile-header PASS ✓ + curl prod |
| 6 | **رفض النفاذ للمنصة أثناء الانتحال**: أي `/api/platform/*` بهيدر انتحال → 403 `IMPERSONATION_PLATFORM_SCOPE` (routes/platform.js:187) | **probe حي على الإنتاج**: fake-header على /platform/stores و /impersonation/start → 403 ✓ بينما بدونه 200 ✓ |
| 7 | **تعطيل bypass السوبر أدمن أثناء الجلسة**: صلاحيات = كل صلاحيات متجر الجلسة فقط ناقص `platform.*`؛ وأي صلاحية platform.* أثناء الانتحال → 403 (middleware/auth.js:279) | مراجعة كود diff c5ab843 + E2E dev |
| 8 | تعليق المتجر ما زال مفروضاً على المدير المنتحل | متصفحاً: متجر هاري المعلّق أظهر شاشة التعليق رغم جلسة صالحة ✓ |
| 9 | لا تسريب أسرار في السجلات: لا توكن/كود يُطبع في مسارات الانتحال | grep شامل نظيف ✓ (سطر OTP DEV MODE فقط داخل dev_mode) |
| 10 | redeem/end/session خلف limiter موحّد 30/15min برسالة 429 مطبوعة | routes/platform.js:96-104,1853,1907,1932 ✓ |

## الثغرات التي أُغلقت خلال هذا التدقيق

| الخطورة | الثغرة | الإصلاح (commit) |
|---|---|---|
| CRITICAL | `validate-admin` بدون استيراد `verifyBearerToken` → ReferenceError → **حجب كل المدراء من بوابة الإنتاج** | 584a661 (منشور، مؤكد حياً: دخول amralm405 عبر password-grant → 200 isAuthorized:true) |
| HIGH | إلغاء تحويل handoff بواسطة reload فوري بعد ضبط href → زر «إدارة المتجر» يعيد التحميل بصمت | frontend cc8a4b2→7963cff (متحقق: نقرة حية على egparts.store ⇒ qorvix dashboard + banner) |
| MEDIUM | `/impersonation/start` بلا limiter (burst 6×200 مثبت) — نمو جداول غير محدود | 1028b21 ✓ |
| HIGH(تاريخية) | فقدان audit صامت منذ يوليو (correlation_id ليس uuid) + FK violation في end-audit | fbc705b ✓ |

## نتائج مفتوحة (غير قابلة للإغلاق من الكود وحده)

| الخطورة | البند | الإجراء المطلوب |
|---|---|---|
| MEDIUM | خدمة Render **dev** كانت متوقفة عند كود أقدم (استطلاع 24×401) ثم عادت بعد مزامنة البيئة؛ راقبها | تفعيل Auto-deploy رسمياً + Manual Deploy عند الشك |
| LOW | لا توجد مهمة تنظيف دورية لصفوف `impersonation_handoff_codes`/الجلسات المنتهية (نمو بطيء) | cron حذف ما مضى عليه 30 يوماً (ملف migration لاحق) |
| LOW (مقبول موثق) | مرور handoff code في URL لمدة ≤120 ثانية قبل الاستهلاك (history/logs) | مخفف: single-use + hash-only + استهلاك هش؛ تعزيز اختياري لاحقاً: ربط IP/UA |
| INFO | XSS يظل قادراً على قراءة sessionStorage كأي تطبيق SPA | CSP صارمة + دورة حياة قصيرة + revoke فوري موجودة |

## نموذج التهديد السريع (ما الذي يحمي ماذا)

- **سرقة التوكن من جهاز المستخدم**: صلاحية محدودة بمتجر واحد، 30 دقيقة نشاط/ساعتين سقف، revoke فوري من البانر.
- **تخمين/تصنيع التوكن أو الكود**: 256-bit عشوائي + تخزين hash فقط → غير عملي.
- **تزوير ترويسة x-impersonate-session**: بلا توكن حقيقي → 401 fail-closed (E2E forged→401).
- **مسؤول منتجَين يهاجم متجراً ثالثاً أثناء الانتحال**: header override يُتجاهل + platform.* مرفوضة + bypass السوبر معطّل → 403.
- **إغراق النقاط**: limiter على start/redeem/end/session (30/15min).

## خارج نطاق هذا التدقيق
تدقيق المنصة الكامل (RLS الشامل، بقية الوحدات)، اختبار حل WhatsApp OTP الحقيقي (يتطلب إقران جهاز)، واختبار UI تفاعلي بحساب Tenant Owner حقيقي على الإنتاج.
