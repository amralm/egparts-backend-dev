const { supabase } = require('./supabase');

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
  const targetStoreId = storeId || DEFAULT_STORE_ID;
  const authUser = await loadAuthUser(decodedUser);
  const existingProfile = await fetchProfile(userId, targetStoreId);
  const metadata = getMetadata(authUser);
  const googleAvatar = metadata.avatar_url || metadata.picture || '';

  if (!existingProfile) {
    const masterProfile = targetStoreId === DEFAULT_STORE_ID
      ? null
      : await fetchProfile(userId, DEFAULT_STORE_ID);

    const insertPayload = {
      user_id: userId,
      store_id: targetStoreId,
      full_name: masterProfile?.full_name || metadata.full_name || metadata.name || '',
      email: authUser.email || metadata.email || null,
      phone: masterProfile?.phone || metadata.phone || null,
      city: masterProfile?.city || null,
      address: masterProfile?.address || null,
      role: 'user',
      is_email_verified: isEmailVerified(authUser),
      created_at: new Date().toISOString()
    };

    if (googleAvatar) insertPayload.avatar_url = googleAvatar;

    const { data, error } = await supabase
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
      if (retry.error) throw retry.error;
      return retry.data;
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

  const targetStoreId = storeId || DEFAULT_STORE_ID;
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

  const targetStoreId = storeId || DEFAULT_STORE_ID;
  await syncUserProfile(decodedUser, targetStoreId);

  const { data, error } = await supabase
    .from('user_profiles')
    .update({ phone })
    .eq('user_id', decodedUser.sub)
    .eq('store_id', targetStoreId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

module.exports = {
  DEFAULT_STORE_ID,
  syncUserProfile,
  markEmailVerified,
  updateProfilePhone
};
