# تقرير اختبار الاختراق الأمني – مشروع EG-PARTS

**التاريخ:** 26 يوليو 2026  
**الأداة:** OpenCode (AI Security Audit)  
**النطاق:** الكود المصدري الكامل للمشروع (محلي)  
**نوع الاختبار:** Static Code Analysis (SAST) + Git History Audit

---

## ملخص تنفيذي

تم العثور على **8 ثغرات أمنية مؤكدة** في الكود المصدري، منها **3 حرجة (Critical)** و **2 عالية (High)** و **2 متوسطة (Medium)** و **1 منخفضة (Low)**.

أخطر ما تم اكتشافه هو **connection string قاعدة بيانات Supabase منشور في 8 ملفات معمول لها git commit** — هذا يعني أن أي شخص يطلع على الـ repository (حتى لو كان خاصاً) يقدر يتصل مباشرة بقاعدة بيانات PostgreSQL ويقرأ/يعدل/يحذف كل البيانات.

---

## فهرس الثغرات

| # | الثغرة | المستوى | الملفات المصابة | الحالة |
|---|--------|---------|-----------------|--------|
| 1 | كلمة سر قاعدة بيانات في git | **🔴 Critical** | 8+ ملفات | مؤكدة |
| 2 | exec_sql RPC في git | **🔴 Critical** | 5+ ملفات | مؤكدة |
| 3 | JWT Secret ضعيف في git | **🔴 Critical** | `gen-token.js` | مؤكدة |
| 4 | مفاتيح Supabase Service Role | **🟠 High** | `server/.env` + ملفات سكريبت | مؤكدة (محلياً) |
| 5 | مفاتيح Cloudflare R2 | **🟠 High** | `test_r2.js` | مؤكدة (محلياً) |
| 6 | مفاتيح API إضافية مسربة | **🟡 Medium** | `.env` + `server/.env` | مؤكدة |
| 7 | QR_ADMIN_PASSWORD ضعيف | **🟡 Medium** | `server/.env` | مؤكدة |
| 8 | Coverage reports في git | **🔵 Low** | `server/coverage/` (50+ ملف) | مؤكدة |

---

## 🔴 حرجة (Critical)

### 1. كلمة سر قاعدة بيانات PostgreSQL منشورة في git

| البند | القيمة |
|-------|--------|
| **الملفات** | `check_constraints.js`, `check_columns.js`, `check_features.js`, `check_foreign_keys.js`, `check_payment_tables.js`, `check_table.js`, `check_triggers.js`, `check_triggers_clean.js` |
| **النوع** | Connection String مباشر |
| **القيمة المكشوفة** | `postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres` |
| **تاريخ الإضافة** | ملفات معمول لها git commit (موجودة في history) |

**الخطر:**  
أي شخص لديه حق الوصول إلى الـ repository يستطيع:
- الاتصال المباشر بقاعدة بيانات Supabase
- قراءة/تعديل/حذف كل الجداول
- الوصول إلى بيانات المستخدمين، المدفوعات، الطلبات، إلخ
- تنزيل كامل قاعدة البيانات

**الإصلاح:**
1. تدوير (Rotate) كلمة سر قاعدة بيانات Supabase فوراً
2. إزالة الملفات من git: `git filter-branch` أو `git rm --cached`
3. استخدام متغيرات البيئة فقط للـ connection strings

---

### 2. exec_sql / execute_sql RPC في git

| البند | القيمة |
|-------|--------|
| **الملفات** | `search.js`, `search_db.js`, `test_db.js`, `server/add_col.js`, `server/apply_migration_payment.js`, `server/test_exec_sql.js` |
| **النوع** | استدعاء supabase.rpc('exec_sql', ...) |
| **المعاملات المُستخدمة** | `sql_string`, `sql_query`, `query` |

**نموذج من الكود (server/add_col.js):**
```js
const res = await supabase.rpc('exec_sql', {
    sql_string: "ALTER TABLE public.stores ADD COLUMN ..."
});
```

**الخطر:**  
- إذا كان هذا الـ RPC لا يزال مفعّلاً في Supabase، يمكن لأي مستخدم (حتى Anonymous) تنفيذ أي أمر SQL
- إنشاء جداول، تعديل بيانات، حذف جداول، إلخ
- تصعيد الصلاحيات داخل قاعدة البيانات

**الإصلاح:**
1. التحقق من وجود RPC في Supabase: `SELECT * FROM pg_proc WHERE proname = 'exec_sql';`
2. حذف الـ RPC فوراً إن وُجد: `DROP FUNCTION IF EXISTS exec_sql;`
3. إزالة ملفات السكريبت من git
4. استخدام Migrations الآمنة (Node.js scripts مع service role key فقط، وليس RPCs عامة)

---

### 3. JWT Secret ضعيف في git

| البند | القيمة |
|-------|--------|
| **الملف** | `gen-token.js` |
| **القيمة** | `'your-secret-key-for-jwt-signing'` |
| **النوع** | Fallback hardcoded في ملف معمول له commit |

