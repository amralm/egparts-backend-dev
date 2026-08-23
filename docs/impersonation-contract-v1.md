# العقد النهائي الموحّد لانتحال المتاجر — Impersonation Contract v1.1

> الحالة: مقترح للمراجعة والموافقة — **لم يُنفّذ أي كود بعد**
> v1.1 يدمج تعديلين إلزاميين من المراجعة: (1) منع أي توكن في URL واستبداله بـ one-time handoff code، (2) عمر الجلسة الافتراضي 30 دقيقة بتمديد نشاط وحد أقصى مطلق، مع `last_used_at`.
> v1.1 يضم أيضاً أدلة Database Parity الملتقطة مباشرة من قاعدتي Dev وProduction بتاريخ 2026-08-23، ومواصفة إصلاح N+1 في `/tenants/metrics`.
> النطاق: Backend (`routes/platform.js`, `middleware/`) + Frontend (`StoreContext`, `main.jsx`, `platformImpersonationService`)
> القاعدة الحاكمة: مسار واحد فقط
> `start → issue scoped token → middleware verifies token → resolve tenant → authorize request → audit → revoke/expire`

---

## 0) الواقع الراهن الموثق (لماذا هذا العقد ضروري)

أربعة مسارات متزامنة، لا يعمل منها شيء طرفاً-لطرف:

| # | المسار | الأثر الفعلي |
|---|--------|---------------|
| 1 | REST قديم: `POST /api/platform/impersonate/start|stop` → جدول `impersonation_sessions` | الـ start يفشل دائماً 400 (الواجهة لا ترسل `reason` الإجباري)، ولا يرجع `store` فلا يتم التحويل. وحتى لو نجح: **`middleware/impersonation.js` غير مركّب في `server.js`** — الهيدر يُرسل ولا يقرؤه أحد |
| 2 | REST جديد: `/api/platform/impersonation/start|end|session` → JWT + `impersonation_logs` | JWT نوعه `platform_impersonation` لا يستهلكه أي كود خارج مساراته الثلاثة — لا يوجد وسيط تحقق |
| 3 | RPC قديم في DB: `public.start_impersonation(uuid,text,text)` / `stop_impersonation(uuid)` (SECURITY DEFINER، `frontend/supbase_tabled-and-rows/02_multi_tenant_rls_v3.sql:296`) | بقايا عصر استدعاء Supabase مباشرة من العميل؛ لا يستدعيها الكود الحالي |
| 4 | مفتاح ميت: `localStorage['impersonation_token']` | يُقرأ ويُحذف في `StoreContext.jsx:61,107-133` ولا يضبطه أي `setItem` في المشروع |

انحرافات بنيوية مصاحبة:
- **لا يوجد `CREATE TABLE` لـ `impersonation_sessions` في أي migration موثّق** (فقط إشارات لسياسات وفهارس `impersonation_logs` في `78_consolidate_overlapping_rls.sql`). المخطط خارج التحكم بالإصدارات = Database Drift مثبت.
- ثغرة التصميم في الوسيط القديم: يفحص `is_active` فقط ويتجاهل `expires_at`.
- **تجاوز السوبر أدمن العام**: `resolveStorePermissions` (`middleware/auth.js:37-55`) يمنح أي عضو في `super_admins` كل صلاحيات أي متجر — وهذا يجعل الانتحال زخرفياً ما لم يُعطَّل التجاوز أثناء الجلسة.
- الخادم يعمل بعميل **service-role** (`services/supabase.js:15`) — RLS لا يحمي شيئاً على مسار الـ API؛ التنفيذ الوحيد للصلاحيات هو طبقة الـ middleware. لذلك يجب فرض نطاق المتجر هناك.

---

## 1) كيف تبدأ جلسة الانتحال (Start)

**Endpoint الوحيد:** `POST /api/platform/impersonation/start`

