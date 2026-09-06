'use strict';

const { supabase } = require('./supabase');
const pool = require('./whatsappPoolService');
const metaWhatsAppService = require('./metaWhatsAppService');
const { ABANDONED_CART_TEMPLATES, renderAbandonedCartMessage } = require('../constants/abandonedCartTemplates');
const abandonedCartService = require('./abandonedCartService');
const subscriptionLimitService = require('./subscriptionLimitService');
const logger = require('../utils/logger');

const WORKER_INTERVAL_MS = 15 * 60 * 1000; // Run every 15 minutes
const COOLDOWN_DAYS = 7; // 7-day cooldown per phone
const ORDER_CHECK_HOURS = 1; // 60-minute order deduplication

class AbandonedCartWorker {
  constructor() {
    this.timer = null;
    this.isRunning = false;
  }

  start() {
    if (this.timer) return;
    logger.info('🚀 [AbandonedCartWorker] Starting abandoned cart recovery worker (15-min intervals)...');

    // Initial run delayed 60 seconds after server boot for smooth startup
    setTimeout(() => {
      this.runRecoveryCycle().catch((err) => {
        logger.error('[AbandonedCartWorker] Initial cycle error:', err.message);
      });
    }, 60000);

    this.timer = setInterval(() => {
      this.runRecoveryCycle().catch((err) => {
        logger.error('[AbandonedCartWorker] Scheduled cycle error:', err.message);
      });
    }, WORKER_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('🛑 [AbandonedCartWorker] Stopped abandoned cart recovery worker.');
    }
  }

  async runRecoveryCycle() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // 1. Fetch stores that have abandoned cart recovery enabled
      const { data: storesWithSettings, error: storeErr } = await supabase
        .from('site_settings')
        .select(`
          store_id,
          abandoned_cart_enabled,
          abandoned_cart_template,
          abandoned_cart_delay_minutes,
          whatsapp_provider,
          meta_phone_number_id,
          meta_access_token,
          stores (
            id,
            name,
            subdomain,
            custom_domain,
            is_active
          )
        `)
        .eq('abandoned_cart_enabled', true);

      if (storeErr || !storesWithSettings || storesWithSettings.length === 0) {
        return;
      }

      await pool.loadAccounts();

