'use strict';

const { supabase } = require('../supabase');
const bostaService = require('./bostaService');
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
  async dispatchOrder({ orderId, storeId, provider = 'bosta', customTrackingNumber, notes }) {
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

    // Guard: Prevent double dispatching if already shipped
    if (order.courier_order_id && order.status === 'shipped') {
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
      courier_status: 'created',
      tracking_number: dispatchResult.trackingNumber,
      tracking_url: dispatchResult.trackingUrl || null,
      awb_url: dispatchResult.awbUrl || null,
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
    await supabase.from('order_logs').insert([{
      order_id: orderId,
      store_id: storeId,
      admin_id: null,
      old_status: order.status,
      new_status: updateFields.status || order.status,
      note: `تم إنشاء شحنة عبر ${provider.toUpperCase()} برقم تتبع (${dispatchResult.trackingNumber})`
    }]).catch((e) => logger.warn('[CourierManager] Log warning:', e.message));

    return {
      success: true,
      order: updatedOrder,
      trackingNumber: dispatchResult.trackingNumber,
      trackingUrl: dispatchResult.trackingUrl,
      awbUrl: dispatchResult.awbUrl,
      courierName: provider
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
        if (String(order.payment_method).toLowerCase() === 'cod' && order.payment_status !== 'paid') {
          updatePayload.payment_status = 'paid';
          updatePayload.paid_at = new Date().toISOString();
        }
      } else if (normalizedState.includes('RETURNED') || normalizedState.includes('CANCELLED')) {
        updatePayload.courier_status = 'returned';
      }

      await supabase.from('orders').update(updatePayload).eq('id', order.id);

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
}

module.exports = new CourierManager();
