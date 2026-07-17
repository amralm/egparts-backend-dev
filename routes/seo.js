const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

// Dynamic robots.txt
router.get('/robots.txt', async (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const sitemapUrl = `${protocol}://${host}/api/seo/sitemap.xml`;

  let content = `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}`;
  
  res.header('Content-Type', 'text/plain');
  res.send(content);
});

// Dynamic sitemap.xml
router.get('/sitemap.xml', async (req, res) => {
  try {
    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    // 1. Add Home and Static Pages
    const staticPages = ['/', '/products', '/cart'];
    staticPages.forEach(page => {
      xml += `  <url>\n    <loc>${baseUrl}${page}</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;
    });

    // 2. Add Dynamic Product Pages (Only Public/Active Products)
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, updated_at, store_id');

    if (!productsError && products) {
      products.forEach(product => {
        xml += `  <url>\n    <loc>${baseUrl}/product/${product.id}</loc>\n    <lastmod>${new Date(product.updated_at).toISOString()}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
      });
    }

    // 3. Add Store Pages
    const { data: stores, error: storesError } = await supabase
      .from('stores')
      .select('id, created_at');

    if (!storesError && stores) {
      stores.forEach(store => {
        xml += `  <url>\n    <loc>${baseUrl}/store/${store.id}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
      });
    }

    xml += `</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).send('Error generating sitemap');
  }
});

module.exports = router;
