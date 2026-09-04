'use strict';

const express = require('express');
const router = express.Router();
const metaWhatsAppService = require('../services/metaWhatsAppService');
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

/**
 * Meta WhatsApp Cloud API Webhook Verification (GET)
 * Used by Meta / Facebook App Dashboard to verify endpoint
 */
router.get('/', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  let expectedToken = process.env.META_WHATSAPP_VERIFY_TOKEN || 'egparts_meta_webhook_secret';
  let isVerified = (mode === 'subscribe' && token === expectedToken);

  if (!isVerified && mode === 'subscribe' && token) {
    const { data } = await supabase
      .from('site_settings')
      .select('meta_verify_token')
      .eq('meta_verify_token', token)
      .limit(1);
    if (data && data.length > 0) {
      isVerified = true;
    }
  }

  if (isVerified) {
    logger.info('[MetaWebhook] Successfully verified Meta webhook challenge.');
    return res.status(200).send(challenge);
  }

  logger.warn('[MetaWebhook] Verification failed. Token mismatch.');
  return res.status(403).send('Forbidden: Invalid verify token');
});

/**
 * Inbound Meta WhatsApp Events (POST)
 * Receives delivery statuses, read receipts, and incoming messages
 */
router.post('/', async (req, res) => {
  // Always return 200 immediately to Meta as required by Meta webhook contract
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    // 1. Process Status Updates (sent, delivered, read, failed)
    const statuses = value.statuses || [];
    for (const statusObj of statuses) {
      const { id: messageId, status, timestamp, recipient_id } = statusObj;
      logger.info(`[MetaWebhook] Message ${messageId} to ${recipient_id} status updated to: ${status}`);

      // Optional: log or update in analytics/notifications log if needed
      await supabase.from('analytics_events').insert([{
        event_type: `meta_wa_${status}`,
        metadata: {
          message_id: messageId,
          recipient: recipient_id,
          timestamp
        }
      }]).catch(() => {});
    }

    // 2. Process Inbound Messages (if any)
    const messages = value.messages || [];
    for (const msg of messages) {
      logger.info(`[MetaWebhook] Inbound customer message from ${msg.from}: ${msg.text?.body || msg.type}`);
    }
  } catch (err) {
    logger.error('[MetaWebhook] Error processing webhook event:', err.message);
  }
});

module.exports = router;
