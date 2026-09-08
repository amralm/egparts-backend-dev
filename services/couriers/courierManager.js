'use strict';

const { supabase } = require('../supabase');
const bostaService = require('./bostaService');
const deliveryDriverService = require('../deliveryDriverService');
const { sendOrderDeliveredInvoiceWhatsApp } = require('../orderInvoiceNotifier');
const logger = require('../../utils/logger');

class CourierManager {
  /**
   * Get store courier settings
   */
  async getSettings(storeId, provider = 'bosta') {
    const { data, error } = await supabase
      .from('store_courier_settings')
      .select('*')
      .eq('store_id', storeId)
      .eq('provider', provider)
      .maybeSingle();

    if (error) {
      logger.error(`[CourierManager] Error loading settings for store ${storeId}:`, error.message);
      throw error;
    }

    return data || null;
  }

  /**
   * Save store courier settings
   */
  async saveSettings(storeId, { provider = 'bosta', apiKey, isActive = true, isTestMode = true, pickupAddress = {} }) {
    const payload = {
      store_id: storeId,
      provider,
      api_key: apiKey ? apiKey.trim() : null,
      is_active: Boolean(isActive),
      is_test_mode: Boolean(isTestMode),
      pickup_address: pickupAddress || {},
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('store_courier_settings')
      .upsert(payload, { onConflict: 'store_id,provider' })
      .select('*')
      .single();

    if (error) {
      logger.error(`[CourierManager] Failed to save settings for store ${storeId}:`, error.message);
      throw error;
    }

    return data;
  }

  /**
   * Dispatch Order with Courier
   */
  async dispatchOrder({ orderId, storeId, provider = 'bosta', customTrackingNumber, notes, driverId }) {
    // 1. Fetch target order
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('store_id', storeId)
      .single();

    if (orderErr || !order) {
      throw new Error('الطلب غير موجود أو لا ينتمي لهذا المتجر.');
    }

    // Guard: Prevent double dispatching if already shipped (unless re-assigning driver)
    if (order.courier_order_id && order.status === 'shipped' && provider !== 'driver') {
      return {
        success: true,
        alreadyDispatched: true,
        trackingNumber: order.tracking_number,
        trackingUrl: order.tracking_url,
        awbUrl: order.awb_url,
        courierName: order.courier_name
      };
    }

    let dispatchResult = null;

    if (provider === 'bosta') {
      const settings = await this.getSettings(storeId, 'bosta');
      if (!settings || !settings.api_key) {
        throw new Error('يرجى ضبط وتفعيل مفتاح API الخاص بشركة Bosta أولاً من إعدادات الشحن.');
      }

      dispatchResult = await bostaService.createDelivery({
        apiKey: settings.api_key,
        isTestMode: settings.is_test_mode !== false,
        order,
        pickupAddress: settings.pickup_address,
        notes
      });
    } else if (provider === 'driver') {
      const targetDriverId = driverId || customTrackingNumber;
      if (!targetDriverId) {
        throw new Error('يرجى تحديد مندوب التوصيل المسند إليه الطلب.');
      }
      const driver = await deliveryDriverService.getDriverById(storeId, targetDriverId);
      if (!driver) {
        throw new Error('لم يتم العثور على المندوب المحدد.');
      }

      const tracking = `DRV-${order.order_number || order.id.slice(0, 8)}-${Date.now().toString().slice(-4)}`;

      // Fetch store name for professional WhatsApp message
      const { data: storeRow } = await supabase
        .from('stores')
        .select('name')
        .eq('id', storeId)
        .maybeSingle();
      const storeName = storeRow?.name || 'المتجر';

      // Customer name and phone
      const customerName = (order.customer_name || order.user_name || order.name || 'عميل المتجر').trim();
      let cleanPhone = String(order.phone || '').replace(/\D/g, '');
      if (cleanPhone.startsWith('20') && cleanPhone.length === 12) {
        cleanPhone = `0${cleanPhone.slice(2)}`;
      }

      // Location URL (GPS link or Google Maps query)
      let mapsUrl = order.location_url;
      if (!mapsUrl && (order.address || order.city)) {
        mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${order.city || ''} ${order.address || ''}`.trim())}`;
      }

      // Products itemized
      const itemsList = Array.isArray(order.items) && order.items.length > 0
        ? order.items.map(item => {
            const variant = (item.variant_title_snapshot || item.variant_title || item.selected_size) ? ` [${item.variant_title_snapshot || item.variant_title || item.selected_size}]` : '';
            return `• ${item.name || 'منتج'}${variant} (الكمية: ${item.qty || item.quantity || 1})`;
          }).join('\n')
        : '• بضائع متنوعة';

      const isAlreadyPaid = order.payment_status === 'paid';
      const codAmount = isAlreadyPaid ? 0 : parseFloat(order.total || order.total_amount || 0);

      const whatsappText = `🛵 *أوردر جديد للتوصيل - ${storeName}*\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `📦 *رقم الطلب:* #${order.order_number || order.id.slice(0, 8)}\n` +
        `👤 *العميل:* ${customerName}\n` +
        `📞 *تليفون العميل:* ${cleanPhone || 'غير مسجل'}\n` +
        `📍 *العنوان:* ${order.city ? `${order.city} - ` : ''}${order.address || 'غير محدد'}\n` +
        (mapsUrl ? `🗺️ *رابط اللوكيشن:* ${mapsUrl}\n` : '') +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `🛍️ *المنتجات المطلوبة:*\n${itemsList}\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        (notes ? `📝 *ملاحظات التوصيل:* ${notes}\n` : '') +
        (isAlreadyPaid
          ? `✅ *حالة الدفع:* مدفوع مسبقاً (لا تحصّل أي مبالغ من العميل)\n`
          : `💰 *المطلوب تحصيله (COD):* ${codAmount.toFixed(2)} ج.م (شامل التوصيل)\n`) +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `بالتوفيق يا ${driver.name.trim().startsWith('كابتن') ? driver.name.trim() : `كابتن ${driver.name.trim()}`} 🚀`;

      let driverCleanPhone = String(driver.phone || '').replace(/\D/g, '');
      if (driverCleanPhone.startsWith('0') && driverCleanPhone.length === 11) {
        driverCleanPhone = `2${driverCleanPhone}`;
      } else if (!driverCleanPhone.startsWith('2') && driverCleanPhone.length === 10) {
        driverCleanPhone = `20${driverCleanPhone}`;
      }

      const whatsappUrl = `https://wa.me/${driverCleanPhone}?text=${encodeURIComponent(whatsappText)}`;

      dispatchResult = {
        success: true,
        provider: 'driver',
        deliveryId: `DRIVER-${driver.id}`,
        trackingNumber: tracking,
        trackingUrl: mapsUrl || null,
        awbUrl: null,
        driver: {
          id: driver.id,
          name: driver.name,
          phone: driver.phone,
          vehicleType: driver.vehicle_type
        },
        whatsappText,
        whatsappUrl
      };
    } else if (provider === 'manual') {
      // Manual / Private delivery driver
      const tracking = customTrackingNumber || `AWB-${order.order_number || order.id.slice(0, 8)}-${Date.now().toString().slice(-4)}`;
      dispatchResult = {
        success: true,
        provider: 'manual',
        deliveryId: `MANUAL-${order.id}`,
        trackingNumber: tracking,
        trackingUrl: null,
        awbUrl: null
      };
    } else {
      throw new Error(`مزود الشحن (${provider}) غير مدعوم حالياً.`);
    }

    // 2. Update Order Status and Tracking Details in Database
    const updateFields = {
      courier_name: dispatchResult.provider,
      courier_order_id: dispatchResult.deliveryId,
      courier_status: dispatchResult.provider === 'driver' ? 'out_for_delivery' : 'created',
      tracking_number: dispatchResult.trackingNumber,
      tracking_url: dispatchResult.trackingUrl || null,
      awb_url: dispatchResult.awbUrl || null,
      delivery_driver_id: dispatchResult.driver?.id || null,
      delivery_driver_name: dispatchResult.driver?.name || null,
      delivery_driver_phone: dispatchResult.driver?.phone || null,
      updated_at: new Date().toISOString()
    };

    // Transition order to shipped if currently confirmed or processing
    if (['pending', 'confirmed', 'processing'].includes(order.status)) {
      updateFields.status = 'shipped';
    }

    const { data: updatedOrder, error: updateErr } = await supabase
      .from('orders')
      .update(updateFields)
      .eq('id', orderId)
      .eq('store_id', storeId)
      .select('*')
      .single();

    if (updateErr) {
      logger.error(`[CourierManager] Error updating order #${order.order_number} after dispatch:`, updateErr.message);
      throw updateErr;
    }

    // 3. Log event in order_logs
    try {
      await supabase.from('order_logs').insert([{
        order_id: orderId,
        store_id: storeId,
        admin_id: null,
        old_status: order.status,
        new_status: updateFields.status || order.status,
        note: `تم إنشاء شحنة عبر ${provider.toUpperCase()} برقم تتبع (${dispatchResult.trackingNumber})`
      }]);
    } catch (e) {
      logger.warn('[CourierManager] Log warning:', e.message);
    }

    return {
      success: true,
      order: updatedOrder,
      trackingNumber: dispatchResult.trackingNumber,
      trackingUrl: dispatchResult.trackingUrl,
      awbUrl: dispatchResult.awbUrl,
      courierName: provider,
      driver: dispatchResult.driver || null,
      whatsappUrl: dispatchResult.whatsappUrl || null,
      whatsappText: dispatchResult.whatsappText || null
    };
  }

  /**
   * Track Live Delivery Status
   */
  async trackOrder(orderId, storeId) {
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, order_number, courier_name, courier_order_id, courier_status, tracking_number, tracking_url, status')
      .eq('id', orderId)
      .eq('store_id', storeId)
      .single();

    if (error || !order) {
      throw new Error('الطلب غير موجود.');
    }

    if (!order.courier_name || !order.tracking_number) {
      return {
        status: order.status,
        hasCourier: false,
        message: 'لم يتم ربط هذا الطلب بشركة شحن آلية بعد.'
      };
    }

    if (order.courier_name === 'bosta') {
      const settings = await this.getSettings(storeId, 'bosta');
      if (settings?.api_key) {
        try {
          const bostaTracking = await bostaService.trackDelivery({
            apiKey: settings.api_key,
            isTestMode: settings.is_test_mode !== false,
            trackingNumber: order.tracking_number
          });
          return {
            hasCourier: true,
            provider: 'bosta',
            trackingNumber: order.tracking_number,
            trackingUrl: order.tracking_url,
            liveStatus: bostaTracking.data?.state || bostaTracking.state || order.courier_status,
            history: bostaTracking.data?.transitEvents || []
          };
        } catch (err) {
          logger.warn(`[CourierManager] Failed live tracking: ${err.message}`);
        }
      }
    }

    return {
      hasCourier: true,
      provider: order.courier_name,
      trackingNumber: order.tracking_number,
      trackingUrl: order.tracking_url,
      liveStatus: order.courier_status || order.status
    };
  }

  /**
   * Get Airway Bill (AWB) / Printable Sticker for an Order
   */
  async getAirwayBill(orderId, storeId) {
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, courier_name, courier_order_id, tracking_number')
      .eq('id', orderId)
      .eq('store_id', storeId)
      .single();

    if (error || !order) {
      throw new Error('الطلب غير موجود.');
    }

    if (!order.courier_order_id) {
      throw new Error('لم يتم إصدار بوليصة شحن لهذا الطلب بعد.');
    }

    const provider = order.courier_name || 'bosta';
    if (provider === 'bosta') {
      const settings = await this.getSettings(storeId, 'bosta');
      if (!settings || !settings.api_key) {
        throw new Error('يرجى ضبط وتفعيل مفتاح API الخاص بشركة Bosta أولاً.');
      }
      return await bostaService.getAirwayBill({
        apiKey: settings.api_key,
        isTestMode: settings.is_test_mode !== false,
        deliveryId: order.courier_order_id
      });
    }

    throw new Error(`جلب البوليصة غير مدعوم للمزود (${provider}).`);
  }

  /**
   * Handle Courier Inbound Webhook (e.g. Bosta Delivery Status Callback)
   */
  async handleWebhook(provider, payload) {
    logger.info(`[CourierManager] Inbound webhook from ${provider}:`, JSON.stringify(payload).slice(0, 300));

    if (provider === 'bosta') {
      const { _id, trackingNumber, state, subState } = payload || {};
      if (!trackingNumber && !_id) return { ignored: true };

      // Find order by tracking number or courier order id
      let query = supabase.from('orders').select('id, store_id, status, payment_method, payment_status, total');
      if (trackingNumber) {
        query = query.eq('tracking_number', String(trackingNumber));
      } else {
        query = query.eq('courier_order_id', String(_id));
      }

      const { data: order } = await query.maybeSingle();
      if (!order) {
        logger.warn(`[CourierWebhook] No order found for Bosta delivery ${trackingNumber || _id}`);
        return { ignored: true, reason: 'Order not found' };
      }

      const updatePayload = {
        courier_status: state || subState,
        updated_at: new Date().toISOString()
      };

      const normalizedState = String(state || '').toUpperCase();

      if (normalizedState.includes('DELIVERED')) {
        updatePayload.status = 'delivered';
        // If COD, mark paid automatically
        const isCod = ['cod', 'cash_on_delivery', 'cash'].includes(String(order.payment_method || '').toLowerCase());
        if (isCod && order.payment_status !== 'paid') {
          updatePayload.payment_status = 'paid';
          updatePayload.paid_at = new Date().toISOString();
        }
      } else if (normalizedState.includes('RETURNED') || normalizedState.includes('CANCELLED')) {
        updatePayload.courier_status = 'returned';
      }

      await supabase.from('orders').update(updatePayload).eq('id', order.id);

      // Auto-dispatch delivered PDF invoice on WhatsApp
      if (updatePayload.status === 'delivered' && order.status !== 'delivered') {
        sendOrderDeliveredInvoiceWhatsApp(order.id, order.store_id).catch((invErr) => {
          logger.warn(`[CourierManager] Auto-dispatch delivered invoice failed for ${order.id}:`, invErr.message);
        });
      }

      await supabase.from('order_logs').insert([{
        order_id: order.id,
        store_id: order.store_id,
        old_status: order.status,
        new_status: updatePayload.status || order.status,
        note: `تحديث آلي من شركة Bosta: الحالة أصبحت (${state || subState})`
      }]).catch(() => {});

      return { success: true, orderId: order.id, state };
    }

    return { ignored: true };
  }

  /**
   * Unassign shipping courier/driver from order
   */
  async unassignOrder(orderId, storeId) {
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, order_number, status, courier_name, delivery_driver_name')
      .eq('id', orderId)
      .eq('store_id', storeId)
      .maybeSingle();

    if (orderErr) throw orderErr;
    if (!order) {
      const err = new Error('الطلب غير موجود');
      err.statusCode = 404;
      throw err;
    }

    const previousDriver = order.delivery_driver_name || order.courier_name;

    const updateFields = {
      courier_name: null,
      courier_order_id: null,
      courier_status: null,
      tracking_number: null,
      tracking_url: null,
      awb_url: null,
      delivery_driver_id: null,
      delivery_driver_name: null,
      delivery_driver_phone: null,
      updated_at: new Date().toISOString()
    };

    // If order was shipped, revert to confirmed
    if (order.status === 'shipped') {
      updateFields.status = 'confirmed';
    }

    const { data: updatedOrder, error: updateErr } = await supabase
      .from('orders')
      .update(updateFields)
      .eq('id', orderId)
      .eq('store_id', storeId)
      .select('*')
      .single();

    if (updateErr) throw updateErr;

    // Log unassignment in order_logs
    try {
      await supabase.from('order_logs').insert([{
        order_id: orderId,
        store_id: storeId,
        old_status: order.status,
        new_status: updateFields.status || order.status,
        note: `تم إلغاء إسناد الشحن (${previousDriver || 'غير محدد'}) وإعادة الطلب للمتابعة.`
      }]);
    } catch (logErr) {
      logger.warn('[CourierManager] Log unassign error:', logErr.message);
    }

    return {
      success: true,
      order: updatedOrder,
      message: 'تم إلغاء إسناد الشحن وإعادة الطلب بنجاح.'
    };
  }
}

module.exports = new CourierManager();
