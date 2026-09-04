'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Official Meta WhatsApp Business Cloud API Service
 * Built on Meta Graph API v21.0
 */
class MetaWhatsAppService {
  constructor() {
    this.apiVersion = 'v21.0';
    this.graphBaseUrl = `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Sanitize recipient phone number to E.164 international format without '+'
   * e.g., '01012345678' -> '201012345678'
   */
  formatRecipient(phone) {
    if (!phone) return '';
    let clean = String(phone).replace(/\D/g, '');
    if (clean.startsWith('01') && clean.length === 11) {
      clean = `2${clean}`;
    }
    return clean;
  }

  /**
   * Test Meta Connection & Credentials
   * Fetches phone number details from Meta Graph API
   */
  async testConnection({ phoneNumberId, accessToken }) {
    if (!phoneNumberId || !accessToken) {
      throw new Error('Phone Number ID و Access Token مطلوبان لاختبار الاتصال بميتا.');
    }

    const cleanPhoneId = phoneNumberId.trim();
    const cleanToken = accessToken.trim();

    logger.info(`[MetaWhatsApp] Testing connection for Phone Number ID: ${cleanPhoneId}`);

    const fetchRes = await fetch(`${this.graphBaseUrl}/${cleanPhoneId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status`, {
      headers: {
        'Authorization': `Bearer ${cleanToken}`
      }
    });

    const data = await fetchRes.json().catch(() => ({}));

    if (!fetchRes.ok) {
      const errorMsg = data.error?.message || `Meta Graph API HTTP ${fetchRes.status}`;
      logger.error('[MetaWhatsApp] Connection test failed:', errorMsg);
      throw new Error(`فشل الاتصال بـ Meta Cloud API: ${errorMsg}`);
    }

    return {
      success: true,
      phoneNumberId: cleanPhoneId,
      displayPhoneNumber: data.display_phone_number,
      verifiedName: data.verified_name,
      qualityRating: data.quality_rating,
      verificationStatus: data.code_verification_status,
      raw: data
    };
  }

  /**
   * Send Plain Text Message via Meta Cloud API
   */
  async sendTextMessage({ phoneNumberId, accessToken, to, text, previewUrl = false }) {
    if (!phoneNumberId || !accessToken) {
      throw new Error('بيانات اعتماد Meta Cloud API غير مكتملة.');
    }

    const recipient = this.formatRecipient(to);
    if (!recipient) {
      throw new Error('رقم هاتف المستلم غير صحيح.');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: {
        preview_url: Boolean(previewUrl),
        body: text
      }
    };

    const fetchRes = await fetch(`${this.graphBaseUrl}/${phoneNumberId.trim()}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await fetchRes.json().catch(() => ({}));

    if (!fetchRes.ok) {
      const errorMsg = data.error?.message || `Meta API HTTP ${fetchRes.status}`;
      logger.error(`[MetaWhatsApp] Send text failed to ${recipient}:`, errorMsg);
      throw new Error(`تعذر إرسال الرسالة عبر ميتا: ${errorMsg}`);
    }

    const messageId = data.messages?.[0]?.id;
    return {
      success: true,
      provider: 'meta',
      messageId,
      recipient,
      raw: data
    };
  }

  /**
   * Send Pre-Approved Template Message via Meta Cloud API
   */
  async sendTemplateMessage({
    phoneNumberId,
    accessToken,
    to,
    templateName,
    languageCode = 'ar',
    components = []
  }) {
    if (!phoneNumberId || !accessToken || !templateName) {
      throw new Error('بيانات القالب ومفاتيح ميتا مطلوبة.');
    }

    const recipient = this.formatRecipient(to);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length > 0 ? { components } : {})
      }
    };

    const fetchRes = await fetch(`${this.graphBaseUrl}/${phoneNumberId.trim()}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await fetchRes.json().catch(() => ({}));

    if (!fetchRes.ok) {
      const errorMsg = data.error?.message || `Meta API HTTP ${fetchRes.status}`;
      logger.error(`[MetaWhatsApp] Send template (${templateName}) failed to ${recipient}:`, errorMsg);
      throw new Error(`تعذر إرسال القالب عبر ميتا: ${errorMsg}`);
    }

    return {
      success: true,
      provider: 'meta',
      messageId: data.messages?.[0]?.id,
      recipient,
      raw: data
    };
  }

  /**
   * Send Media Document Message (PDF, Receipt, Invoice)
   */
  async sendDocumentMessage({
    phoneNumberId,
    accessToken,
    to,
    documentUrl,
    fileName = 'document.pdf',
    caption = ''
  }) {
    if (!phoneNumberId || !accessToken || !documentUrl) {
      throw new Error('بيانات إرسال المستند ومفاتيح ميتا مطلوبة.');
    }

    const recipient = this.formatRecipient(to);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'document',
      document: {
        link: documentUrl,
        filename: fileName,
        caption: caption || undefined
      }
    };

    const fetchRes = await fetch(`${this.graphBaseUrl}/${phoneNumberId.trim()}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await fetchRes.json().catch(() => ({}));

    if (!fetchRes.ok) {
      const errorMsg = data.error?.message || `Meta API HTTP ${fetchRes.status}`;
      logger.error(`[MetaWhatsApp] Send document failed to ${recipient}:`, errorMsg);
      throw new Error(`تعذر إرسال المستند عبر ميتا: ${errorMsg}`);
    }

    return {
      success: true,
      provider: 'meta',
      messageId: data.messages?.[0]?.id,
      recipient,
      raw: data
    };
  }

  /**
   * Verify HMAC-SHA256 Signature for Inbound Meta Webhooks
   */
  verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
    if (!appSecret || !signatureHeader) return false;
    try {
      const [algo, hash] = signatureHeader.split('=');
      if (algo !== 'sha256' || !hash) return false;

      const expectedHash = crypto
        .createHmac('sha256', appSecret.trim())
        .update(rawBody)
        .digest('hex');

      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
    } catch {
      return false;
    }
  }
}

module.exports = new MetaWhatsAppService();
