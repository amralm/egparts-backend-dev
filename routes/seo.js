const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

const PRIMARY_DOMAIN = (process.env.PRIMARY_DOMAIN || 'egparts.store').toLowerCase();
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function isPrimaryStore(req) {
  const host = (req.get('host') || '').toLowerCase().split(':')[0];
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
  const host = req.get('host');
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
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    if (isPrimaryStore(req)) {
      const primaryContent = `# EG-Parts Cloud — منصة المتاجر والتجارة السحابية الذكية

> منصة التجارة الإلكترونية السحابية متعددة الأنشطة (Multi-Tenant Retail SaaS)، المصممة خصيصاً للمتاجر والأنشطة التجارية في مصر والشرق الأوسط (سوبرماركت، جيم ومكملات، محلات ملابس، إلكترونيات، قطع غيار).

## المزايا والخدمات الرئيسية
- **المتجر الإلكتروني فائق السرعة:** متجر جاهز في دقائق مع دعم الدومينات المخصصة وشهادات SSL مجانية.
- **منظومة الدفع المصرية الأصيلة:** دعم كامل لإنستاباي (InstaPay QR) ومحافظ الهاتف (Vodafone Cash, Etisalat Cash, Orange Cash) بدون عمولات باهظة، مع بوابات الدفع الإلكتروني بالبطاقات البنكية عبر Paymob والدفع عند الاستلام (COD).
- **كاشير ونقاط البيع السريعة (Rapid In-Store POS):** واجهة مخصصة لشاشات التابلت واللمس بالمحل للبيع الفوري لزبائن الشارع، مع خصم المخزون أونلاين لحظياً ومنع التضارب.
- **تحديد الموقع التلقائي (GPS Reverse Geocoding):** يحدد العميل موقعه بضغطة زر ويتم تضمين رابط خرائط جوجل في بوليصة الشحن.
- **بوليصة شحن وتوصيل بنقرة واحدة:** تجهيز وطباعة فواتير التسليم وإشعارات الاستلام فوراً لطياري الدليفري وشركات الشحن (Bosta, Oto).
- **إشعارات وحملات الواتساب:** إرسال تحديثات الطلبات ورموز التحقق OTP عبر حوض الواتساب الذكي.

## باقات وأسعار الاشتراك (بالجنيه المصري)
- **خطة مجانية (Free):** 0 ج.م — تجربة المتجر حتى 15 منتجاً.
- **باقة أساسية (Basic):** 249 ج.م/شهرياً — دعم كامل للمنتجات وإدارة الطلبات.
- **باقة انطلاق (Starter):** 499 ج.م/شهرياً — حتى 500 منتج مع دعم المحافظ الإلكترونية والكوبونات.
- **باقة النمو (Growth):** 899 ج.م/شهرياً — بوابات فيزا Paymob، دومين مخصص، وحملات واتساب.
- **باقة التوسع (Scale):** 1,699 ج.م/شهرياً — فروع متعددة، نقاط بيع POS غير محدودة، ومخزون متقدم.

## الأسئلة المتكررة لرواد الأعمال
- **س: هل المنصة مناسبة لأي محل في الشارع؟**
  ج: نعم، المنصة عامة ومرنة تماماً (Multi-Niche) وتناسب السوبرماركت، الجيم، العطارة، الملابس، والمطاعم.
- **س: أين تذهب أموال مبيعات التاجر؟**
  ج: مباشرة إلى محفظة التاجر (إنستاباي أو فودافون كاش أو حسابه البنكي) فور التحويل، دون أي وساطة أو اقتطاع عمولات من المبيعات.
- **س: كيف يتعامل الكاشير مع المخزون؟**
  ج: عند البيع من شاشة الكاشير في المحل، يتم خصم الكمية من المخزون المعروض بالمتجر الإلكتروني فوراً بقفل ذري لقاعدة البيانات.

## روابط هامة
- الموقع الرسمي: ${baseUrl}
- خطط وباقات الاشتراك: ${baseUrl}/admin
- الدعم الفني: support@egparts.com
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

    const storeContent = `# ${store.name} — المتجر الإلكتروني الرسمي

> متجر تجاري سحابي يقدم أفضل المنتجات والخدمات عبر منصة EG-Parts Cloud في جمهورية مصر العربية.

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
    const host = req.get('host');
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
