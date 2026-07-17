/**
 * GET /api/payments/methods
 * Returns a dynamic list of available payment methods for the current store.
 *
 * SECURITY CONTRACT:
 * - Frontend receives ONLY what to display (id, label, type, icon).
 * - Frontend NEVER learns WHY a method is unavailable.
 * - Backend is the sole decision-maker on availability.
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');

/**
 * Checks if the store's subscription plan allows payment_gateways.
 * Returns true/false only. Does not expose why.
 */
async function storeHasPaymentGatewayFeature(storeId) {
  try {
    const { data: subscription } = await supabase
      .from('store_subscriptions')
      .select('plan_id')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!subscription) return false;

    const { data: featureCheck } = await supabase
      .from('plan_features')
      .select('id, features!inner(key)')
      .eq('plan_id', subscription.plan_id)
      .eq('features.key', 'payment_gateways')
      .maybeSingle();

    if (!featureCheck) return false;

    const { data: limit } = await supabase
      .from('feature_limits')
      .select('limit_config')
      .eq('plan_feature_id', featureCheck.id)
      .eq('limit_type', 'boolean')
      .maybeSingle();

    return !limit || limit.limit_config?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Checks if the store has Paymob configured and active.
 * Returns true/false only. Does not expose credentials or reasons.
 */
async function isPaymobActiveForStore(storeId) {
  try {
    const { data: gateway } = await supabase
      .from('store_payment_gateways')
      .select('credentials, key_version, is_active')
      .eq('store_id', storeId)
      .eq('provider_name', 'paymob')
      .eq('is_active', true)
      .maybeSingle();

    if (!gateway?.credentials) return false;

    const key = getEncryptionKeyForVersion(gateway.key_version);
    const creds = decryptCredentials(gateway.credentials, key) || {};

    // Paymob is only truly active if all 3 required fields are filled
    return !!(creds.api_key && creds.integration_id && creds.iframe_id);
  } catch {
    return false;
  }
}

/**
 * Checks if manual wallet (Vodafone/Etisalat/etc.) is configured.
 * Returns true/false only.
 */
async function isManualWalletActiveForStore(storeId) {
  try {
    // 1. Check new architecture (store_payment_gateways)
    const { data: gateway } = await supabase
      .from('store_payment_gateways')
      .select('credentials, key_version, is_active')
      .eq('store_id', storeId)
      .eq('provider_name', 'manual_wallet')
      .eq('is_active', true)
      .maybeSingle();

    if (gateway?.credentials) {
      const key = getEncryptionKeyForVersion(gateway.key_version);
      const creds = decryptCredentials(gateway.credentials, key) || {};
      const activeWallets = (creds.wallets || []).filter(w => w.enabled);
      if (activeWallets.length > 0) return true;
    }

    // 2. Fallback to legacy site_settings
    const { data: settings } = await supabase
      .from('site_settings')
      .select('vodafone_cash_number, manual_wallet_enabled')
      .eq('store_id', storeId)
      .maybeSingle();

    return !!(settings?.manual_wallet_enabled && settings?.vodafone_cash_number);
  } catch (err) {
    console.error('[paymentMethods] isManualWalletActiveForStore error:', err.message);
    return false;
  }
}

// GET /api/payments/methods
router.get('/', async (req, res) => {
  if (!req.store?.id) {
    return res.status(404).json({ error: 'Store not found' });
  }

  try {
    const storeId = req.store.id;
    const methods = [];

    // 1. Cash on Delivery (COD) - always available
    methods.push({
      id: 'cod',
      type: 'cash',
      label: 'الدفع عند الاستلام',
      icon: 'payments',
      available: true,
    });

    // 2. Manual Wallets (Vodafone Cash, etc.) - depends on store settings
    const walletActive = await isManualWalletActiveForStore(storeId);
    if (walletActive) {
      methods.push({
        id: 'manual_wallet',
        type: 'manual_wallet',
        label: 'محفظة إلكترونية',
        icon: 'account_balance_wallet',
        available: true,
      });
    }

    // 3. Paymob (card payment) - depends on plan + store config
    const hasGatewayFeature = await storeHasPaymentGatewayFeature(storeId);
    if (hasGatewayFeature) {
      const paymobActive = await isPaymobActiveForStore(storeId);
      if (paymobActive) {
        methods.push({
          id: 'paymob',
          type: 'gateway',
          label: 'بطاقة بنكية',
          icon: 'credit_card',
          available: true,
        });
      }
    }

    return res.json({ methods });
  } catch (err) {
    console.error('[payments/methods] Error:', err.message);
    return res.status(500).json({ error: 'Failed to load payment methods' });
  }
});

module.exports = router;