- المصادقة: `verifyPlatformPermission('platform.access')` + `verifyPlatformAdmin` (كما هو اليوم على platform.js) — **ومنع النداء إذا كان الطلب نفسه داخل جلسة انتحال** (`req.isImpersonated → 403`).
- الجسم: `{ store_id: uuid*, reason?: string }`
  - `reason` **اختياري** بقيمة افتراضية `'Platform Admin store access'` (يلغي كسر DRIFT-C1 دون إجبار الواجهة على حقل جديد، والواجهة سترسله فعلياً).
  - التحقق: `store_id` uuid صالح + المتجر موجود وليس محذوفاً (`status !== 'deleted'`) وإلا `404 STORE_NOT_FOUND`.
- الإصدار: توكن معتم (opaque) `crypto.randomBytes(32).toString('hex')` — **يُخزَّن SHA-256 فقط** في عمود جديد `impersonation_sessions.token_hash`. الصيغة الخام تُرجع للعميل مرة واحدة ولا تلمس القرص.
- صف الجلسة: `{ admin_id = req.user.sub, store_id, reason, expires_at = now + 30min, absolute_expires_at = now + 2h, last_used_at = now, ip_address, user_agent, is_active = true }`.
  - **العمر الافتراضي 30 دقيقة** من الإصدار؛ كل استخدام يحمله الوسيط يجدّد `expires_at = now + 30min` (تمديد نشاط) لكن **لا يتجاوز أبداً** `absolute_expires_at` (سقف مطلق ساعتان من الإصدار).
  - الأعمدة الجديدة المطلوبة: `token_hash`, `revoked_at`, `last_used_at`, `absolute_expires_at` (Migration §M-IMP-01).

## 2) ماذا يرجع الـ endpoint (Response Contract)

مغلّف موحّد عبر `sendSuccess`:

```json
{
  "success": true, "code": "OK", "message": "...", "requestId": "...",
  "data": {
    "session_id": "<uuid>",
    "token": "<hex-256 opaque>",
    "token_type": "opaque_session",
    "expires_at": "<ISO>",
    "expires_in": 7200,
    "store": { "id", "name", "subdomain", "custom_domain" }
  }
}
```

- `store` كائن كامل (يصلح كسر التحويل في `StoreContext.jsx:55-58`).
- الأخطاء بأكواد مستقرة: `400 IMPERSONATION_STORE_REQUIRED`، `403 FORBIDDEN_PLATFORM_ACCESS_ONLY`، `403 IMPERSONATION_NESTING_FORBIDDEN`، `404 STORE_NOT_FOUND`، `500 IMPERSONATION_START_FAILED` — كلها بحمولة `{success:false, code, message, requestId}`.

## 3) أين يُحفظ التوكن وكيف ينتقل بين الدومينات (Client Storage + Handoff)

- **`sessionStorage['impersonate_session_token']`** بدل localStorage — إغلاق التبويب ينهي الجلسة ضمنياً، ولا بقية بعد إعادة الفتح.
- **ممنوع منعاً باتاً تمرير session token أو أي توكن انتحال داخل URL query** (يظهر في browser history وسجلات الخادم وCloudflare/Render logs وReferer وأدوات التحليل). المسار المعتمد بدلاً منه — **One-Time Handoff Code**:
  1. Platform Admin (على دومين المنصة) يستدعي `POST /api/platform/impersonation/start` كالمعتاد → يصدر جلسة معلّقة + **handoff code** عشوائي (`crypto.randomBytes(32)` hex) TTL **120 ثانية**، single-use.
  2. الواجهة تفتح رابط المتجر بحمولة محايدة فقط: `https://<store-host>/admin?hoc=<code>` (الكود عديم القيمة بعد أول استبدال أو انتهاء الثوانيتين، ولا يمنح صلاحية بذاته).
  3. صفحة الـ admin على سب دومين المتجر تستدعي `POST /api/platform/impersonation/redeem { handoff_code }` (بتوثيق Bearer الخاص بالسوبر أدمن نفسه) → الخادم يجلب الجلسة بالـ hash، يتحقق من عدم الاستخدام والانتهاء وتطابق `admin_id`، **يعيد ضبط `redeemed_at` فوراً** ثم يرجع `{ token, store, expires_at }`.
  4. التوكن الحقيقي لا يظهر أبداً في أي URL أو log — فقط الكود قصير العمر يمر عبر الرابط، ويُستهلك هشاً (أول redeem يبطل كل المحاولات اللاحقة).
