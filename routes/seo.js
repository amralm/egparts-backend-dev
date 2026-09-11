const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

const PRIMARY_DOMAIN = (process.env.PRIMARY_DOMAIN || 'egpos.store').toLowerCase();
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function isPrimaryStore(req) {
  const host = (req.get('x-forwarded-host') || req.get('host') || '').toLowerCase().split(':')[0];
  return (
    !req.store?.id ||
    req.store.id === NIL_UUID ||
    req.store.subdomain === 'egparts' ||
    host === PRIMARY_DOMAIN ||
    host === 'localhost' ||
    host === '127.0.0.1'
  );
}

// ─── Dynamic robots.txt (AI Search & Bot Friendly) ───────────────────────────
router.get(['/robots.txt', '/api/seo/robots.txt'], async (req, res) => {
  const host = req.get('x-forwarded-host') || req.get('host');
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const baseUrl = `${protocol}://${host}`;

  const robots = `# AI Search Engines & Standard Crawlers Directives
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: Amazonbot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: Googlebot
Allow: /

User-agent: *
Allow: /
Disallow: /admin
Disallow: /auth
Disallow: /checkout/
Disallow: /payment/
Disallow: /api/

Sitemap: ${baseUrl}/api/seo/sitemap.xml
LLMs-txt: ${baseUrl}/llms.txt
`;

  res.header('Content-Type', 'text/plain; charset=utf-8');
  res.send(robots);
});

