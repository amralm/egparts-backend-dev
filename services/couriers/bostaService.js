'use strict';

const logger = require('../../utils/logger');

/**
 * Bosta API v2 Service for Egyptian E-Commerce Shipments
 * Supports Staging (stg-app.bosta.co) & Production (app.bosta.co)
 */
class BostaService {
  getBaseUrl(isTestMode = true) {
    return isTestMode
      ? 'https://stg-app.bosta.co/api/v2'
      : 'https://app.bosta.co/api/v2';
  }

  /**
   * Helper to parse GPS coordinates from Google Maps URL if available
   */
  parseGeoLocation(locationUrl) {
    if (!locationUrl || typeof locationUrl !== 'string') return null;
    try {
      const match = locationUrl.match(/q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      if (match) {
        return {
          latitude: parseFloat(match[1]),
          longitude: parseFloat(match[2])
        };
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Create Delivery with Bosta
   */
  async createDelivery({
    apiKey,
    isTestMode = true,
    order,
    pickupAddress = {},
    notes = ''
  }) {
    if (!apiKey) {
      throw new Error('Bosta API Key is required for automated shipping.');
    }

    const baseUrl = this.getBaseUrl(isTestMode);
    const isCod = String(order.payment_method || '').toLowerCase() === 'cod';
    const codAmount = isCod ? parseFloat(order.total || order.total_amount || 0) : 0;

    // Build receiver phone (sanitize Egyptian phone)
    let cleanPhone = String(order.phone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('20') && cleanPhone.length === 12) {
      cleanPhone = `0${cleanPhone.slice(2)}`;
    }

    const geoLocation = this.parseGeoLocation(order.location_url);

    const payload = {
      type: 10, // Package Delivery
      specs: {
        packageType: 'Parcel',
        packageDetails: {
          itemsCount: Array.isArray(order.items) ? order.items.length : 1,
          description: `Order #${order.order_number || order.id?.slice(0, 8)} - ${order.items?.map(i => `${i.name || 'منتج'} (x${i.qty || 1})`).join(', ') || 'بضائع'}`.slice(0, 200)
        }
      },
      dropOffAddress: {
        firstLine: order.address || 'العنوان غير محدد',
        city: order.city || 'القاهرة',
        district: order.city || 'القاهرة',
        ...(geoLocation ? { geoLocation } : {})
      },
      receiver: {
        firstName: order.customer_name || (order.phone ? `عميل ${order.phone.slice(-4)}` : 'عميل المتجر'),
        lastName: '',
        phone: cleanPhone
      },
      cod: codAmount,
      businessReference: String(order.order_number || order.id?.slice(0, 8)),
      notes: notes || order.customer_note || ''
    };

    if (pickupAddress?.firstLine) {
      payload.pickupAddress = {
        firstLine: pickupAddress.firstLine,
        city: pickupAddress.city || 'القاهرة',
        phone: pickupAddress.phone
      };
    }

    logger.info(`[Bosta] Dispatching order #${order.order_number} to Bosta (${isTestMode ? 'Staging' : 'Production'})...`);

    const response = await fetch(`${baseUrl}/deliveries`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey.trim()
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMsg = data.message || data.error || `Bosta HTTP ${response.status}`;
      logger.error(`[Bosta] Dispatch failed for order #${order.order_number}:`, errorMsg);
      throw new Error(`فشل إنشاء شحنة Bosta: ${errorMsg}`);
    }

    const deliveryId = data._id || data.data?._id;
    const trackingNumber = data.trackingNumber || data.data?.trackingNumber;
    const trackingUrl = `https://bosta.co/tracking-shipment/?track=${trackingNumber}`;
    const awbUrl = `${baseUrl}/deliveries/awb/${deliveryId}`;

    return {
      success: true,
      provider: 'bosta',
      deliveryId,
      trackingNumber,
      trackingUrl,
      awbUrl,
      raw: data
    };
  }

  /**
   * Fetch Printable Airway Bill (AWB) / Sticker PDF
   */
  async getAirwayBill({ apiKey, isTestMode = true, deliveryId }) {
    const baseUrl = this.getBaseUrl(isTestMode);
    const response = await fetch(`${baseUrl}/deliveries/awb/${deliveryId}`, {
      headers: {
        'Authorization': apiKey.trim()
      }
    });

    if (!response.ok) {
      throw new Error(`تعذر جلب بوليصة الشحن من Bosta (HTTP ${response.status})`);
    }

    const data = await response.json().catch(() => ({}));
    return data.data || data; // Contains base64 or sticker URL
  }

  /**
   * Track Shipment Status Live
   */
  async trackDelivery({ apiKey, isTestMode = true, trackingNumber }) {
    const baseUrl = this.getBaseUrl(isTestMode);
    const response = await fetch(`${baseUrl}/deliveries/track/${trackingNumber}`, {
      headers: {
        'Authorization': apiKey.trim()
      }
    });

    if (!response.ok) {
      throw new Error(`تعذر جلب تتبع الشحنة من Bosta (HTTP ${response.status})`);
    }

    const data = await response.json().catch(() => ({}));
    return data;
  }

  /**
   * Cancel Delivery
   */
  async cancelDelivery({ apiKey, isTestMode = true, deliveryId }) {
    const baseUrl = this.getBaseUrl(isTestMode);
    const response = await fetch(`${baseUrl}/deliveries/${deliveryId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': apiKey.trim()
      }
    });

    if (!response.ok) {
      throw new Error(`تعذر إلغاء الشحنة في Bosta (HTTP ${response.status})`);
    }

    return await response.json().catch(() => ({ success: true }));
  }
}

module.exports = new BostaService();
