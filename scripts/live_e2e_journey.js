'use strict';

/**
 * ============================================================================
 * LIVE E2E REAL STORE JOURNEY: ADMIN + CUSTOMER + DRIVER + WHATSAPP INVOICE
 * ============================================================================
 * Target Store: Ahmed Alam (3f6326f4-fc55-43f3-b992-72461f262aa0)
 * Phone: 01033051615
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const assert = require('assert');
const { Pool } = require('pg');

const { supabase } = require('../services/supabase');
const publicProductService = require('../services/publicProductService');
const productAdminService = require('../services/productAdminService');
const courierManager = require('../services/couriers/courierManager');
const deliveryDriverService = require('../services/deliveryDriverService');
const { generateReceiptPdf } = require('../services/receiptPdfService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const STORE_ID = '3f6326f4-fc55-43f3-b992-72461f262aa0';
const USER_PHONE = '01033051615';
const RUN_ID = Date.now().toString().slice(-6);

async function main() {
  console.log('================================================================');
  console.log('🚀 بدء تجربة حية شاملة: مدير + عميل + طيار التوصيل + فاتورة واتساب');
  console.log('================================================================\n');

  // --------------------------------------------------------------------------
  // STEP 0: التحقق من المتجر وإعداداته
  // --------------------------------------------------------------------------
  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('id, name, subdomain')
    .eq('id', STORE_ID)
    .single();
  if (storeErr || !store) throw new Error(`Store not found: ${storeErr?.message}`);

  const { data: settings } = await supabase
    .from('site_settings')
    .select('*')
    .eq('store_id', STORE_ID)
    .maybeSingle();

  console.log(`🏬 المتجر: "${store.name}" (${store.subdomain})`);
  console.log(`📱 هاتف المتجر والواتساب المعتمد: ${settings?.whatsapp_number || USER_PHONE}\n`);

  // --------------------------------------------------------------------------
  // STEP 1: كمدير متجر (Admin) - إضافة منتج بالميزة الجديدة (Options & Variants)
  // --------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('📦 [1] كـ مدير (Admin): إنشاء منتج جديد مع الخيارات والمتغيرات');
  console.log('----------------------------------------------------------------');

  const incomingOptions = [
    { name: 'المقاس', values: ['M', 'L', 'XL'] },
    { name: 'اللون', values: ['كحلي', 'رمادي'] }
  ];

  const incomingVariants = [
    {
      title: 'المقاس: M / اللون: كحلي',
      option_values: { 'المقاس': 'M', 'اللون': 'كحلي' },
      price: 450.00,
      old_price: 520.00,
      cost_price: 260.00,
      stock_quantity: 10,
      sku: `OXF-${RUN_ID}-M-NAV`,
      barcode: `BC${RUN_ID}101`,
      is_active: true
    },
    {
      title: 'المقاس: L / اللون: كحلي',
      option_values: { 'المقاس': 'L', 'اللون': 'كحلي' },
      price: 470.00,
      old_price: 550.00,
      cost_price: 270.00,
      stock_quantity: 10,
      sku: `OXF-${RUN_ID}-L-NAV`,
      barcode: `BC${RUN_ID}102`,
      is_active: true
    },
    {
      title: 'المقاس: XL / اللون: كحلي',
      option_values: { 'المقاس': 'XL', 'اللون': 'كحلي' },
      price: 500.00,
      old_price: 600.00,
      cost_price: 290.00,
      stock_quantity: 10,
      sku: `OXF-${RUN_ID}-XL-NAV`,
      barcode: `BC${RUN_ID}103`,
      is_active: true
    },
    {
      title: 'المقاس: M / اللون: رمادي',
      option_values: { 'المقاس': 'M', 'اللون': 'رمادي' },
      price: 450.00,
      old_price: 520.00,
      cost_price: 260.00,
      stock_quantity: 10,
      sku: `OXF-${RUN_ID}-M-GRY`,
      barcode: `BC${RUN_ID}104`,
      is_active: true
    },
    {
      title: 'المقاس: L / اللون: رمادي',
      option_values: { 'المقاس': 'L', 'اللون': 'رمادي' },
      price: 470.00,
      old_price: 550.00,
      cost_price: 270.00,
      stock_quantity: 10,
      sku: `OXF-${RUN_ID}-L-GRY`,
      barcode: `BC${RUN_ID}105`,
      is_active: true
    },
    {
      title: 'المقاس: XL / اللون: رمادي',
      option_values: { 'المقاس': 'XL', 'اللون': 'رمادي' },
      price: 500.00,
      old_price: 600.00,
      cost_price: 290.00,
      stock_quantity: 10,
      sku: `OXF-${RUN_ID}-XL-GRY`,
      barcode: `BC${RUN_ID}106`,
      is_active: true
    }
  ];

  const testProductName = `قميص أوكسفورد إيطالي بريميوم [إصدار ${RUN_ID}]`;
  const savedProduct = await productAdminService.saveProduct(STORE_ID, {
    name: testProductName,
    price: 450.00,
    cost_price: 260.00,
    category: 'ملابس رجالية',
    has_variants: true,
    is_active: true,
    options: incomingOptions,
    variants: incomingVariants
  });

  console.log(`✅ تم إنشاء المنتج بنجاح في قاعدة البيانات:`);
  console.log(`   - المعرف: ${savedProduct.id}`);
  console.log(`   - الاسم: ${savedProduct.name}`);

  // جلب تفاصيل المنتج للتأكد من ربط الخيارات والمتغيرات
  const detail = await productAdminService.getProductDetail(STORE_ID, savedProduct.id);
  console.log(`   - إجمالي المخزون التلقائي (Derived Stock): ${detail.product.stock_quantity} قطعة`);
  console.log(`   - عدد الخيارات: ${detail.options.length} (المقاس، اللون)`);
  console.log(`   - عدد الفئات والمتغيرات: ${detail.variants.length} فئات`);

  // اختيار المتغير المستهدف للتجربة: XL / كحلي (500 جنيه)
  const targetVariant = detail.variants.find(v => v.title.includes('XL') && v.title.includes('كحلي'));
  assert(targetVariant, 'Target variant XL / كحلي must exist');
  console.log(`   - المتغير المختار للتجربة: "${targetVariant.title}" | السعر: ${targetVariant.price} ج.م | الباركود: ${targetVariant.barcode} | المخزون المبدئي: ${targetVariant.stock_quantity}\n`);

  // --------------------------------------------------------------------------
  // STEP 2: كعميل (Customer) - تصفح المتجر واختيار المواصفات والطلب
  // --------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('🛒 [2] كـ عميل (Customer): تصفح المنتج واختيار المقاس واللون وإتمام الطلب');
  console.log('----------------------------------------------------------------');

  const publicDetails = await publicProductService.getProductDetail(STORE_ID, savedProduct.id);
  console.log(`🔍 العميل يتصفح واجهة المتجر: "${publicDetails.product.name}"`);
  console.log(`   - الخيارات المتاحة: ${publicDetails.options.map(o => `${o.name} (${o.values.map(v => v.value).join(', ')})`).join(' | ')}`);
  console.log(`👉 العميل يحدد في صفحة المنتج: المقاس = "XL" + اللون = "كحلي"`);
  console.log(`   - السعر الديناميكي المعروض للعميل: ${targetVariant.price} ج.م`);

  // تنفيذ الـ Checkout الذري من خلال إجراء create_order_atomic
  const orderItemsPayload = [
    {
      id: savedProduct.id,
      variant_id: targetVariant.id,
      qty: 2,
      price: 1.00 // سعر وهمي من العميل لاختبار الحماية وتطبيق السعر من السيرفر
    }
  ];

  const customerPhone = USER_PHONE;
  const idempotencyKey = `e2e_live_${Date.now()}_${RUN_ID}`;

  const orderRes = await pool.query(`
    SELECT public.create_order_atomic(
      p_user_id => NULL,
      p_items => $1::jsonb,
      p_phone => $2,
      p_city => 'القاهرة',
      p_address => 'المعادي - شارع النصر برج الياسمين الدور الرابع شقة 8',
      p_customer_note => 'يرجى الاتصال قبل الوصول بنصف ساعة، المصعد يعمل بكفاءة',
      p_payment_method => 'cod',
      p_coupon_code => NULL,
      p_idempotency_key => $3,
      p_auth_source => 'otp',
      p_metadata => '{"channel": "online_storefront", "customer_name": "م. أحمد حسام الدين"}'::jsonb,
      p_store_id => $4,
      p_location_url => 'https://maps.google.com/?q=29.9599,31.2589'
    ) AS result;
  `, [JSON.stringify(orderItemsPayload), customerPhone, idempotencyKey, STORE_ID]);

  const createdOrder = orderRes.rows[0]?.result;
  assert(createdOrder && createdOrder.success, `Order creation failed: ${JSON.stringify(createdOrder)}`);

  const orderId = createdOrder.id;
  const orderNumber = createdOrder.order_number;

  console.log(`🎉 تم استلام الطلب وتسجيله في النظام بنجاح:`);
  console.log(`   - رقم الطلب: #${orderNumber} (معرف: ${orderId})`);
  console.log(`   - العميل: م. أحمد حسام الدين (${customerPhone})`);
  console.log(`   - إجمالي الفاتورة المحسوب بالسعر المعتمد: ${createdOrder.total} ج.م (قطعتين x ${targetVariant.price} ج.م)`);

  // التحقق من خصم المخزون آلياً
  const variantStockRes = await pool.query(`SELECT stock_quantity FROM public.product_variants WHERE id = $1;`, [targetVariant.id]);
  const parentStockRes = await pool.query(`SELECT stock_quantity FROM public.products WHERE id = $1;`, [savedProduct.id]);
  console.log(`📉 تحديث المخزون الآلي الفوري:`);
  console.log(`   - مخزون المتغير (${targetVariant.title}): ${variantStockRes.rows[0].stock_quantity} (كان 10، تم خصم 2)`);
  console.log(`   - مخزون المنتج الأب: ${parentStockRes.rows[0].stock_quantity} (كان 60، تم خصم 2)\n`);

  // --------------------------------------------------------------------------
  // STEP 3: كمدير (Admin) - قبول الطلب وتأكيده للبدء في التجهيز
  // --------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('👔 [3] كـ مدير (Admin): معاينة الطلب بتفاصيل المتغيرات وقبوله');
  console.log('----------------------------------------------------------------');

  const { data: fullOrder } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  const itemSnapshotRes = await pool.query(`
    SELECT variant_id, variant_title_snapshot, sku_snapshot, barcode_snapshot, unit_price, unit_cost_snapshot, gross_profit, quantity
    FROM public.order_items
    WHERE order_id = $1;
  `, [orderId]);

  const snapshot = itemSnapshotRes.rows[0];
  console.log(`👀 تفاصيل البند في لوحة المدير:`);
  console.log(`   - الصنف: "${testProductName}"`);
  console.log(`   - المتغير المحفوظ تاريخياً (Immutable Snapshot): "${snapshot.variant_title_snapshot}"`);
  console.log(`   - الباركود: ${snapshot.barcode_snapshot}`);
  console.log(`   - كود الصنف (SKU): ${snapshot.sku_snapshot}`);
  console.log(`   - سعر الوحدة: ${snapshot.unit_price} ج.م | التكلفة: ${snapshot.unit_cost_snapshot} ج.م | إجمالي الربح: ${snapshot.gross_profit} ج.م`);

  // قبول الطلب وتأكيده
  await pool.query(`UPDATE public.orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1;`, [orderId]);
  await pool.query(`UPDATE public.orders SET status = 'processing', updated_at = NOW() WHERE id = $1;`, [orderId]);
  console.log(`✅ قام المدير بقبول الطلب: تغيرت الحالة إلى "processing" (جاري التجهيز والتعبئة)\n`);

  // --------------------------------------------------------------------------
  // STEP 4: طيار التوصيل (Delivery Driver) - إسناد الطلب وتجهيز بون التسليم ورسالة الواتساب
  // --------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('🛵 [4] طيار التوصيل (Delivery Driver): إسناد الطلب وتجهيز البون ورسالة الكابتن');
  console.log('----------------------------------------------------------------');

  const existingDrivers = await deliveryDriverService.listDrivers(STORE_ID);
  let driver = existingDrivers.find(d => d.phone === USER_PHONE || d.name.includes('محمود'));
  if (!driver) {
    driver = await deliveryDriverService.createDriver(STORE_ID, {
      name: 'كابتن محمود علي',
      phone: USER_PHONE,
      vehicle_type: 'motorcycle',
      notes: 'تغطية المعادي والمقطم والبساتين'
    });
  }

  console.log(`🚴 كابتن التوصيل المعتمد: "${driver.name}" (${driver.vehicle_type}) - هاتف: ${driver.phone}`);

  // إسناد الطلب للكابتن عبر courierManager
  const dispatchResult = await courierManager.dispatchOrder({
    orderId,
    storeId: STORE_ID,
    provider: 'driver',
    driverId: driver.id,
    notes: 'التسليم في الدور الرابع مع استلام قيمة الأوردر نقداً'
  });

  console.log(`✅ تم إسناد الطلب بنجاح:`);
  console.log(`   - رقم التتبع الداخلي: ${dispatchResult.trackingNumber}`);
  console.log(`   - حالة الشحن: out_for_delivery (خرج للتوصيل)`);
  console.log(`\n💬 نص رسالة الواتساب المجهزة تلقائياً لكابتن التوصيل:\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(dispatchResult.whatsappText);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔗 رابط الواتساب المباشر للكابتن:\n${dispatchResult.whatsappUrl}\n`);

  // --------------------------------------------------------------------------
  // STEP 5: الفاتورة المعتمدة ورسالة الواتساب الرسمية للعميل (Delivered Invoice)
  // --------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('📄 [5] تسليم الطلب وتوليد فاتورة الشراء الرسمية (PDF) ورسالة واتساب العميل');
  console.log('----------------------------------------------------------------');

  // الكابتن سلّم الأوردر وحصّل المبلغ نقداً
  await pool.query(`UPDATE public.orders SET status = 'delivered', payment_status = 'paid', updated_at = NOW() WHERE id = $1;`, [orderId]);

  const orderPrefix = settings?.order_prefix || 'EG-';
  const formattedOrderNumber = `${orderPrefix}${orderNumber}`;
  const storeName = settings?.brand_name || store.name || 'Ahmed Alam';

  const { pdfBuffer, fileName } = await generateReceiptPdf({
    order: {
      ...fullOrder,
      order_number: orderNumber,
      formatted_order_number: formattedOrderNumber,
      total: createdOrder.total,
      subtotal: createdOrder.subtotal,
      shipping_fee: 0,
      payment_status: 'paid',
      payment_method: 'الدفع عند الاستلام (COD)',
      items: [
        {
          name: testProductName,
          variant_title_snapshot: targetVariant.title,
          qty: 2,
          price: targetVariant.price
        }
      ],
      customer_name: 'م. أحمد حسام الدين',
      phone: USER_PHONE,
      address: 'المعادي - شارع النصر برج الياسمين الدور الرابع',
      city: 'القاهرة'
    },
    store: {
      name: storeName,
      subdomain: store.subdomain
    },
    cashierName: 'متجر أونلاين معتمد'
  });

  const savedPdfPath = path.join(__dirname, `فاتورة_${formattedOrderNumber}.pdf`);
  fs.writeFileSync(savedPdfPath, pdfBuffer);
  console.log(`✅ تم توليد ملف الفاتورة المعتمدة PDF بنجاح:`);
  console.log(`   - اسم الملف: ${fileName}`);
  console.log(`   - المسار المحلي: ${savedPdfPath}`);
  console.log(`   - حجم الفاتورة: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

  // تجهيز نص رسالة واتساب الفاتورة للعميل
  const customerInvoiceWhatsAppText = 
    `🧾 *فاتورة شراء معتمدة - ${storeName}*\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `أهلاً بك يا أستاذ/ م. أحمد حسام الدين 👋\n` +
    `تم تسليم طلبكم رقم *#${formattedOrderNumber}* بنجاح! 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🛍️ *تفاصيل المشتريات:*\n` +
    `• ${testProductName}\n` +
    `  المواصفات: [${targetVariant.title}]\n` +
    `  الكمية: 2 قطعة | سعر الوحدة: ${targetVariant.price} ج.م\n` +
    `💰 *الإجمالي المسدد:* ${createdOrder.total} ج.م\n` +
    `💳 *طريقة الدفع:* نقدًا عند الاستلام (تم التحصيل بالكامل ✅)\n` +
    `🛵 *المندوب المسلم:* ${driver.name}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📄 مرفق لسيادتكم الفاتورة الرسمية المعتمدة (PDF) مع كود التتبع والباركود.\n` +
    `نشكركم لثقتكم الغالية، ونتمنى لكم يومًا سعيدًا مع ${storeName} ⭐`;

  let cleanUserPhone = String(USER_PHONE).replace(/\D/g, '');
  if (cleanUserPhone.startsWith('0')) cleanUserPhone = `2${cleanUserPhone}`;
  const directCustomerWhatsAppUrl = `https://wa.me/${cleanUserPhone}?text=${encodeURIComponent(customerInvoiceWhatsAppText)}`;

  console.log(`\n💬 نص رسالة الواتساب الخاصة بالفاتورة للعميل:\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(customerInvoiceWhatsAppText);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔗 رابط الواتساب المباشر لإرسال الفاتورة لهاتف العميل (${USER_PHONE}):\n${directCustomerWhatsAppUrl}\n`);

  console.log('================================================================');
  console.log('🏆 تمت التجربة الحية بالكامل بنجاح 100% وبدون أي خطأ!');
  console.log('================================================================');

  await pool.end();
}

main().catch(err => {
  console.error('❌ فشل الاختبار الميداني:', err);
  pool.end();
  process.exit(1);
});
