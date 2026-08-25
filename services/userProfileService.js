const { supabase } = require('./supabase');
const phoneVerificationService = require('./phoneVerificationService');

const DEFAULT_STORE_ID = '00000000-0000-0000-0000-000000000000';

function getMetadata(decodedUser) {
  return decodedUser?.user_metadata || decodedUser?.app_metadata || {};
}

function isEmailVerified(decodedUser) {
  return Boolean(
    decodedUser?.email_confirmed_at ||
    decodedUser?.confirmed_at ||
    decodedUser?.email_verified ||
    decodedUser?.app_metadata?.provider === 'google'
  );
}

async function loadAuthUser(decodedUser) {
  const { data, error } = await supabase.auth.admin.getUserById(decodedUser.sub);
  if (error || !data?.user) return decodedUser;

  return {
    ...decodedUser,
    email: data.user.email || decodedUser.email,
    email_confirmed_at: data.user.email_confirmed_at || decodedUser.email_confirmed_at,
    confirmed_at: data.user.confirmed_at || decodedUser.confirmed_at,
    app_metadata: {
      ...(decodedUser.app_metadata || {}),
      ...(data.user.app_metadata || {})
    },
    user_metadata: {
      ...(decodedUser.user_metadata || {}),
      ...(data.user.user_metadata || {})
    }
  };
}

