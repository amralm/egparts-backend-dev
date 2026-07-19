/**
 * Payment Methods Router
 * Handles fetching and managing available payment methods per store.
 *
 * Routes:
 *   GET  /api/payments/methods             — Customer: list available methods
 *   GET  /api/payments/methods/:method/settings — Admin: get method config
 *   POST /api/payments/methods/:method/toggle   — Admin: enable/disable method
 *
 * SECURITY CONTRACT:
 * - Customer endpoint returns ONLY what to display (id, label, type, icon).
 * - Backend is the SOLE authority on availability — never the frontend.
 * - Admin routes require permissions.
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
const { verifyPermission } = require('../middleware/auth');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Checks if a store's plan allows payment gateways (Paymob).
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
 * Get a gateway row from store_payment_gateways.
 */
async function getGateway(storeId, providerName) {
  const { data } = await supabase
    .from('store_payment_gateways')
    .select('*')
    .eq('store_id', storeId)
    .eq('provider_name', providerName)
    .maybeSingle();
  return data;
}

/**
 * Ensure a gateway exists in store_payment_gateways. Create it if not.
 * COD defaults to active=true on first creation.
 */
async function ensureGatewayExists(storeId, providerName, defaultActive = true) {
  const existing = await getGateway(storeId, providerName);
  if (!existing) {
    await supabase.from('store_payment_gateways').insert({
      store_id: storeId,
      provider_name: providerName,
      is_active: defaultActive,
      credentials: null,
      key_version: 1,
    });
  }
  return existing;
}

// ─── Customer: GET /api/payments/methods ─────────────────────────────────────

router.get('/', async (req, res) => {
  if (!req.store?.id) {
    return res.status(404).json({ error: 'Store not found' });
  }

  try {
    const storeId = req.store.id;
    const methods = [];

    // Fetch all gateways for this store in one query
    const { data: allGateways } = await supabase
      .from('store_payment_gateways')
      .select('provider_name, credentials, key_version, is_active')
      .eq('store_id', storeId);

    const gatewayMap = {};
    for (const g of (allGateways || [])) {
      gatewayMap[g.provider_name] = g;
    }

    // ── 1. Cash on Delivery (COD) ──────────────────────────────────────────
    // COD is only available if explicitly enabled (or no record exists yet = default on)
    const codGateway = gatewayMap['cod'];
    const isCodActive = codGateway ? codGateway.is_active : true; // default active
    if (isCodActive) {
      methods.push({
        id: 'cod',
        type: 'cash',
        label: 'الدفع عند الاستلام',
        icon: 'payments',
        available: true,
      });
    }

    // ── 2. Manual Wallets (Vodafone Cash, Etisalat, etc.) ─────────────────
    const walletGateway = gatewayMap['manual_wallet'];
    if (walletGateway?.is_active && walletGateway?.credentials) {
      try {
        const key = getEncryptionKeyForVersion(walletGateway.key_version);
        const creds = decryptCredentials(walletGateway.credentials, key) || {};
        const hasActiveWallet = (creds.wallets || []).some(w => w.enabled && w.number);
        if (hasActiveWallet) {
          methods.push({
            id: 'manual_wallet',
            type: 'manual_wallet',
            label: 'محفظة إلكترونية',
            icon: 'account_balance_wallet',
            available: true,
          });
        }
      } catch {
        // Decryption error — skip wallet silently
      }
    } else if (!walletGateway && (await isSiteSettingsWalletActive(storeId))) {
      // Legacy fallback: site_settings.manual_wallet_enabled
      methods.push({
        id: 'manual_wallet',
        type: 'manual_wallet',
        label: 'محفظة إلكترونية',
        icon: 'account_balance_wallet',
        available: true,
      });
    }

    // ── 3. Paymob (Card) — plan entitlement + configured ──────────────────
    const paymobGateway = gatewayMap['paymob'];
    if (paymobGateway?.is_active && paymobGateway?.credentials) {
      // Also verify plan entitlement
      const hasGatewayFeature = await storeHasPaymentGatewayFeature(storeId);
      if (hasGatewayFeature) {
        try {
          const key = getEncryptionKeyForVersion(paymobGateway.key_version);
          const creds = decryptCredentials(paymobGateway.credentials, key) || {};
          const isConfigured = !!(creds.api_key && creds.integration_id && creds.iframe_id);
          if (isConfigured) {
            methods.push({
              id: 'paymob',
              type: 'gateway',
              label: 'بطاقة بنكية',
              icon: 'credit_card',
              available: true,
            });
          }
        } catch {
          // Decryption error — skip Paymob silently
        }
      }
    }

    return res.json({ methods });
  } catch (err) {
    console.error('[payments/methods] Error:', err.message);
    return res.status(500).json({ error: 'Failed to load payment methods' });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function isSiteSettingsWalletActive(storeId) {
  try {
    const { data } = await supabase
      .from('site_settings')
      .select('manual_wallet_enabled, vodafone_cash_number')
      .eq('store_id', storeId)
      .maybeSingle();
    return !!(data?.manual_wallet_enabled && data?.vodafone_cash_number);
  } catch {
    return false;
  }
}

// ─── Admin: GET /api/payments/methods/:method/settings ───────────────────────

router.get('/:method/settings', verifyPermission('payments.view'), async (req, res) => {
  const { method } = req.params;
  const storeId = req.store?.id;
  if (!storeId) return res.status(404).json({ error: 'Store not found' });

  const SUPPORTED = ['cod', 'manual_wallet', 'paymob'];
  if (!SUPPORTED.includes(method)) {
    return res.status(400).json({ error: `Unsupported payment method: ${method}` });
  }

  try {
    const gateway = await getGateway(storeId, method);
    return res.json({
      success: true,
      settings: {
        is_active: gateway ? gateway.is_active : (method === 'cod'), // COD defaults true
      }
    });
  } catch (err) {
    console.error(`[payments/methods/${method}/settings] Error:`, err.message);
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ─── Admin: POST /api/payments/methods/:method/toggle ────────────────────────

router.post('/:method/toggle', verifyPermission('payments.configure'), async (req, res) => {
  const { method } = req.params;
  const { is_active } = req.body;
  const storeId = req.store?.id;

  if (!storeId) return res.status(404).json({ error: 'Store not found' });

  const SUPPORTED = ['cod', 'manual_wallet'];
  if (!SUPPORTED.includes(method)) {
    return res.status(400).json({ error: `Cannot toggle payment method: ${method}` });
  }

  // Paymob toggle is handled via /api/payments/settings — it needs credential management
  // COD and manual_wallet can be simply toggled here

  try {
    const { error } = await supabase
      .from('store_payment_gateways')
      .upsert({
        store_id: storeId,
        provider_name: method,
        is_active: !!is_active,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'store_id,provider_name' });

    if (error) throw error;

    // Also sync legacy site_settings for manual_wallet backward compatibility
    if (method === 'manual_wallet') {
      await supabase
        .from('site_settings')
        .update({ manual_wallet_enabled: !!is_active })
        .eq('store_id', storeId);
    }

    return res.json({
      success: true,
      message: `تم ${is_active ? 'تفعيل' : 'تعطيل'} وسيلة الدفع بنجاح.`
    });
  } catch (err) {
    console.error(`[payments/methods/${method}/toggle] Error:`, err.message);
    return res.status(500).json({ error: 'Failed to toggle payment method' });
  }
});

module.exports = router;
