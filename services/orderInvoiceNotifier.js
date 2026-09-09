'use strict';

const { supabase } = require('./supabase');
const { generateReceiptPdf } = require('./receiptPdfService');
const unifiedWhatsAppRouter = require('./unifiedWhatsAppRouter');
const logger = require('../utils/logger');

/**
 * Automatically generates a high-quality vector PDF invoice and dispatches it
 * to the customer's WhatsApp upon order delivery ("delivered" status).
 *
 * @param {string} orderId - Order UUID
 * @param {string} storeId - Store UUID
 * @param {Object} [options] - Optional preloaded data
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
async function sendOrderDeliveredInvoiceWhatsApp(orderId, storeId, options = {}) {
  if (!orderId || !storeId) {
    logger.warn('[orderInvoiceNotifier] Missing orderId or storeId');
    return { success: false, message: 'Missing orderId or storeId' };
  }

  try {
    // 1. Fetch full order details
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, order_number, total, total_amount, subtotal, discount, discount_amount, shipping_fee, payment_method, payment_status, status, items, phone, user_id, customer_note, metadata, created_at')
      .eq('id', orderId)
      .eq('store_id', storeId)
      .maybeSingle();

    if (orderErr || !order) {
      logger.warn(`[orderInvoiceNotifier] Order not found: ${orderId}`);
      return { success: false, message: 'Order not found' };
    }

    // 2. Resolve recipient phone number
    let recipientPhone = order.phone || order.metadata?.customer_phone;
    if (!recipientPhone && order.user_id) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('phone')
        .eq('user_id', order.user_id)
        .eq('store_id', storeId)
        .maybeSingle();
      recipientPhone = profile?.phone;
    }

    if (!recipientPhone || String(recipientPhone).trim().length < 8) {
      logger.info(`[orderInvoiceNotifier] Order ${orderId} has no valid phone number. Skipping WhatsApp invoice.`);
      return { success: false, message: 'No recipient phone number' };
    }

    // 3. Fetch store settings and branding
    const [{ data: settings }, { data: storeRow }] = await Promise.all([
      supabase
        .from('site_settings')
        .select('order_prefix, brand_name, brand_logo, logo_url')
        .eq('store_id', storeId)
        .maybeSingle(),
      supabase
        .from('stores')
        .select('name, subdomain')
        .eq('id', storeId)
        .maybeSingle()
    ]);

    const orderPrefix = settings?.order_prefix || 'EG-';
    const formattedOrderNumber = `${orderPrefix}${order.order_number}`;
    const storeName = settings?.brand_name || storeRow?.name || 'متجرنا';

    // 4. Generate high-quality vector PDF invoice
    const { pdfBuffer, fileName } = await generateReceiptPdf({
      order: {
        ...order,
        formatted_order_number: formattedOrderNumber,
        shipping_fee: order.shipping_fee,
        customer_name: order.metadata?.customer_name || order.customer_note || 'عميل المتجر'
      },
      store: {
        name: storeName,
        subdomain: storeRow?.subdomain
      },
      cashierName: order.metadata?.cashier_name || 'متجر إلكتروني'
    });

    // 5. Build official delivery caption
    const caption = `تم تسليم طلبكم رقم ${formattedOrderNumber} بنجاح.\nمرفق فاتورة الشراء الرسمية المعتمدة.\nنشكركم لاختياركم ${storeName}.`;

    // 6. Dispatch PDF document via Unified WhatsApp Router
    await unifiedWhatsAppRouter.sendDocument(
      recipientPhone,
      pdfBuffer,
      `فاتورة_${formattedOrderNumber}.pdf`,
      caption,
      {
        storeId,
        idempotencyKey: `invoice:delivered:${order.id}`
      }
    );

    // 7. Record in order audit log
    await supabase.from('order_logs').insert([{
      order_id: order.id,
      store_id: storeId,
      old_status: 'delivered',
      new_status: 'delivered',
      note: `تم إرسال فاتورة الشراء الرسمية (PDF) بنجاح إلى واتساب العميل (${recipientPhone})`
    }]).catch((logErr) => {
      logger.warn('[orderInvoiceNotifier] Non-blocking order_log insert failure:', logErr.message);
    });

    logger.info(`[orderInvoiceNotifier]  Delivered PDF invoice dispatched for Order #${formattedOrderNumber} to ${recipientPhone}`);
    return { success: true };
  } catch (err) {
    logger.error('[orderInvoiceNotifier] Error sending delivered invoice:', err.message);
    return { success: false, message: err.message };
  }
}

module.exports = {
  sendOrderDeliveredInvoiceWhatsApp
};