- جدول التخزين: `impersonation_handoff_codes` (جديد في M-IMP-01): `{ code_hash UNIQUE, session_id FK, expires_at, redeemed_at, created_ip }` — يُنظَّف ذاتياً بcron اختياري.
- تسلسل start يعدّل كالتالي: يصدر الصف الجلسة `is_active=true` لكن التوكن الفعلي للعميل لا يُسلَّم إلا بعد `redeem`. (بديل أبسط كان إرجاع التوكن مباشرة للمنصة وتمريره عبر sessionStorage فقط دون تنقل بين الدومينات — مرفوض لأن localStorage غير مشترك بين الدومينات وهذا هو الغرض من handoff أصلاً).

## 4) كيف يُضاف لكل request

- الاسم الحالي يبقى: **`x-impersonate-session: <raw-token>`** (مسموح في CORS allowlist منذ اليوم، ومحقون آلياً في `main.jsx`).
- تعديل وحيد مطلوب في `main.jsx`: القراءة من sessionStorage (مع ترحيل نظيف يحذف أي قيمة localStorage قديمة).
- يُرسَل الهيدر مع كل الطلبات فقط أثناء وجود جلسة نشطة؛ لا يُرسَل أبداً نحو `/api/platform/*` (يحذفه العميل، والخادم يرفضه أيضاً — نقطة 10).

## 5) كيف يقرأه الـ Backend (Middleware)

تركيب واحد: **بعد `tenantResolver` مباشرة** وعلى كل `/api/` عدا `/api/platform` و`/api/blocked` وwebhooks:

```
hash = sha256(header)
row  = impersonation_sessions where token_hash = hash limit 1
401 IMPERSONATION_INVALID   إن لم توجد
401 IMPERSONATION_EXPIRED   إن expires_at <= now  → وإغلاق الصف (is_active=false, ended_at=now)
401 IMPERSONATION_REVOKED   إن revoked_at ليس null أو is_active=false
401 IMPERSONATION_NO_IDENTITY إن لا Bearer صالح (لا يمكن ربط الجلسة بمستخدم)
403 IMPERSONATION_OWNER_MISMATCH إن req.user.sub !== row.admin_id
بعدها: تحميل المتجر من row.store_id → req.store = store (تجاوز قسري لأي x-store-subdomain)
       req.isImpersonated = true
       req.impersonation = { sessionId: row.id, adminId: row.admin_id, storeId: row.store_id }
```

- فشل تحميل المتجر → `404 IMPERSONATION_STORE_GONE` + إغلاق الجلسة.
- عدم وجود الهيدر = مرور طبيعي `next()` (سلوك الوسيط الحالي محافَظ عليه).

## 6) كيف يُفرض store_id على كل query

- المصدر الوحيد لـ `req.store` أثناء الانتحال هو صف الجلسة — **لا يُقبل `x-store-subdomain` ولا `store_subdomain` من الاستعلام** (tenantResolver قد يكون حلّ متجراً من الهيدر؛ الوسيط يكتب فوقه قسراً).
- كل مسارات المستأجر تقرأ `req.store.id` فقط (وهو النمط القائم) — ومنع استخدام `store_id` من جسم العميل للتوسع: قاعدة AGENTS.md القائمة ("Resolve tenant context on the server") تُطبَّق بمراجعة المسارات التي تقبل `store_id` اختيارياً بحيث يتجاهلها عندما `req.isImpersonated`.
- طلبات المنصة (`/api/platform/*`، `/api/health/platform`): أي طلب يحمل هيدر انتحال يُرد فوراً `403 IMPERSONATION_NOT_ALLOWED_ON_PLATFORM` قبل أي منطق آخر.

## 7) التحقق الرباعي: admin_id + expires_at + revoked_at + last_used_at