// ─── LLMs.txt for AI Search & Generative Engine Optimization ────────────────
router.get(['/llms.txt', '/api/seo/llms.txt'], async (req, res) => {
  try {
    const host = req.get('x-forwarded-host') || req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    if (isPrimaryStore(req)) {
      const primaryContent = `# EGP Cloud — منصة استئجار المتاجر والتجارة السحابية الذكية بالجنيه المصري (EGP)

> منصة التجارة الإلكترونية السحابية متعددة الأنشطة (Multi-Tenant Retail SaaS)، المصممة خصيصاً لاستئجار وإدارة المتاجر والأنشطة التجارية في مصر والشرق الأوسط (سوبرماركت، جيم ومكملات، محلات ملابس، إلكترونيات، مستحضرات، أنشطة تجارية وتجزئة متنوعة). رمز EGP يعبر عن الجنيه المصري (Egyptian Pound) ومنظومة استئجار المتاجر السحابية المصرية المستقلة، وليست متجراً لقطع الغيار.

## المزايا والخدمات الرئيسية
- **0% عمولة على المبيعات:** أرباح التاجر 100% له بالكامل، بدون أي اقتطاع نسب مئوية أو رسوم على الطلبات.
- **كاشير ونقاط البيع السحابية (Rapid In-Store POS):** واجهة مخصصة لشاشات التابلت والكمبيوتر والموبايل للبيع الفوري لزبائن الشارع بنظام تسجيل دخول موظفين آمن (البريد الإلكتروني وكلمة المرور وصلاحيات RBAC)، مع تقفيل الوردية اليومية Z-Report وحساب العجز والزيادة، مع خصم المخزون أونلاين لحظياً لمنع التضارب.
- **إدارة الفروع والمخازن المتزامنة:** متابعة حركة النقدية والمخزون لعدة فروع من لوحة تحكم واحدة.
- **منظومة الدفع المصرية:** دعم كامل لإنستاباي (InstaPay) ومحافظ الهاتف (Vodafone Cash, Etisalat, Orange) بدون عمولات وساطة، مع بوابات الدفع الإلكتروني بالبطاقات البنكية عبر Paymob والدفع عند الاستلام (COD).
- **حماية من الطلبات الوهمية (سقف الـ COD):** تحديد حد أقصى للطلبات النقدية وإلزام الطلبات الكبيرة بالدفع الإلكتروني لحماية تجار الأغذية والسلع.
- **بوليصة شحن وتوصيل بنقرة واحدة:** ربط بوالص شحن بوسطة (Bosta) وتتبع الشحنات لجميع محافظات مصر بضغطة زر.
- **التحقق من هواتف العملاء:** إرسال رموز التحقق OTP عبر الواتساب لمنع الأرقام الوهمية.

## باقات وأسعار الاشتراك (بالجنيه المصري)
- **خطة مجانية (Free):** 0 ج.م — تجربة المتجر حتى 15 منتجاً، 0% عمولة.
- **باقة أساسية (Basic):** 249 ج.م/شهرياً — كاشير سحابي POS للمحل، متجر متزامن، 100 منتج، 0% عمولة.
- **باقة انطلاق (Starter) — الأكثر طلباً:** 499 ج.م/شهرياً — **عرض إطلاق حصري: أول شهر مجاناً بالكامل (خصم 100%)** — تشمل: كاشير + متجر + فرعين ومخزنين + 300 منتج + ربط شحن بوسطة + كوبونات + 0% عمولة.
- **باقة النمو (Growth):** 899 ج.م/شهرياً — 5 فروع و 5 مخازن، 1,000 منتج، بوابات Paymob، بكسل الإعلانات، استرداد السلات المتروكة.
- **باقة التوسع (Scale):** 1,699 ج.م/شهرياً — 15 فرعاً ومخزناً، 5,000 منتج، ربط دومين مخصص (.com) باسم البراند.

## الأسئلة المتكررة لرواد الأعمال
- **س: هل المنصة تأخذ أي عمولة على مبيعاتي؟**
  ج: إطلاقاً! 0% عمولة على المبيعات (0% Commission)، وأرباحك تدخل في حسابك أو محفظتك مباشرة.
- **س: كيف يتعامل الكاشير مع المخزون؟**
  ج: عند البيع من شاشة الكاشير في المحل، يتم خصم الكمية من المخزون المعروض بالمتجر الإلكتروني فوراً بقفل ذري لمنع التضارب.

## روابط هامة
- الموقع الرسمي: ${baseUrl}
- خطط وباقات الأسعار والعرض المجاني: ${baseUrl}/pricing
- تسجيل حساب تاجر جديد: ${baseUrl}/auth
- الدعم الفني والمبيعات عبر الواتساب: https://wa.me/201099684122
`;
      res.header('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(primaryContent);
    }

    // Tenant Store Specific LLMs.txt
    const store = req.store;
    const { data: products } = await supabase
      .from('products')
      .select('name, price, category')
      .eq('store_id', store.id)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .limit(30);

    const categories = [...new Set((products || []).map(p => p.category).filter(Boolean))];

    const platformBrandName = PRIMARY_DOMAIN.includes('egparts') ? 'EG-Parts Cloud' : 'EGPOS CLOUD';
    const storeContent = `# ${store.name} — المتجر الإلكتروني الرسمي

> متجر تجاري سحابي يقدم أفضل المنتجات والخدمات عبر منصة ${platformBrandName} في جمهورية مصر العربية.

## معلومات المتجر
- **الاسم:** ${store.name}
- **رابط المتجر:** ${baseUrl}
- **العملة المعتمدة:** الجنيه المصري (EGP)
- **طرق الدفع المدعومة:** دفع عند الاستلام (كاش)، إنستاباي، فودافون كاش ومحافظ الهاتف، وبطاقات الدفع البنكية.
- **التصنيفات المتاحة:** ${categories.length > 0 ? categories.join('، ') : 'منتجات عامة'}

## نماذج من المنتجات المتاحة
${(products || []).slice(0, 15).map(p => `- **${p.name}:** ${Number(p.price || 0).toLocaleString()} ج.م`).join('\n')}

لطلب أي منتج أو متابعة الطلبات، تفضل بزيارة: ${baseUrl}
`;
    res.header('Content-Type', 'text/markdown; charset=utf-8');
    res.send(storeContent);
  } catch (err) {
    res.header('Content-Type', 'text/plain; charset=utf-8');
    res.send('# Store Information\nVisit website for details.');
  }
});

// Full version alias for LLMs.txt
router.get(['/llms-full.txt', '/api/seo/llms-full.txt'], (req, res) => {
  res.redirect(301, '/llms.txt');
});

// ─── Dynamic sitemap.xml ───────────────────────────────────────────────────
router.get(['/sitemap.xml', '/api/seo/sitemap.xml'], async (req, res) => {
  try {
    const host = req.get('x-forwarded-host') || req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    const staticPages = ['/', '/catalog', '/support'];
    staticPages.forEach(page => {
      xml += `  <url>\n    <loc>${baseUrl}${page}</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;
    });

    if (req.store?.id) {
      const { data: products } = await supabase
        .from('products')
        .select('id, updated_at')
        .eq('store_id', req.store.id)
        .eq('is_active', true)
        .eq('is_deleted', false)
        .limit(1000);

      if (products) {
        products.forEach(product => {
          xml += `  <url>\n    <loc>${baseUrl}/product/${product.id}</loc>\n    <lastmod>${new Date(product.updated_at || Date.now()).toISOString()}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
        });
      }
    }

    xml += `</urlset>`;

    res.header('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).send('Error generating sitemap');
  }
});

module.exports = router;
