# middleware/ — دليل الـ Middleware

## ترتيب التنفيذ الإلزامي في server.js

```
كل request يمر بهذا الترتيب:

  blockIP         → هل الـ IP محظور؟
  tenantResolver  → تحديد المتجر من الـ hostname
  [route handler] →
      verifyUser        → التحقق من JWT
      banCheck          → هل المستخدم محظور؟
      verifyPermission  → هل لديه صلاحية؟
      handler           → منطق العمل
```

---

## ملفات الـ Middleware

### `tenantResolver.js`
- **ماذا يفعل:** يحدد المتجر من الـ hostname ويضعه في `req.store`
- **يضيف:** `req.store = { id, subdomain, is_active, ... }`
- **⚠️ لا تعدّله** بدون فهم كامل — يؤثر على كل request
- **استخدام الـ Service Key:** يستخدم `SUPABASE_SERVICE_KEY` لتخطي RLS — هذا مقصود ومحدود لهذا الملف فقط

### `auth.js`
- **ماذا يفعل:** المصدر الوحيد للـ Authorization في المشروع
- **exports:**
  - `verifyUser` → يتحقق من JWT ويضع `req.user`
  - `verifyAdmin` → يتحقق من admin access (استخدم verifyPermission بدلاً منه)
  - `verifyPermission('name')` → **الأساسي — استخدمه دائماً**
  - `optionalAuth` → مثل verifyUser لكن غير إلزامي
  - `attachPermissions` → يضيف `req.permissions` (للاستخدام المتقدم)

### `platformAdmin.js`
- **ماذا يفعل:** خاص بـ routes البلاتفورم `/api/platform/*`
- **exports:**
  - `verifyPlatformAdmin` → super admin only
  - `verifyPlatformPermission('platform.x')` → granular platform permissions

### `banCheck.js`
- **ماذا يفعل:** يتحقق إذا كان المستخدم محظور في المتجر
- **متى يُستخدم:** في routes العمليات الحساسة (الطلبات، الدفع)

### `blockIP.js`
- **ماذا يفعل:** يحجب الـ IPs المحظورة على مستوى المتجر
- **متى يُستخدم:** global — مسجل في server.js

### `impersonation.js`
- **ماذا يفعل:** يكشف إذا كان Super Admin يتنكر كمدير متجر
- **يضيف:** `req.isImpersonated`, `req.impersonatorId`

### `uploadValidator.js`
- **ماذا يفعل:** يتحقق من أنواع وأحجام الملفات المرفوعة

### `errorHandler.js`
- **ماذا يفعل:** يعالج الأخطاء غير المعالجة كـ global handler

### `maintenance.js`
- **ماذا يفعل:** يُعيد 503 إذا كانت المنصة في وضع الصيانة