**الخطر:**  
- تزوير أي JWT token لأي مستخدم (Admin, Super Admin, إلخ)
- الوصول الكامل إلى النظام بدون صلاحية

**الإصلاح:**
1. تدوير JWT secret في Supabase
2. إزالة أو تعديل ملف `gen-token.js`
3. التأكد من أن الإنتاج لا يستخدم `'your-secret-key-for-jwt-signing'` كـ fallback

---

## 🟠 عالية (High)

### 4. مفاتيح Supabase Service Role

| البند | القيمة |
|-------|--------|
| **الملف** | `server/.env` + مستخدمة في `check_constraints.js` وملفات سكريبت أخرى |
| **النوع** | `SUPABASE_SERVICE_KEY` / `VITE_SUPABASE_ANON_KEY` |
| **ملتزمة في git؟** | `.env` نفسه غير ملتزم، لكن connection string في check_*.js يكشف نفس الصلاحيات |

**الخطر:**  
Service Role key يتجاوز كل قواعد RLS (Row Level Security) في Supabase.

**الإصلاح:**
1. تدوير Service Role key من Supabase Dashboard
2. التأكد من أن Service Key لا يُستخدم أبداً في كود المتصفح (Frontend)
3. استخدام Anon Key فقط في الـ Frontend

---

### 5. مفاتيح Cloudflare R2 مسربة

| البند | القيمة |
|-------|--------|
| **الملف** | `test_r2.js` |
| **القيم المكشوفة** | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| **ملتزمة في git؟** | لا (مغطاة بنمط `test-*.js` في `.gitignore`) |
| **موجودة محلياً؟** | نعم |

**الخطر:**  
- الوصول إلى كل الملفات المرفوعة في Cloudflare R2 (صور المنتجات، مستندات، إلخ)
- رفع ملفات ضارة أو حذف ملفات
- تكاليف غير متوقعة على حساب Cloudflare

**الإصلاح:**
1. تدوير R2 API keys من Cloudflare Dashboard
2. عدم تخزين مفاتيح R2 في ملفات ثابتة محلياً

---

## 🟡 متوسطة (Medium)

### 6. مفاتيح API إضافية مسربة في ملفات `.env`

| المفتاح | الملف | ملتزم في git؟ |
|---------|-------|--------------|
| `SENTRY_AUTH_TOKEN` | `.env` | لا |
| `GEMINI_API_KEY` | `.env` | لا |
| `GOOGLE_CLIENT_SECRET` | `.env` | لا |
| `DATABASE_ENCRYPTION_KEY` | `.env` | لا |
| `TURNSTILE_SECRET_KEY` | `.env` | لا |
| `LICENSE_STORAGE_PASS` | `.env` | لا |

**الخطر:**  
- `DATABASE_ENCRYPTION_KEY` يستخدم لتشفير بيانات الدفع — تسريبه يعني فك تشفير كل معاملات الدفع
- `GOOGLE_CLIENT_SECRET` يُستخدم لـ OAuth — تسريبه يسمح بانتحال هوية المستخدمين
- `GEMINI_API_KEY` يُستخدم في ميزات AI — تسريبه يسبب تكاليف غير متوقعة

**الإصلاح:**
1. تدوير كل المفاتيح المذكورة فوراً
2. التأكد من أن `.env` مضاف في `.gitignore` ولا يمكن دفعه عن طريق الخطأ
3. استخدام secret manager (مثل GitHub Secrets, Doppler, HashiCorp Vault)

---

### 7. كلمة سر لوحة WhatsApp ضعيفة

| البند | القيمة |
|-------|--------|
| **الملف** | `server/.env` |
| **المتغير** | `QR_ADMIN_PASSWORD` |
| **القيمة** | `1234cac1234` |

**الخطر:**  
- كلمة سر سهلة التخمين
- لوحة WhatsApp تتحكم في إرسال رسائل WhatsApp باسم المتجر
- استغلالها يسمح بانتحال هوية المتاجر وإرسال رسائل تصيد (Phishing) للعملاء

**الإصلاح:**
1. تغيير كلمة سر لوحة WhatsApp فوراً
2. استخدام كلمة سر قوية (20+ حرفاً، رموز وأرقام وأحرف كبيرة وصغيرة)
3. إضافة rate limiting على محاولات الدخول للوحة

---

## 🔵 منخفضة (Low)

### 8. Coverage reports وملفات JSON كبيرة في git

| البند | القيمة |
|-------|--------|
| **المجلد** | `server/coverage/` |
| **عدد الملفات** | 50+ معمول لها commit |
| **ملفات JSON أخرى** | `server/dump.json`, `server/dump_utf8.json` |

**الخطر:**  
- تضخيم حجم الـ repository بدون داعٍ
- `dump.json` قد يحتوي على بيانات حساسة من قاعدة البيانات

