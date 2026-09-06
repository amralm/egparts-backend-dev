'use strict';

const crypto = require('crypto');
const { supabase } = require('./supabase');
const logger = require('../utils/logger');

/**
 * Standard Egyptian / International phone normalization
 */
function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return '';
  let cleaned = rawPhone.replace(/\D/g, '');
  if (cleaned.startsWith('01') && cleaned.length === 11) {
    cleaned = '2' + cleaned;
  }
  return cleaned;
}

/**
 * Sync or update an active cart draft.
 * Prevents DB bloat by upserting / reusing single active session per (store_id, phone).
 */
async function syncDraft(storeId, { phone, customerName, items }) {
  if (!storeId) throw new Error('storeId is required');
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 10) {
    throw new Error('Valid phone number is required');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart must contain at least one item');
  }

  const nowIso = new Date().toISOString();

  // Check for existing active or abandoned session for this store and phone
  const { data: existing, error: findErr } = await supabase
    .from('cart_sessions')
    .select('id, recovery_token, customer_name, status')
    .eq('store_id', storeId)
    .eq('phone', normalizedPhone)
    .in('status', ['active', 'abandoned'])
    .maybeSingle();

  if (findErr) {
    logger.error(`[AbandonedCartService] Find session error: ${findErr.message}`);
    throw findErr;
  }

  if (existing) {
    const { data: updated, error: updateErr } = await supabase
      .from('cart_sessions')
      .update({
        items,
        customer_name: customerName ? customerName.trim() : existing.customer_name,
        status: 'active',
        reminder_sent: false,
        last_interaction_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', existing.id)
      .select('id, recovery_token, status')
      .single();

    if (updateErr) {
      logger.error(`[AbandonedCartService] Update session error: ${updateErr.message}`);
      throw updateErr;
    }

    return {
      id: updated.id,
      recoveryToken: updated.recovery_token,
      status: updated.status,
    };
  }

  // Create new session
  const recoveryToken = crypto.randomBytes(16).toString('hex');
  const { data: created, error: insertErr } = await supabase
    .from('cart_sessions')
    .insert({
      store_id: storeId,
      phone: normalizedPhone,
      customer_name: customerName ? customerName.trim() : null,
      items,
      recovery_token: recoveryToken,
      status: 'active',
      reminder_sent: false,
      last_interaction_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select('id, recovery_token, status')
    .single();

  if (insertErr) {
    logger.error(`[AbandonedCartService] Insert session error: ${insertErr.message}`);
    throw insertErr;
  }

  return {
    id: created.id,
    recoveryToken: created.recovery_token,
    status: created.status,
  };
}

/**
 * Recover cart with Anti-Stale Price & Stock Re-verification.
 * Dynamically queries the products table to ensure prices and inventory are live.
 */
async function recoverCart(recoveryToken) {
  if (!recoveryToken || typeof recoveryToken !== 'string') {
    return { valid: false, error: 'INVALID_TOKEN' };
  }

  const { data: session, error: sessionErr } = await supabase
    .from('cart_sessions')
    .select(`
      id,
      store_id,
      phone,
      customer_name,
      items,
      status,
      created_at,
      stores (
        id,
        name,
        subdomain,
        custom_domain
      )
    `)
    .eq('recovery_token', recoveryToken.trim())
    .maybeSingle();

  if (sessionErr || !session) {
    return { valid: false, error: 'SESSION_NOT_FOUND' };
  }

  if (session.status === 'expired') {
    return { valid: false, error: 'SESSION_EXPIRED' };
  }

  const items = Array.isArray(session.items) ? session.items : [];
  const productIds = items
    .map((it) => it.id || it.product_id)
    .filter(Boolean);

  let liveProductsMap = new Map();
  if (productIds.length > 0) {
    const { data: liveProducts, error: prodErr } = await supabase
      .from('products')
      .select('id, name, price, stock, is_active, images')
      .in('id', productIds);

    if (!prodErr && liveProducts) {
      liveProducts.forEach((p) => liveProductsMap.set(String(p.id), p));
    }
  }

  let hasPriceChanges = false;
  let hasOutOfStock = false;

  const refreshedItems = items.map((item) => {
    const pId = String(item.id || item.product_id);
    const live = liveProductsMap.get(pId);
    const qty = Number(item.qty || item.quantity || 1);

    if (!live || live.is_active === false) {
      hasOutOfStock = true;
      return {
        ...item,
        is_available: false,
        out_of_stock: true,
        reason: 'UNAVAILABLE',
      };
    }

    const livePrice = Number(live.price);
    const savedPrice = Number(item.price);
    const priceChanged = Number.isFinite(livePrice) && Number.isFinite(savedPrice) && livePrice !== savedPrice;
    if (priceChanged) hasPriceChanges = true;

    const isOutOfStock = live.stock !== null && live.stock < qty;
    if (isOutOfStock) hasOutOfStock = true;

    return {
      ...item,
      id: live.id,
      name: live.name || item.name || item.title,
      price: Number.isFinite(livePrice) ? livePrice : savedPrice,
      original_saved_price: savedPrice,
      price_changed: priceChanged,
      image: item.image || (live.images && live.images[0]) || null,
      available_stock: live.stock,
      out_of_stock: isOutOfStock,
      is_available: !isOutOfStock,
      quantity: qty,
      qty: qty,
    };
  });

  return {
    valid: true,
    sessionId: session.id,
    store: session.stores,
    phone: session.phone,
    customerName: session.customer_name,
    items: refreshedItems,
    hasPriceChanges,
    hasOutOfStock,
    status: session.status,
  };
}

/**
 * Mark cart session as recovered when an order is completed.
 */
async function markConverted(storeId, phone) {
  if (!storeId || !phone) return;
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return;

  try {
    const { error } = await supabase
      .from('cart_sessions')
      .update({
        status: 'recovered',
        updated_at: new Date().toISOString(),
      })
      .eq('store_id', storeId)
      .eq('phone', normalizedPhone)
      .in('status', ['active', 'abandoned']);

    if (error) {
      logger.warn(`[AbandonedCartService] markConverted warning: ${error.message}`);
    }
  } catch (err) {
    logger.warn(`[AbandonedCartService] markConverted exception: ${err.message}`);
  }
}

/**
 * Normalizes Arabic and English text to detect opt-out requests reliably.
 * Strips diacritics, unifies hamzas (إ, أ, آ -> ا), taa marbuta (ة -> ه), yaa (ى -> ي),
 * removes punctuation, and matches both exact words and intent phrases.
 */
function isOptOutMessage(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;

  const normalized = rawText
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '') // Remove tashkeel/diacritics
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'؛،؟]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;

  const optOutPatterns = [
    'ايقاف',
    'توقف',
    'الغاء',
    'stop',
    'unsubscribe',
    'cancel',
    'كفايه',
    'مش عايز',
    'مش عاوز',
    'بطل تبعت',
    'وقف الرسائل',
    'ايقاف الرسائل',
    'ايقاف التذكير',
    'الغاء التذكير',
    'الغاء المتابعه',
  ];

  return optOutPatterns.some((pattern) => {
    return normalized === pattern ||
           normalized.startsWith(pattern + ' ') ||
           normalized.endsWith(' ' + pattern) ||
           normalized.includes(' ' + pattern + ' ');
  });
}

/**
 * Check if a phone number is registered in permanent opt-outs
 */
async function isPhoneOptedOut(phone, storeId = null) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return false;

  try {
    let query = supabase
      .from('cart_opt_outs')
      .select('id')
      .eq('phone', normalizedPhone);

    if (storeId) {
      query = query.or(`store_id.eq.${storeId},store_id.is.null`);
    }

    const { data, error } = await query.limit(1).maybeSingle();
    if (error) {
      logger.warn(`[AbandonedCartService] isPhoneOptedOut warning: ${error.message}`);
      return false;
    }

    return Boolean(data);
  } catch (err) {
    logger.warn(`[AbandonedCartService] isPhoneOptedOut exception: ${err.message}`);
    return false;
  }
}

/**
 * Opt-out customer from future reminders permanently if they reply "إيقاف" / "ايقاف" / "stop"
 */
async function optOutCustomer(phone, storeId = null) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return;

  try {
    // 1. Permanently register in cart_opt_outs table
    await supabase
      .from('cart_opt_outs')
      .upsert({
        phone: normalizedPhone,
        store_id: storeId || null,
        reason: 'customer_requested_stop',
      }, { onConflict: 'phone,store_id' })
      .catch((err) => logger.warn(`[AbandonedCartService] opt_out upsert warning: ${err.message}`));

    // 2. Mark any active/abandoned cart sessions as expired
    let query = supabase
      .from('cart_sessions')
      .update({
        status: 'expired',
        updated_at: new Date().toISOString(),
      })
      .eq('phone', normalizedPhone);

    if (storeId) {
      query = query.eq('store_id', storeId);
    }

    const { error } = await query;
    if (error) {
      logger.warn(`[AbandonedCartService] optOutCustomer session update error: ${error.message}`);
    }
  } catch (err) {
    logger.warn(`[AbandonedCartService] optOutCustomer exception: ${err.message}`);
  }
}

module.exports = {
  normalizePhone,
  isOptOutMessage,
  isPhoneOptedOut,
  syncDraft,
  recoverCart,
  markConverted,
  optOutCustomer,
};
