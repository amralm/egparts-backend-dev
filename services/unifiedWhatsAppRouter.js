'use strict';

const whatsappPoolService = require('./whatsappPoolService');
const metaWhatsAppService = require('./metaWhatsAppService');
const { supabase } = require('./supabase');
const logger = require('../utils/logger');

/**
 * Unified WhatsApp Routing Engine
 * Dynamically routes messages between the Baileys Session Pool and Meta Cloud API
 * with zero downtime and strict circuit protection.
 */
class UnifiedWhatsAppRouter {
  /**
   * Resolve WhatsApp Provider for a store
   * Returns: { provider: 'pool'|'meta'|'hybrid', metaConfig: {...} }
   */
  async resolveProvider(storeId) {
    if (!storeId) {
      // Platform level fallback to global env or pool
      const globalProvider = process.env.WHATSAPP_PROVIDER || 'pool';
      const metaConfig = {
        phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID,
        accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN
      };
      return {
        provider: metaConfig.phoneNumberId && metaConfig.accessToken ? globalProvider : 'pool',
        metaConfig
      };
    }

    try {
      const { data: settings } = await supabase
        .from('site_settings')
        .select('whatsapp_provider, meta_phone_number_id, meta_access_token')
        .eq('store_id', storeId)
        .maybeSingle();

      const provider = settings?.whatsapp_provider || 'pool';
      const metaConfig = {
        phoneNumberId: settings?.meta_phone_number_id || process.env.META_WHATSAPP_PHONE_NUMBER_ID,
        accessToken: settings?.meta_access_token || process.env.META_WHATSAPP_ACCESS_TOKEN
      };

      const hasMetaCredentials = Boolean(metaConfig.phoneNumberId && metaConfig.accessToken);

      // If merchant chose meta/hybrid but hasn't configured keys, safely default to active pool
      const resolvedProvider = hasMetaCredentials ? provider : 'pool';

      return { provider: resolvedProvider, metaConfig };
    } catch (err) {
      logger.warn('[UnifiedWhatsAppRouter] Error resolving settings, defaulting to pool:', err.message);
      return { provider: 'pool', metaConfig: null };
    }
  }

  /**
   * Universal Send Text Message
   */
  async sendMessage(to, text, options = {}) {
    const { storeId, messageType = 'transactional' } = options;
    const { provider, metaConfig } = await this.resolveProvider(storeId);

    // Determine target based on provider & hybrid strategy
    let useMeta = false;
    if (provider === 'meta') {
      useMeta = true;
    } else if (provider === 'hybrid') {
      // Hybrid mode: Use Meta for OTP and password alerts, Pool for bulk / order chat
      useMeta = messageType === 'otp' || messageType === 'security';
    }

    if (useMeta && metaConfig?.phoneNumberId && metaConfig?.accessToken) {
      try {
        logger.info(`[UnifiedRouter] Routing message to ${to} via Meta Cloud API (${messageType})`);
        return await metaWhatsAppService.sendTextMessage({
          phoneNumberId: metaConfig.phoneNumberId,
          accessToken: metaConfig.accessToken,
          to,
          text
        });
      } catch (metaErr) {
        logger.error(`[UnifiedRouter] Meta dispatch failed: ${metaErr.message}. Falling back to Baileys Pool...`);
        // Graceful fallback to Baileys pool if Meta fails
        return await whatsappPoolService.sendMessage(to, text, options);
      }
    }

    // Default route: Baileys Session Pool (Always intact and active)
    return await whatsappPoolService.sendMessage(to, text, options);
  }

  /**
   * Universal Send Document / PDF
   */
  async sendDocument(to, bufferOrUrl, fileName, caption = '', options = {}) {
    const { storeId } = options;
    const { provider, metaConfig } = await this.resolveProvider(storeId);

    // If Meta mode and a publicly accessible document URL is provided
    if (provider === 'meta' && typeof bufferOrUrl === 'string' && bufferOrUrl.startsWith('http') && metaConfig?.phoneNumberId) {
      try {
        return await metaWhatsAppService.sendDocumentMessage({
          phoneNumberId: metaConfig.phoneNumberId,
          accessToken: metaConfig.accessToken,
          to,
          documentUrl: bufferOrUrl,
          fileName,
          caption
        });
      } catch (metaErr) {
        logger.warn(`[UnifiedRouter] Meta document send failed: ${metaErr.message}`);
      }
    }

    // Default route: Baileys Pool
    return await whatsappPoolService.sendDocument(to, bufferOrUrl, fileName, caption, options);
  }

  /**
   * Unified Connection Status
   */
  async getStatus(storeId) {
    const poolStatus = whatsappPoolService.getStatus();
    const { provider, metaConfig } = await this.resolveProvider(storeId);

    let metaStatus = {
      configured: Boolean(metaConfig?.phoneNumberId && metaConfig?.accessToken),
      phoneNumberId: metaConfig?.phoneNumberId ? `${metaConfig.phoneNumberId.slice(0, 4)}••••` : null
    };

    return {
      activeProvider: provider,
      pool: poolStatus,
      meta: metaStatus
    };
  }
}

module.exports = new UnifiedWhatsAppRouter();
