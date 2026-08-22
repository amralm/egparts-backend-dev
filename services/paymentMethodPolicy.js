const { supabase } = require('./supabase');
const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');

const METHOD_DEFINITIONS = {
  cod: { label: 'الدفع عند الاستلام', type: 'cash', icon: 'payments' },
  manual_wallet: { label: 'محفظة إلكترونية', type: 'manual_wallet', icon: 'account_balance_wallet' },
  card: { label: 'بطاقة بنكية', type: 'gateway', icon: 'credit_card' },
};

async function hasGatewayEntitlement(storeId) {
  const { data: subscription, error: subscriptionError } = await supabase
    .from('store_subscriptions').select('plan_id').eq('store_id', storeId)
    .eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (subscriptionError) throw subscriptionError;
  if (!subscription) return { allowed: false, reason: 'NO_ACTIVE_SUBSCRIPTION' };
  const { data: pf, error: pfError } = await supabase
    .from('plan_features').select('id, features!inner(key)').eq('plan_id', subscription.plan_id)
    .eq('features.key', 'payment_gateways').maybeSingle();
  if (pfError) throw pfError;
  if (!pf) return { allowed: false, reason: 'PLAN_FEATURE_NOT_INCLUDED' };
  const { data: limit, error: limitError } = await supabase.from('feature_limits')
    .select('limit_config').eq('plan_feature_id', pf.id).eq('limit_type', 'boolean').maybeSingle();
  if (limitError) throw limitError;
  if (limit && limit.limit_config?.enabled !== true) return { allowed: false, reason: 'PLAN_FEATURE_DISABLED' };
  return { allowed: true, reason: 'PLAN_ENTITLED' };
}

async function resolvePaymentMethods(storeId) {
  if (!storeId) throw new Error('STORE_REQUIRED');
  const { data: gateways, error } = await supabase.from('store_payment_gateways')
    .select('provider_name, credentials, key_version, is_active').eq('store_id', storeId);
  if (error) throw error;
  const byName = Object.fromEntries((gateways || []).map(g => [g.provider_name, g]));
  const result = {};
  const cod = byName.cod;
  result.cod = { enabled: cod ? cod.is_active === true : true, reason: cod ? (cod.is_active ? 'GATEWAY_ENABLED' : 'DISABLED_BY_STORE') : 'DEFAULT_CORE_METHOD', source: 'gateway' };

  const entitlement = await hasGatewayEntitlement(storeId);
  const wallet = byName.manual_wallet;
  let walletConfigured = false;
  if (wallet?.is_active && wallet.credentials) {
    try {
      const creds = decryptCredentials(wallet.credentials, getEncryptionKeyForVersion(wallet.key_version)) || {};
      walletConfigured = (creds.wallets || []).some(w => w?.enabled === true && /^\d{8,15}$/.test(String(w.number || '').replace(/\D/g, '')));
    } catch { walletConfigured = false; }
  }
  result.manual_wallet = {
    enabled: entitlement.allowed && wallet?.is_active === true && walletConfigured,
    reason: !entitlement.allowed ? entitlement.reason : !wallet?.is_active ? 'GATEWAY_DISABLED' : !walletConfigured ? 'GATEWAY_NOT_CONFIGURED' : 'AVAILABLE',
    source: entitlement.allowed ? 'plan_and_gateway' : 'plan',
  };

  const card = byName.paymob;
  let cardConfigured = false;
  if (card?.is_active && card.credentials) {
    try {
      const creds = decryptCredentials(card.credentials, getEncryptionKeyForVersion(card.key_version)) || {};
      cardConfigured = Boolean(creds.api_key && creds.integration_id && creds.iframe_id && creds.hmac_secret);
    } catch { cardConfigured = false; }
  }
  result.card = {
    enabled: entitlement.allowed && card?.is_active === true && cardConfigured,
    reason: !entitlement.allowed ? entitlement.reason : !card?.is_active ? 'GATEWAY_DISABLED' : !cardConfigured ? 'GATEWAY_NOT_CONFIGURED' : 'AVAILABLE',
    source: entitlement.allowed ? 'plan_and_gateway' : 'plan',
  };
  return { availability: result, methods: Object.entries(result).filter(([, v]) => v.enabled).map(([id]) => ({ id, ...METHOD_DEFINITIONS[id], available: true })) };
}

async function assertPaymentMethodAvailable(storeId, method) {
  const canonical = method === 'paymob' ? 'card' : method === 'cash_on_delivery' ? 'cod' : method;
  if (!METHOD_DEFINITIONS[canonical]) {
    const err = new Error('UNSUPPORTED_PAYMENT_METHOD'); err.code = 'PAYMENT_METHOD_UNAVAILABLE'; err.status = 400; throw err;
  }
  const resolved = await resolvePaymentMethods(storeId);
  if (!resolved.availability[canonical]?.enabled) {
    const err = new Error(resolved.availability[canonical]?.reason || 'PAYMENT_METHOD_UNAVAILABLE');
    err.code = 'PAYMENT_METHOD_UNAVAILABLE'; err.status = 409; throw err;
  }
  return canonical;
}

module.exports = { METHOD_DEFINITIONS, resolvePaymentMethods, assertPaymentMethodAvailable, hasGatewayEntitlement };