- `admin_id`: مطابقة إلزامية مع `req.user.sub` من Bearer — الجلسة شخصية وغير قابلة للمشاركة.
- `expires_at`: مفروضة في الوسيط (نقطة 5)، تتجدد بالنشاط (+30min لكل استخدام) حتى سقف `absolute_expires_at` — تسدّ ثغرة DRIFT-H6، مع إغلاق ذاتي للصفوف المنتهية.
- `revoked_at`: عمود جديد (Migration) يضبطه `end`؛ يميز الإبطال اليدوي عن الانتهاء الطبيعي لأغراض التدقيق.
- `last_used_at`: يحدَّث في كل طلب يحمله الوسيط (كتابة خفيفة throttled: مرة/دقيقة كحد أقصى لتجنب كتابة زائدة) — أساس التمديد النشط وللتدقيق الجنائي.
- لا اعتماد على bypass السوبر أدمن أثناء الجلسة (تفصيله في §10).

## 8) تسجيل Audit Events

- **البداية**: صف `impersonation_sessions` + حدث `audit_logs` عبر `auditPlatform(req,'platform.impersonation.start','store',store_id,null,{session_id},...)`.
- **أثناء الجلسة**: كل الكتابات الحساسة تكتب أصلاً في `audit_logs` عبر المسارات القائمة؛ تُضاف وصلة الجلسة داخل الحمولة JSON: `new_values.impersonation_session_id = req.impersonation.sessionId` (تعديل سطر واحد في `auditPlatform` — بلا تغيير مخطط).
- **النهاية/الانتهاء/الإبطال**: أحداث `platform.impersonation.end | .expire | .revoke` مع السبب.
- تحذير أمني عند تضارب الهيدر: `platform.impersonation.header_mismatch` عندما كان `x-store-subdomain` يشير لمتجر غير متجر الجلسة (محاولة تغيير متجر — نقطة 10).

## 9) نهاية الجلسة والإبطال

**Endpoint وحيد:** `POST /api/platform/impersonation/end` بجسم `{ token }` (المصادقة platform كما start):
- `revoked_at = now`, `is_active = false`, `ended_at = now` → أي طلب لاحق بالتوكن يُرد `401 IMPERSONATION_REVOKED`.
- الواجهة: زر «إنهاء جلسة الانتقال» في بانر دائم أعلى لوحة المتجر + تنظيف sessionStorage + العودة لدومين المنصة.
- انتهاء تلقائي: عند أول طلب بعد `expires_at` (إغلاق ذاتي) — وأثر تنظيف دوري اختياري لاحقاً (cron) للصفوف المنتهية أقدم من 30 يوماً.

## 10) منع الوصول لمتجر آخر بتغيير header أو store_id

ثلاث طبقات مستقلة:
1. **الكتابة القسرية**: `req.store` يأتي من صف الجلسة دائماً؛ تغيير `x-store-subdomain` لا يغير شيئاً (وأي تضارب يُسجَّل حدث أمان — §8).
2. **تعطيل bypass السوبر أدمن أثناء الانتحال** (شرط صريح من صاحب القرار):
   - `resolveStorePermissions(userId, storeId, { impersonated })`: عندما `impersonated=true` **يتخطى اختصار `super_admins`** ويرجع مجموعة صلاحيات **متجر الجلسة فقط** (كامل صلاحيات ذلك المتجر — مكافئ owner لهذا المتجر وحده).
   - `verifyPermission(name)` و`verifyPlatformPermission`: أي صلاحية `platform.*` أثناء الانتحال → `403` فوراً.
   - النتيجة: الجلسة تمنح «كل قدرات هذا المتجر» لا «كل قدرات المنصة»، والانتقال لمتجر آخر يتطلب جلسة جديدة صريحة.
3. **رفض الانتشار العكسي**: لا يمكن استخدام توكن انتحال ضد APIs المنصة (§5/§6)، ولا يمكن لجلسة منتهية/ملغاة تجديد نفسها (التوكن المعتم لا يجدد — جلسة جديدة تتطلب start بمصادقة منصة كاملة).

---

## سطح API النهائي بعد الترحيل