**الإصلاح:**
1. إضافة `coverage/` إلى `.gitignore`
2. إزالة `coverage/` من git: `git rm -r --cached server/coverage/`
3. مراجعة `dump.json` — إن كان يحتوي بيانات، حذفه من git

---

## ✅ نقاط القوة (ما يعمل بشكل صحيح)

| المجال | الوضع |
|--------|-------|
| **SQL Injection في كود الإنتاج** | 🟢 غير موجود — يستخدم Supabase parameterized queries + Zod validation |
| **Helmet** | 🟢 مفعّل في `server.js` — headers أمنية |
| **CORS** | 🟢 تكوين جيد مع قائمة origins مسموح بها ودعم dynamic custom domains |
| **Rate Limiting** | 🟢 موجود على مسارات حساسة (OTP, Verify, 2FA) |
| **هيكلة تسجيل الدخول** | 🟢 يستخدم OTP عبر الهاتف (بدون كلمة سر تقليدية) — آمن ضد هجمات كلمات السر |
| **Sanitization** | 🟢 Error handler يحذف الحقول الحساسة من logs |
| **.gitignore** | 🟢 يغطي `.env`, `test-*.js`, `check_*.js`, `gen-*.js` — لكن بعض الملفات أضيفت قبل الإضافة |

---

## خطة العمل المقترحة (حسب الأولوية)

### المرحلة 1: فورية (خلال 24 ساعة)
1. **تدوير كلمة سر قاعدة بيانات Supabase** — من Supabase Dashboard → Database Settings
2. **تدوير Service Role Key** — من Supabase Dashboard → API Settings
3. **التأكد من حذف `exec_sql` RPC** — الاتصال بقاعدة البيانات وتنفيذ `DROP FUNCTION IF EXISTS exec_sql`
4. **تدوير JWT Secret** — من Supabase Dashboard → Auth Settings
5. **تغيير QR_ADMIN_PASSWORD** إلى كلمة سر قوية

### المرحلة 2: قصيرة المدى (خلال أسبوع)
6. **تدوير Cloudflare R2 Keys** — من Cloudflare Dashboard → R2 → API Tokens
7. **تدوير DATABASE_ENCRYPTION_KEY** — إعادة تشفير بيانات الدفع
8. **تدوير GOOGLE_CLIENT_SECRET, SENTRY_AUTH_TOKEN, GEMINI_API_KEY, TURNSTILE_SECRET_KEY, LICENSE_STORAGE_PASS**
9. **إزالة الملفات المكشوفة من git history** — استخدام `git filter-branch` أو `BFG Repo-Cleaner`

### المرحلة 3: طويلة المدى (شهر)
10. **إضافة ملفات السكريبت الخطيرة إلى `.gitignore`** بشكل دائم
11. **إزالة `server/coverage/` و `dump.json` من git**
12. **مراجعة أذونات الـ repository** — من لديه حق الوصول؟
13. **تفعيل Secret Scanning** (GitHub Advanced Security أو GitLeaks)
14. **إعداد CI/CD pipeline مع فحص أمني** قبل كل commit

---

## الملفات التي يجب حذفها من git history

```
check_constraints.js
check_columns.js
check_features.js
check_foreign_keys.js
check_payment_tables.js
check_table.js
check_triggers.js
check_triggers_clean.js
search.js
search_db.js
test_db.js
gen-token.js
server/coverage/
server/dump.json
server/dump_utf8.json
```

---

## أدوات مفيدة للفحص المستقبلي

```bash
# فحص كلمات السر في git history
git log --all -p | grep -i "password\|secret\|key"

# استخدام Gitleaks (مُوصى به بشدة)
# قم بتثبيته من https://github.com/gitleaks/gitleaks
gitleaks detect --source . --verbose

# استخدام GitGuardian (خدمة سحابية مجانية للمشاريع مفتوحة المصدر)
```

---

## خريطة حساسية المفاتيح

```
Database Connection String  ──── 🔴 يمكنها تدمير قاعدة البيانات بالكامل
DATABASE_ENCRYPTION_KEY    ──── 🔴 تفك تشفير بيانات الدفع
SUPABASE_SERVICE_KEY       ──── 🔴 تتجاوز كل قواعد RLS
R2 Access Keys             ──── 🟠 الوصول لجميع الملفات المرفوعة
GOOGLE_CLIENT_SECRET       ──── 🟠 انتحال هوية OAuth
SENTRY_AUTH_TOKEN          ──── 🟡 وصول لبيانات الأخطاء和生产
GEMINI_API_KEY             ──── 🟡 استخدام غير مصرح به للـ API (تكاليف)
TURNSTILE_SECRET_KEY       ──── 🟡 تجاوز حماية Turnstile
JWT Secret                 ──── 🔴 تزوير tokens لأي مستخدم
```

---

**تم إعداد التقرير بواسطة:** OpenCode AI Security Audit  
**حالة التقرير:** مكتمل  
**عدد الثغرات:** 8 (3 🔴 حرجة، 2 🟠 عالية، 2 🟡 متوسطة، 1 🔵 منخفضة)
