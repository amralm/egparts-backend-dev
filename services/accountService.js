const { supabase } = require('./supabase');
const phoneVerificationService = require('./phoneVerificationService');

async function getProfileStatus(storeId, userId) {
  const query = supabase
    .from('user_profiles')
    .select('phone, full_name, city, address')
    .eq('user_id', userId);

  if (storeId) query.eq('store_id', storeId);

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;

  return {
    has_phone: Boolean(data?.phone),
    profile: data ? {
      phone: data.phone || null,
      name: data.full_name || null,
      city: data.city || null,
      address: data.address || null
    } : null
  };
}

async function updateProfile(storeId, userId, profile) {
  if (!storeId) throw new Error('Tenant context required');
  const targetStoreId = storeId;
  const normalizedProfile = { ...profile };
  if (profile.phone) {
    const { data: current } = await supabase
      .from('user_profiles')
      .select('phone')
      .eq('user_id', userId)
      .eq('store_id', targetStoreId)
      .maybeSingle();
    const currentPhone = current?.phone ? phoneVerificationService.normalizeEgyptianPhone(current.phone) : null;
    const requestedPhone = phoneVerificationService.normalizeEgyptianPhone(profile.phone);
    if (requestedPhone !== currentPhone) {
      const isVerified = await phoneVerificationService.isVerifiedForUser(userId, requestedPhone);
      if (!isVerified) {
        const pending = await phoneVerificationService.claimPendingPhone(userId, requestedPhone, targetStoreId);
        if (!pending) {
          const error = new Error('يجب تأكيد الرقم عبر واتساب قبل حفظه');
          error.statusCode = 403;
          error.code = 'PHONE_VERIFICATION_REQUIRED';
          throw error;
        }
      }
    }
    // user_profiles stores the local Egyptian format used by legacy rows and
    // the database trigger. Persist the canonical local value explicitly.
    normalizedProfile.phone = requestedPhone.slice(2);
  }

  // Fetch current avatar to detect replacement
  const { data: currentProfile } = await supabase
    .from('user_profiles')
    .select('avatar_url')
    .eq('user_id', userId)
    .eq('store_id', targetStoreId)
    .maybeSingle();

  const payload = {
    user_id: userId,
    store_id: targetStoreId,
    updated_at: new Date().toISOString()
  };
  for (const key of ['phone', 'name', 'city', 'address', 'avatar_url']) {
    if (normalizedProfile[key] !== undefined) {
      payload[key === 'name' ? 'full_name' : key] = normalizedProfile[key];
    }
  }
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(payload, { onConflict: 'user_id,store_id' })
    .select('*')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      const conflict = new Error('رقم الهاتف هذا مرتبط بحساب آخر بالفعل.');
      conflict.statusCode = 409;
      conflict.code = 'PHONE_ALREADY_VERIFIED';
      throw conflict;
    }
    throw error;
  }

  // Clean up replaced avatar from R2
  if (currentProfile?.avatar_url && payload.avatar_url && currentProfile.avatar_url !== payload.avatar_url) {
    const { safeDeleteR2Object } = require('../utils/r2Helper');
    safeDeleteR2Object(currentProfile.avatar_url).catch((delErr) => {
      console.warn('[accountService.updateProfile] Avatar cleanup note:', delErr.message);
    });
  }

  // Synchronize auth.users user_metadata if phone was provided
  if (profile.phone) {
    const requestedPhone = phoneVerificationService.normalizeEgyptianPhone(profile.phone);
    try {
      await supabase.auth.admin.updateUserById(userId, {
        user_metadata: { phone: requestedPhone }
      });
      await phoneVerificationService.recordVerifiedPhone(userId, requestedPhone, 'whatsapp_otp');
    } catch (metaErr) {
      console.warn('[accountService.updateProfile] Sync note:', metaErr.message);
    }
  }

  return data;
}

async function listAddresses(userId, storeId) {
  if (!storeId) throw new Error('Tenant context required');
  const { data, error } = await supabase
    .from('user_addresses')
    .select('*')
    .eq('user_id', userId)
    .eq('store_id', storeId)
    .order('is_default', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function saveAddress(userId, addressId, payload, storeId) {
  if (!storeId) throw new Error('Tenant context required');
  const targetStoreId = storeId;

  const data = {
    user_id: userId,
    store_id: targetStoreId,
    title: payload.title,
    phone: payload.phone,
    city: payload.city,
    address: payload.address,
    is_default: Boolean(payload.is_default),
    location_url: payload.location_url || null
  };

  if (addressId) {
    const updated = await supabase
      .from('user_addresses')
      .update(data)
      .eq('id', addressId)
      .eq('user_id', userId)
      .eq('store_id', storeId)
      .select('*')
      .maybeSingle();
    if (updated.error) throw updated.error;
    return updated.data;
  }

  const inserted = await supabase
    .from('user_addresses')
    .insert([data])
    .select('*')
    .maybeSingle();
  if (inserted.error) throw inserted.error;
  return inserted.data;
}

async function deleteAddress(userId, addressId, storeId) {
  if (!storeId) throw new Error('Tenant context required');
  const { error } = await supabase
    .from('user_addresses')
    .delete()
    .eq('id', addressId)
    .eq('user_id', userId)
    .eq('store_id', storeId);

  if (error) throw error;
}

async function listNotifications(userId, storeId, limit = 10) {
  if (!storeId) throw new Error('Tenant context required');
  const { data, error } = await supabase
    .from('user_notifications')
    .select('*')
    .eq('user_id', userId)
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function markNotificationsRead(userId, storeId) {
  if (!storeId) throw new Error('Tenant context required');
  const { data, error } = await supabase
    .from('user_notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('store_id', storeId)
    .select('*');

  if (error) throw error;
  return data || [];
}

async function recordLogin(storeId, user, body = {}) {
  if (!storeId) throw new Error('Tenant context required');
  const { error } = await supabase.from('user_login_logs').insert({
    store_id: storeId,
    user_id: user.sub,
    email: user.email || null,
    ip_address: body.ip_address || null,
    user_agent: body.user_agent || null,
    login_method: body?.login_method || 'email'
  });

  if (error) throw error;
}

module.exports = {
  getProfileStatus,
  updateProfile,
  listAddresses,
  saveAddress,
  deleteAddress,
  listNotifications,
  markNotificationsRead,
  recordLogin
};