| Endpoint | الحالة |
|---|---|
| `POST /api/platform/impersonation/start` | **canonical** (يصدر جلسة معلّقة + handoff code) |
| `POST /api/platform/impersonation/redeem` | **canonical** (استبدال الكود بالتوكن — single-use) |
| `POST /api/platform/impersonation/end` | **canonical** (revoke) |
| `POST /api/platform/impersonate/start` / `stop` | deprecated → حذف بعد نافذة الاستقرار |
| `POST /api/platform/impersonation/session` | deprecated → حذف (لا حاجة للتحقق الخارجي؛ الوسيط يتحقق كل طلب) |
| دوال RPC `start_impersonation` / `stop_impersonation` | deprecated → DROP في migration موثق (مؤكد: صفر مستهلكين في الكود، والفحص الحي 2026-08-23 يوثق تعريفهما SD على البيئتين) |

## متطلبات Database — Migration M-IMP-01 (idempotent + reversible، تُكتب الآن ولا تُطبَّق إلا بعد الموافقة)

**دليل مخطط حي ملتقط 2026-08-23 (قراءة فقط من القاعدتين)**: الأعمدة الفعلية متطابقة بين Dev وProduction:
`impersonation_sessions(id uuid PK DEF, session_token uuid UNIQUE-DEF [خام غير مُهشَّر], store_id uuid NULLABLE, admin_id uuid NULLABLE, reason text NOTNULL, ip_address inet, user_agent text, started_at timestamptz DEF, ended_at timestamptz, expires_at timestamptz NOTNULL, is_active bool DEF)`
— **لا يوجد** `token_hash` ولا `revoked_at` ولا `last_used_at` ولا `absolute_expires_at`. عدّادات: Dev 13 جلسة/16 سجل، Prod 14 جلسة/12 سجل.
فروق مثبتة بين البيئتين: Prod يملك فهارس FK إضافية (`admin_id`, `store_id`, `super_admin_id`) تفتقدها Dev؛ وسياسات RLS **مختلفة كلياً**: Dev sessions = `deny_public_api_*` فقط، Prod sessions = `anon_deny_*` + `service_role_all_*`؛ وDev logs ما زالت تحمل السياسة المكررة `impersonation_logs_admin` رغم أن migration 78 كان يدمجها → **78 غير مطبقة على Dev**. Grants على البيئتين شاملة لـ anon/authenticated حتى TRUNCATE والحماية الفعلية من RLS فقط. دوال SD `start/stop_impersonation` موجودة على البيئتين `search_path=public,pg_temp` وصفر استدعاء في الكود.

```sql
-- ═══ M-IMP-01 UP ═══
BEGIN;

-- 1) أعمدة الجلسة (idempotent)
ALTER TABLE public.impersonation_sessions
  ADD COLUMN IF NOT EXISTS token_hash          text,
  ADD COLUMN IF NOT EXISTS revoked_at          timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at        timestamptz,
  ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz;
UPDATE public.impersonation_sessions SET absolute_expires_at = expires_at WHERE absolute_expires_at IS NULL;

-- 2) فهارس (idempotent؛ IF NOT EXISTS يغطي اختلاف الفهارس بين البيئتين)
CREATE UNIQUE INDEX IF NOT EXISTS ux_imp_sessions_token_hash ON public.impersonation_sessions (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_imp_sessions_store_active ON public.impersonation_sessions (store_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS ix_imp_sessions_admin ON public.impersonation_sessions (admin_id);

-- 3) جدول handoff codes (جديد)
CREATE TABLE IF NOT EXISTS public.impersonation_handoff_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   text NOT NULL UNIQUE,
  session_id  uuid NOT NULL REFERENCES public.impersonation_sessions(id) ON DELETE CASCADE,
  created_ip  inet,
  expires_at  timestamptz NOT NULL,
  redeemed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ix_handoff_session ON public.impersonation_handoff_codes (session_id);
ALTER TABLE public.impersonation_handoff_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_public_api_handoff ON public.impersonation_handoff_codes;
CREATE POLICY deny_public_api_handoff ON public.impersonation_handoff_codes
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- 4) إسقاط الدوال القديمة (مؤكدة عدم الاستخدام — انعكاسها معاد إنشاؤها في DOWN)
DROP FUNCTION IF EXISTS public.start_impersonation(uuid, text, text);
DROP FUNCTION IF EXISTS public.stop_impersonation(uuid);

-- 5) توحيد سياسات logs على الحالة المستهدفة (تطبّق ما تعذّر من 78 على Dev)
DROP POLICY IF EXISTS impersonation_logs_admin ON public.impersonation_logs;

COMMIT;

-- ═══ M-IMP-01 DOWN (تراجع كامل) ═══
-- BEGIN;
-- DROP TABLE IF EXISTS public.impersonation_handoff_codes;
-- DROP INDEX IF EXISTS public.ix_imp_sessions_admin;
-- DROP INDEX IF EXISTS public.ix_imp_sessions_store_active;
-- DROP INDEX IF EXISTS public.ux_imp_sessions_token_hash;
-- ALTER TABLE public.impersonation_sessions
--   DROP COLUMN IF EXISTS absolute_expires_at,
--   DROP COLUMN IF EXISTS last_used_at,
--   DROP COLUMN IF EXISTS revoked_at,
--   DROP COLUMN IF EXISTS token_hash;
-- (إعادة إنشاء الدالتين SD بنصهما الأصلي من frontend/supbase_tabled-and-rows/02_multi_tenant_rls_v3.sql قبل COMMIT)
-- COMMIT;
```