      for (const entry of storesWithSettings) {
        const store = entry.stores;
        if (!store || !store.is_active) continue;

        const storeId = entry.store_id;

        // Check if plan allows abandoned cart recovery
        const limitCheck = await subscriptionLimitService.checkFeatureLimit(storeId, 'abandoned_cart_recovery');
        if (limitCheck && limitCheck.allowed === false) {
          logger.debug(`[AbandonedCartWorker] Store "${store.name}" (${storeId}) plan does not include abandoned cart recovery. Skipping.`);
          continue;
        }

        const delayMinutes = Math.max(15, parseInt(entry.abandoned_cart_delay_minutes, 10) || 30);
        const templateKey = entry.abandoned_cart_template || 'friendly_discount';

        // 2. Resolve Merchant's Dedicated WhatsApp
        // Case A: Meta Cloud API
        let metaSender = null;
        if (entry.meta_phone_number_id && entry.meta_access_token) {
          metaSender = {
            phoneNumberId: entry.meta_phone_number_id,
            accessToken: entry.meta_access_token,
          };
        }

        // Case B: Baileys merchant account linked to this store_id
        let baileysService = null;
        for (const [id, acc] of pool.accounts) {
          if (acc.row.store_id === storeId && acc.row.enabled && acc.service.isReady) {
            baileysService = acc.service;
            break;
          }
        }

        // =========================================================================
        // STRICT PLATFORM ISOLATION / ZERO BAN RISK ENFORCEMENT:
        // If neither merchant Baileys nor Meta is connected, SKIP this store!
        // Platform pool numbers are NEVER used for abandoned cart messages.
        // =========================================================================
        if (!metaSender && !baileysService) {
          logger.debug(`[AbandonedCartWorker] Store "${store.name}" (${storeId}) has recovery enabled, but NO merchant WhatsApp account connected. Skipping to protect platform pool.`);
          continue;
        }

        // 3. Find candidate abandoned sessions for this store
        const cutoffTime = new Date(Date.now() - delayMinutes * 60 * 1000).toISOString();
        const sevenDaysAgo = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const oneHourAgo = new Date(Date.now() - ORDER_CHECK_HOURS * 60 * 60 * 1000).toISOString();

        const { data: candidates, error: candErr } = await supabase
          .from('cart_sessions')
          .select('*')
          .eq('store_id', storeId)
          .eq('reminder_sent', false)
          .in('status', ['active', 'abandoned'])
          .lt('last_interaction_at', cutoffTime)
          .limit(20);

        if (candErr || !candidates || candidates.length === 0) continue;

        for (const session of candidates) {
          try {
            // Anti-Spam Check 0: Check permanent customer opt-out ("إيقاف" / "ايقاف" / "stop")
            const isOptedOut = await abandonedCartService.isPhoneOptedOut(session.phone, storeId);
            if (isOptedOut) {
              logger.info(`[AbandonedCartWorker] Skipping ${session.phone} — customer opted out.`);
              await supabase.from('cart_sessions').update({ status: 'expired' }).eq('id', session.id);
              continue;
            }

            // Anti-Spam Check 1: 7-day cooldown per customer phone number
            const { data: recentReminder } = await supabase
              .from('cart_sessions')
              .select('id')
              .eq('phone', session.phone)
              .eq('reminder_sent', true)
              .gt('reminder_sent_at', sevenDaysAgo)
              .limit(1)
              .maybeSingle();

            if (recentReminder) {
              logger.info(`[AbandonedCartWorker] Skipping ${session.phone} — 7-day cooldown active.`);
              await supabase.from('cart_sessions').update({ status: 'abandoned' }).eq('id', session.id);
              continue;
            }

            // Anti-Spam Check 2: 60-minute order deduplication check
            const { data: recentOrder } = await supabase
              .from('orders')
              .select('id')
              .eq('store_id', storeId)
              .eq('phone', session.phone)
              .gt('created_at', oneHourAgo)
              .limit(1)
              .maybeSingle();

            if (recentOrder) {
              logger.info(`[AbandonedCartWorker] Customer ${session.phone} already completed an order recently. Marking recovered.`);
              await supabase.from('cart_sessions').update({ status: 'recovered' }).eq('id', session.id);
              continue;
            }

            // Anti-Stale Check 3: Re-verify stock before sending reminder
            const items = Array.isArray(session.items) ? session.items : [];
            const productIds = items.map((i) => i.id || i.product_id).filter(Boolean);
            if (productIds.length > 0) {
              const { data: products } = await supabase
                .from('products')
                .select('id, stock, is_active')
                .in('id', productIds);

              const availableProducts = (products || []).filter((p) => p.is_active && (p.stock === null || p.stock > 0));
              if (availableProducts.length === 0) {
                logger.info(`[AbandonedCartWorker] All items in cart ${session.id} are out of stock. Marking expired.`);
                await supabase.from('cart_sessions').update({ status: 'expired' }).eq('id', session.id);
                continue;
              }
            }

            // Build recovery URL
            const primaryDomain = process.env.PRIMARY_DOMAIN || 'egparts.store';
            const baseHost = store.custom_domain
              ? `https://${store.custom_domain}`
              : `https://${store.subdomain}.${primaryDomain}`;
            const recoveryUrl = `${baseHost}/cart/recover/${session.recovery_token}`;

            const messageText = renderAbandonedCartMessage(templateKey, {
              customerName: session.customer_name,
              storeName: store.name,
              recoveryUrl,
            });

            // Dispatch message via merchant's WhatsApp
            let sent = false;
            if (baileysService) {
              await baileysService.sendMessage(session.phone, messageText);
              sent = true;
            } else if (metaSender) {
              await metaWhatsAppService.sendTextMessage({
                phoneNumberId: metaSender.phoneNumberId,
                accessToken: metaSender.accessToken,
                to: session.phone,
                text: messageText,
              });
              sent = true;
            }

            if (sent) {
              const nowIso = new Date().toISOString();
              await supabase
                .from('cart_sessions')
                .update({
                  status: 'abandoned',
                  reminder_sent: true,
                  reminder_sent_at: nowIso,
                  updated_at: nowIso,
                })
                .eq('id', session.id);

              logger.info(`[AbandonedCartWorker] Dispatched recovery message to ${session.phone} for store "${store.name}"`);
            }
          } catch (itemErr) {
            logger.error(`[AbandonedCartWorker] Error processing session ${session.id}: ${itemErr.message}`);
          }
        }
      }
    } catch (cycleErr) {
      logger.error(`[AbandonedCartWorker] Recovery cycle exception: ${cycleErr.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

const abandonedCartWorker = new AbandonedCartWorker();

module.exports = abandonedCartWorker;
