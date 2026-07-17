const { z } = require('zod');
const { supabase } = require('./supabase');

const ipSchema = z.string().trim().min(3).max(64);
const reasonSchema = z.string().trim().max(300).optional();
const logFilterSchema = z.enum(['all', 'registered', 'guest']).default('all');

async function listBlockedIps(storeId) {
  const { data, error } = await supabase
    .from('blocked_ips')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function blockIp(storeId, payload) {
  const ipAddress = ipSchema.parse(payload?.ip_address);
  const reason = reasonSchema.parse(payload?.reason) || 'Manual block';

  const { data, error } = await supabase
    .from('blocked_ips')
    .insert({
      ip_address: ipAddress,
      reason,
      store_id: storeId
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function unblockIpById(storeId, id) {
  const { error } = await supabase
    .from('blocked_ips')
    .delete()
    .eq('id', id)
    .eq('store_id', storeId);

  if (error) throw error;
  return { deleted: true };
}

async function unblockIpAddress(storeId, ipAddress) {
  const parsedIp = ipSchema.parse(ipAddress);
  const { error } = await supabase
    .from('blocked_ips')
    .delete()
    .eq('ip_address', parsedIp)
    .eq('store_id', storeId);

  if (error) throw error;
  return { deleted: true };
}

async function listLoginLogs(storeId, { page = 0, pageSize = 20, filter = 'all' } = {}) {
  const safePage = Math.max(0, Number(page) || 0);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const safeFilter = logFilterSchema.parse(filter || 'all');
  const from = safePage * safePageSize;
  const to = from + safePageSize - 1;

  let query = supabase
    .from('user_login_logs')
    .select('*', { count: 'exact' })
    .eq('store_id', storeId);

  if (safeFilter === 'registered') query = query.in('login_method', ['email', 'google', 'admin']);
  if (safeFilter === 'guest') query = query.eq('login_method', 'guest');

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw error;
  return { logs: data || [], total: count || 0 };
}

async function deleteLoginLog(storeId, id) {
  const { error } = await supabase
    .from('user_login_logs')
    .delete()
    .eq('id', id)
    .eq('store_id', storeId);

  if (error) throw error;
  return { deleted: true };
}

async function pruneLoginLogs(storeId, keepLatest = 500) {
  const keep = Math.min(5000, Math.max(1, Number(keepLatest) || 500));
  const { data: rows, error: listError } = await supabase
    .from('user_login_logs')
    .select('id')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .range(keep, keep + 10000);

  if (listError) throw listError;
  const ids = (rows || []).map((row) => row.id);
  if (ids.length === 0) return { deleted: 0 };

  const { error } = await supabase
    .from('user_login_logs')
    .delete()
    .eq('store_id', storeId)
    .in('id', ids);

  if (error) throw error;
  return { deleted: ids.length };
}

module.exports = {
  listBlockedIps,
  blockIp,
  unblockIpById,
  unblockIpAddress,
  listLoginLogs,
  deleteLoginLog,
  pruneLoginLogs
};