> ملاحظة انتقالية: صفوف الجلسات الـ13/ـ14 التاريخية بلا `token_hash` — تبقى سجلات تدقيق ميتة (is_active=false أو منتهية) ولا تحتاج backfill.
> لا يوجد أي RPC آخر في مسارات المنصة (مؤكد ثابتاً) — فالفحص بعد التطبيق مباشر.

---

## ملحق أ — إصلاح `/tenants/metrics` (N+1 مثبت قياساً)

القياس الحي 2026-08-23 بتوكن Platform Admin حقيقي:
- **Production**: HTTP 200 خلال **4.06s** لسبعة (7) متاجر فقط ≈ 29 استعلام PostgREST تسلسلي (1 + 4×7) — الاختناق زمن roundtrip لكل متجر وليس حجم البيانات (22 طلب شهر، 285 منتج). عند ~50 متجر يتجاوز مهلات البوابة.
- الشكل الحي مطابق للجرد: envelope `{success,data:[...]}` والبيانات array.

المواصفة (M-METRICS-01 — مقترحة، تحتاج موافقة لأنها DB change):
1. دالة SQL واحدة `public.platform_tenant_metrics(p_month_start timestamptz)` SECURITY DEFINER `search_path=public,pg_temp` تعيد GROUP BY واحد: عدد الطلبات ومجموع المبيعات شهرياً، المسلَّمة، عدد المنتجات، واستخدام OTP لكل store — استعلام/CTEs بدل 4×S.
2. المسار يستدعي `.rpc()` واحد + يجمع مع بيانات المتاجر/الاشتراكات (استعلامان إجمالاً).
3. الصفحة (TenantManagement): pagination أو على الأقل `limit/sort`، وحالة timeout صريحة بزر «إعادة المحاولة» مع عرض requestId — **يُمنع تحويل الفشل إلى قائمة فارغة** (سلوك حالي: `Array.isArray(metrics) ? metrics : []`).

## ملحق ب — اكتشاف حرج جديد: نشر Dev معطّل المصادقة بالكامل

قياس 2026-08-23 ضد `https://egparts-backend-dev.onrender.com`:
- جلسة GoTrue حقيقية صادرة من مشروع Dev لحساب سوبر أدمن فعلي → **401 "Invalid token"** ×10.
- جلسة GoTrue حقيقية صادرة من مشروع Production لنفس الحساب → **401 "Invalid token"** أيضاً.
- الجلسة نفسها (Prod) تنجح فوراً ضد `https://egparts-backend.onrender.com` → **200 OK في 4.06s**.

الاستنتاج: خدمة Render المسماة dev تحمل قيم `SUPABASE_JWT_SECRET` / auth config لا تطابق أيٍّ من المشروعين الحاليين (نسختا env المحلية المؤرخة 2026-08-22 متطابقتان مع بعضهما لكن مرفوضتان من الخدمة المنشورة → سر مدوَّر أو إعدادات قديمة). **هذا هو السبب الجذري لرسالة «فشل تحميل بيانات المتاجر» على بيئة التطوير** — فشل مصادقة شامل، وليس cold start (الذي ظهر مع ذلك مرة: أول نداء 31.6s ثم 0.35–0.75s دافئاً).
الإجراء المطلوب قبل P2/E2E: تدقيق متغيرات بيئة خدمة `egparts-backend-dev` على Render (JWT secret + SUPABASE_URL + مفاتيح anon/service) ومواءمتها مع مشروع Dev — لا يمكن تشغيل أي اختبار مصادَق على Dev قبل ذلك.

