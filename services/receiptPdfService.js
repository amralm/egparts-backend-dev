'use strict';

const sharp = require('sharp');
const QRCode = require('qrcode');
const { generateBarcode128Svg } = require('../utils/barcode128');
const logger = require('../utils/logger');

/**
 * Builds a single-page PDF-1.4 stream wrapping a JPEG image
 * Standard PDF-1.4 format without external PDF libraries
 */
function buildSinglePagePdfFromJpeg(jpegBuffer, widthPx, heightPx) {
  const ptWidth = Math.round(widthPx * 72 / 150);
  const ptHeight = Math.round(heightPx * 72 / 150);

  const chunks = [];
  const offsets = [];

  function addChunk(strOrBuf) {
    const buf = Buffer.isBuffer(strOrBuf) ? strOrBuf : Buffer.from(strOrBuf, 'binary');
    chunks.push(buf);
  }

  function currentOffset() {
    return chunks.reduce((acc, c) => acc + c.length, 0);
  }

  addChunk('%PDF-1.4\n');

  // Obj 1: Catalog
  offsets[1] = currentOffset();
  addChunk('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Obj 2: Pages
  offsets[2] = currentOffset();
  addChunk('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // Obj 3: Page
  offsets[3] = currentOffset();
  addChunk(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptWidth} ${ptHeight}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);

  // Obj 4: Image XObject
  offsets[4] = currentOffset();
  addChunk(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuffer.length} >>\nstream\n`);
  addChunk(jpegBuffer);
  addChunk('\nendstream\nendobj\n');

  // Obj 5: Contents
  const content = `q ${ptWidth} 0 0 ${ptHeight} 0 0 cm /Im1 Do Q`;
  offsets[5] = currentOffset();
  addChunk(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  // Xref
  const startXref = currentOffset();
  addChunk(`xref\n0 6\n0000000000 65535 f \n`);
  for (let i = 1; i <= 5; i++) {
    const offStr = String(offsets[i]).padStart(10, '0');
    addChunk(`${offStr} 00000 n \n`);
  }

  // Trailer
  addChunk(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * Generates a high-quality thermal-style PDF receipt for a POS order
 * @param {Object} params
 * @param {Object} params.order - Order data (id, order_number, total, subtotal, discount, payment_method, items, created_at, customer_name)
 * @param {Object} params.store - Store information (name, subdomain)
 * @param {string} [params.cashierName] - Cashier display name
 * @returns {Promise<{ pdfBuffer: Buffer, fileName: string }>}
 */
async function generateReceiptPdf({ order, store, cashierName = 'الكاشير' }) {
  try {
    const width = 600;
    const items = Array.isArray(order.items) ? order.items : [];
    
    // Dynamic height calculation
    const itemRowHeight = 35;
    const baseHeight = 540;
    const height = baseHeight + (items.length * itemRowHeight);

    const orderNum = order.formatted_order_number || `EG-${order.order_number || '1001'}`;
    const storeName = (store?.name || 'متجر سحابي').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const dateStr = new Date(order.created_at || Date.now()).toLocaleString('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    const subtotal = Number(order.subtotal || order.total || 0).toFixed(2);
    const discount = Number(order.discount || order.discount_amount || 0).toFixed(2);
    const total = Number(order.total || order.total_amount || 0).toFixed(2);
    const payMethod = order.payment_method === 'card' ? 'بطاقة بنكية / فيزا' : 'نقداً (كاش)';
    const customerName = (order.customer_name || order.metadata?.customer_name || 'عميل نقدي')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Generate QR Code SVG
    const trackingHost = store?.subdomain ? `${store.subdomain}.egparts.store` : 'egparts.store';
    const qrData = `https://${trackingHost}/track-order?id=${order.id || order.order_number}`;
    const qrSvgRaw = await QRCode.toString(qrData, {
      type: 'svg',
      margin: 1,
      width: 100,
      color: { dark: '#000000', light: '#ffffff' }
    });
    const qrInner = qrSvgRaw.replace(/<\?xml.*?\?>/, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '');

    // Generate Barcode SVG
    const barcodeSvgRaw = generateBarcode128Svg(orderNum, { height: 40, moduleWidth: 1.8, showText: true });
    const barcodeInner = barcodeSvgRaw.replace(/<\?xml.*?\?>/, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '');

    // Render items rows
    let yPos = 240;
    const itemRowsSvg = items.map((item) => {
      const name = (item.name || item.title || 'صنف').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const qty = item.qty || item.quantity || 1;
      const price = Number(item.price || item.unit_price || 0).toFixed(2);
      const lineTotal = (qty * price).toFixed(2);
      
      const row = `
        <text x="550" y="${yPos}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="14" font-weight="bold" fill="#111827" text-anchor="end">${name}</text>
        <text x="180" y="${yPos}" font-family="monospace" font-size="13" fill="#4B5563" text-anchor="middle">${qty} × ${price}</text>
        <text x="50" y="${yPos}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="14" font-weight="bold" fill="#111827" text-anchor="start">${lineTotal} ج.م</text>
      `;
      yPos += itemRowHeight;
      return row;
    }).join('\n');

    const totalsY = yPos + 10;
    const barcodeY = totalsY + 110;
    const qrY = barcodeY + 70;

    const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#ffffff"/>
      
      <!-- Top Header & Store Name -->
      <rect x="0" y="0" width="${width}" height="6" fill="#10B981"/>
      <text x="300" y="45" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="22" font-weight="bold" fill="#111827" text-anchor="middle">${storeName}</text>
      <text x="300" y="70" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="14" font-weight="bold" fill="#059669" text-anchor="middle">إيصال مبيعات نقدية (POS)</text>
      
      <!-- Metadata Box -->
      <line x1="40" y1="85" x2="560" y2="85" stroke="#E5E7EB" stroke-width="1.5" stroke-dasharray="4,4"/>
      
      <text x="550" y="110" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#6B7280" text-anchor="end">رقم الفاتورة:</text>
      <text x="450" y="110" font-family="monospace" font-size="14" font-weight="bold" fill="#111827" text-anchor="end">#${orderNum}</text>
      
      <text x="220" y="110" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#6B7280" text-anchor="end">التاريخ:</text>
      <text x="50" y="110" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="12" fill="#111827" text-anchor="start">${dateStr}</text>

      <text x="550" y="135" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#6B7280" text-anchor="end">الكاشير:</text>
      <text x="450" y="135" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" font-weight="bold" fill="#111827" text-anchor="end">${cashierName}</text>

      <text x="220" y="135" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#6B7280" text-anchor="end">العميل:</text>
      <text x="50" y="135" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" font-weight="bold" fill="#111827" text-anchor="start">${customerName}</text>

      <line x1="40" y1="150" x2="560" y2="150" stroke="#E5E7EB" stroke-width="1.5"/>

      <!-- Table Header -->
      <rect x="40" y="160" width="520" height="30" fill="#F3F4F6" rx="4"/>
      <text x="540" y="180" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="12" font-weight="bold" fill="#4B5563" text-anchor="end">الصنف</text>
      <text x="180" y="180" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="12" font-weight="bold" fill="#4B5563" text-anchor="middle">الكمية × السعر</text>
      <text x="60" y="180" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="12" font-weight="bold" fill="#4B5563" text-anchor="start">المجموع</text>

      <!-- Items -->
      ${itemRowsSvg}

      <!-- Totals Section -->
      <line x1="40" y1="${totalsY}" x2="560" y2="${totalsY}" stroke="#E5E7EB" stroke-width="1.5" stroke-dasharray="4,4"/>
      
      <text x="550" y="${totalsY + 25}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#6B7280" text-anchor="end">المجموع الفرعي:</text>
      <text x="50" y="${totalsY + 25}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#111827" text-anchor="start">${subtotal} ج.م</text>

      ${Number(discount) > 0 ? `
      <text x="550" y="${totalsY + 45}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#EF4444" text-anchor="end">الخصم:</text>
      <text x="50" y="${totalsY + 45}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="13" fill="#EF4444" text-anchor="start">-${discount} ج.م</text>
      ` : ''}

      <rect x="40" y="${totalsY + 55}" width="520" height="42" fill="#ECFDF5" rx="6" stroke="#A7F3D0"/>
      <text x="540" y="${totalsY + 82}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="16" font-weight="bold" fill="#065F46" text-anchor="end">الإجمالي المستحق:</text>
      <text x="60" y="${totalsY + 82}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="18" font-weight="bold" fill="#059669" text-anchor="start">${total} ج.م</text>

      <!-- Payment Method -->
      <text x="300" y="${totalsY + 115}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="12" fill="#6B7280" text-anchor="middle">طريقة السداد: <tspan font-weight="bold" fill="#111827">${payMethod}</tspan></text>

      <!-- Barcode 128 -->
      <g transform="translate(160, ${barcodeY})">
        ${barcodeInner}
      </g>

      <!-- QR Code & Footer -->
      <g transform="translate(250, ${qrY})">
        ${qrInner}
      </g>
      <text x="300" y="${qrY + 115}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="11" fill="#9CA3AF" text-anchor="middle">امسح الرمز لتتبع الفاتورة إلكترونياً</text>
      <text x="300" y="${qrY + 135}" font-family="Arial, 'Segoe UI', Tahoma, sans-serif" font-size="12" font-weight="bold" fill="#4B5563" text-anchor="middle">شكراً لتعاملكم معنا!</text>
    </svg>
    `;

    const jpegBuffer = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
    const pdfBuffer = buildSinglePagePdfFromJpeg(jpegBuffer, width, height);

    return {
      pdfBuffer,
      fileName: `Receipt-${orderNum}.pdf`
    };
  } catch (err) {
    logger.error('[receiptPdfService] Error generating PDF receipt:', err.message);
    throw err;
  }
}

module.exports = {
  generateReceiptPdf,
  buildSinglePagePdfFromJpeg
};