async function fetchProfile(userId, storeId) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .eq('store_id', storeId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function syncUserProfile(decodedUser, storeId) {
  if (!decodedUser?.sub) {
    const err = new Error('Authenticated user is required');
    err.statusCode = 401;
    throw err;
  }

  const userId = decodedUser.sub;
  if (!storeId) {
    const err = new Error('Tenant context is required');
    err.statusCode = 400;
    throw err;
  }
  const targetStoreId = storeId;
  const authUser = await loadAuthUser(decodedUser);
  const existingProfile = await fetchProfile(userId, targetStoreId);
  const metadata = getMetadata(authUser);
  const googleAvatar = metadata.avatar_url || metadata.picture || '';

  if (!existingProfile) {
    // Check if there is a verified phone for this user in account_phone_verifications
    let initialPhone = null;
    try {
      const { data: verif } = await supabase
        .from('account_phone_verifications')
        .select('phone_e164')
        .eq('user_id', userId)
        .maybeSingle();

      if (verif?.phone_e164) {
        initialPhone = verif.phone_e164.startsWith('20') ? verif.phone_e164.slice(2) : verif.phone_e164;
      } else if (metadata.phone) {
        const norm = phoneVerificationService.normalizeEgyptianPhone(metadata.phone);
        initialPhone = norm.startsWith('20') ? norm.slice(2) : norm;
      }
    } catch {
      initialPhone = null;
    }

    const insertPayload = {
      user_id: userId,
      store_id: targetStoreId,
      full_name: metadata.full_name || metadata.name || '',
      email: authUser.email || metadata.email || null,
      phone: initialPhone,
      city: metadata.city || null,
      address: metadata.address || null,
      role: 'user',
      is_email_verified: isEmailVerified(authUser),
      created_at: new Date().toISOString()
    };

    if (googleAvatar) insertPayload.avatar_url = googleAvatar;

    let { data, error } = await supabase
      .from('user_profiles')
      .insert(insertPayload)
      .select()
      .maybeSingle();

    if (error && (error.code === 'PGRST204' || error.message?.includes('avatar_url'))) {
      delete insertPayload.avatar_url;
      const retry = await supabase
        .from('user_profiles')
        .insert(insertPayload)
        .select()
        .maybeSingle();
      data = retry.data;
      error = retry.error;
    }

    // If initialPhone causes a duplicate/conflict error (23505),
    // retry profile creation with phone = null so user profile creation never crashes.
    if (error && error.code === '23505' && insertPayload.phone) {
      insertPayload.phone = null;
      const retryWithoutPhone = await supabase
        .from('user_profiles')
        .insert(insertPayload)
        .select()
        .maybeSingle();
      if (retryWithoutPhone.error) throw retryWithoutPhone.error;
      return retryWithoutPhone.data;
    }

    if (error) throw error;
    return data;
  }

  if (googleAvatar && !existingProfile.avatar_url) {
    const { data, error } = await supabase
      .from('user_profiles')
      .update({ avatar_url: googleAvatar })
      .eq('id', existingProfile.id)
      .select()
      .maybeSingle();

    if (!error && data) return data;
  }

  return existingProfile;
}

async function markEmailVerified(decodedUser, storeId) {
  if (!decodedUser?.sub) {
    const err = new Error('Authenticated user is required');
    err.statusCode = 401;
    throw err;
  }

  if (!storeId) {
    const err = new Error('Tenant context is required');
    err.statusCode = 400;
    throw err;
  }
  const targetStoreId = storeId;
  const profile = await syncUserProfile(decodedUser, targetStoreId);

  const { data, error } = await supabase
    .from('user_profiles')
    .update({ is_email_verified: true })
    .eq('user_id', decodedUser.sub)
    .eq('store_id', targetStoreId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data || profile;
}

async function updateProfilePhone(decodedUser, storeId, phone) {
  if (!decodedUser?.sub) {
    const err = new Error('Authenticated user is required');
    err.statusCode = 401;
    throw err;
  }
  if (!phone) {
    const err = new Error('Phone is required');
    err.statusCode = 400;
    throw err;
  }

  if (!storeId) {
    const err = new Error('Tenant context is required');
    err.statusCode = 400;
    throw err;
  }

  const phoneE164 = phoneVerificationService.normalizeEgyptianPhone(phone);
  const localPhone = phoneE164.startsWith('20') ? phoneE164.slice(2) : phoneE164;
  const targetStoreId = storeId;
  const userId = decodedUser.sub;

  const authUser = await loadAuthUser(decodedUser);
  const metadata = getMetadata(authUser);
  const existingProfile = await fetchProfile(userId, targetStoreId);

  let updatedProfile;
  if (!existingProfile) {
    const insertPayload = {
      user_id: userId,
      store_id: targetStoreId,
      full_name: metadata.full_name || metadata.name || '',
      email: authUser.email || metadata.email || null,
      phone: localPhone,
      city: metadata.city || null,
      address: metadata.address || null,
      role: 'user',
      is_email_verified: isEmailVerified(authUser),
      created_at: new Date().toISOString()
    };
    const googleAvatar = metadata.avatar_url || metadata.picture || '';
    if (googleAvatar) insertPayload.avatar_url = googleAvatar;

    let { data, error } = await supabase
      .from('user_profiles')
      .insert(insertPayload)
      .select()
      .maybeSingle();

    if (error && (error.code === 'PGRST204' || error.message?.includes('avatar_url'))) {
      delete insertPayload.avatar_url;
      const retry = await supabase
        .from('user_profiles')
        .insert(insertPayload)
        .select()
        .maybeSingle();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      if (error.code === '23505') {
        const err = new Error('رقم الهاتف هذا مرتبط بحساب آخر بالفعل.');
        err.statusCode = 409;
        throw err;
      }
      throw error;
    }
    updatedProfile = data;
  } else {
    const { data, error } = await supabase
      .from('user_profiles')
      .update({ phone: localPhone })
      .eq('id', existingProfile.id)
      .select()
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        const err = new Error('رقم الهاتف هذا مرتبط بحساب آخر بالفعل.');
        err.statusCode = 409;
        throw err;
      }
      throw error;
    }
    updatedProfile = data;
  }

  // Keep auth.users metadata and phone verifications updated
  try {
    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...(metadata || {}),
        phone: phoneE164
      }
    });
  } catch (metaErr) {
    console.warn('[updateProfilePhone] Failed to update auth metadata:', metaErr.message);
  }

  try {
    await phoneVerificationService.recordVerifiedPhone(userId, phoneE164, 'whatsapp_otp');
  } catch (verifErr) {
    console.warn('[updateProfilePhone] recordVerifiedPhone note:', verifErr.message);
  }

  return updatedProfile;
}

module.exports = {
  DEFAULT_STORE_ID,
  syncUserProfile,
  markEmailVerified,
  updateProfilePhone
};