## خطة الترحيل (بترتيب تنفيذ ملزم — لا حذف Legacy قبل اكتمالها)

1. **P0 — الموافقة على هذه الوثيقة** (لا كود).
2. **P1 — Backend**: ملف Migration M-IMP-01 (غير مطبق) + اختبارات parity لتثبيت DDL الأساس لجدول الجلسات على Dev.
3. **P2 — Backend**: إعادة بناء start/end + تركيب الوسيط + تعطيل bypass أثناء الانتحال + رفض الهيدر على مسارات المنصة. اختبارات إلزامية قبل الخطوة التالية: 200 سعيد، 400 بدون store_id، 401 بلا Bearer، 403 لغير سوبر أدمن، 401 منتهٍ، 401 ملغى، 403 مالك مختلف، 403 هيدر انتحال على /api/platform، 403 محاولة تبديل متجر بالهيدر، وتحديد أن الصلاحيات أثناء الجلسة = صلاحيات المتجر فقط.
4. **P3 — Frontend**: `platformImpersonationService` عبر apiJson (`{store_id, reason}`)، استهلاك `data.store`، sessionStorage، بانر الجلسة، حذف الفرع الميت (`impersonation_token`) واستدعاءات ثلاثي JWT.
5. **P4 — Dev فقط**: E2E بدورَي Platform Admin وStore Admin (بدون انتحال، مع انتحال، محاولة متجر آخر، انتهاء)، ثم فحص Database/RPC parity بالأدوات المضافة (`pg-*`).
6. **P5 — Cleanup**: تعليم المسارات القديمة 410 لمدة راقب، ثم حذفها من commit لاحق بعد نجاح Dev E2E.
7. **Production**: ممنوع في هذه المرحلة كلياً — يتطلب موافقة منفصلة + Backup + dry-run + خطة rollback.

## مصفوفة الاختبار الملزمة (بوابة كل مرحلة)

| الحالة | المتوقع |
|---|---|
| start بدون store_id | 400 |
| start بلا/بتوكن غير سوبر أدمن | 401 / 403 |
| start لمتجر محذوف | 404 |
| طلب مستأجر بهيدر صالح | 200 + req.store = متجر الجلسة |
| تغيير x-store-subdomain أثناء الجلسة | يُتجاهل + حدث header_mismatch |
| توكن منتهٍ / ملغى / مزوّر | 401 IMPERSONATION_* |
| Bearer مختلف عن admin_id | 403 OWNER_MISMATCH |
| نداء /api/platform/* بهيدر انتحال | 403 |
| platform.* permission أثناء الجلسة | 403 |
| صلاحيات متجر آخر أثناء الجلسة | 403 (bypass معطّل) |
| end ثم إعادة استخدام التوكن | 401 REVOKED |
# Implementation status (2026-08-23)

The canonical contract below is now implemented in code for the development
environment only. The active flow is:

`POST /api/platform/impersonation/start` (platform admin) → one-time `hoc`
handoff (120 seconds) → tenant-domain `/api/platform/impersonation/redeem` →
opaque session token stored only in `sessionStorage` →
`x-impersonate-session` on tenant APIs → one middleware-owned tenant context.

The old `/api/platform/impersonate/*` routes, JWT impersonation branch, and
dead `localStorage['impersonation_token']` consumer are no longer runtime
paths. Platform APIs reject a tenant impersonation header, and impersonated
platform administrators receive tenant permissions only; `platform.*`
permissions are denied. The database migration is
`backend/supabase_tabled-and-rows/86_impersonation_contract_v1.sql` and has
not been applied to Production by this workspace.

This is not a Production PASS: Dev runtime authentication and the migration
still require live verification before deployment. Build/lint child-process
checks also require an execution environment where Node can spawn workers.
