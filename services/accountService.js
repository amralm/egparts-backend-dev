const { supabase } = require('./supabase');

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
  const targetStoreId = storeId || '00000000-0000-0000-0000-000000000000';
  const { data, error } = await supabase
    .from('user_profiles')
    .update({
      phone: profile.phone,
      full_name: profile.name,
      city: profile.city,
      address: profile.address
    })
    .eq('user_id', userId)
    .eq('store_id', targetStoreId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function listAddresses(userId) {
  const { data, error } = await supabase
    .from('user_addresses')
    .select('*')
    .eq('user_id', userId)
    .order('is_default', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function saveAddress(userId, addressId, payload, storeId) {
  // store_id is NOT NULL in user_addresses — always pass it
  const targetStoreId = storeId || payload.store_id || '00000000-0000-0000-0000-000000000000';

  const data = {
    user_id: userId,
    store_id: targetStoreId,
    title: payload.title,
    phone: payload.phone,
    city: payload.city,
    address: payload.address,
    is_default: Boolean(payload.is_default)
  };

  if (addressId) {
    const updated = await supabase
      .from('user_addresses')
      .update(data)
      .eq('id', addressId)
      .eq('user_id', userId)
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

async function deleteAddress(userId, addressId) {
  const { error } = await supabase
    .from('user_addresses')
    .delete()
    .eq('id', addressId)
    .eq('user_id', userId);

  if (error) throw error;
}

async function listNotifications(userId, limit = 10) {
  const { data, error } = await supabase
    .from('user_notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function markNotificationsRead(userId) {
  const { data, error } = await supabase
    .from('user_notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .select('*');

  if (error) throw error;
  return data || [];
}

async function recordLogin(storeId, user, body) {
  const { error } = await supabase.from('user_login_logs').insert({
    store_id: storeId || null,
    user_id: user.sub,
    email: user.email || body?.email || null,
    ip_address: body?.ip_address || null,
    user_agent: body?.user_agent || null,
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
