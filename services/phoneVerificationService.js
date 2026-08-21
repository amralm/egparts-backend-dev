const crypto = require('crypto');
const { supabase } = require('./supabase');

const TICKET_TTL_MINUTES = 10;

function normalizeEgyptianPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `2${digits}`;
  if (digits.startsWith('1') && digits.length === 10) digits = `20${digits}`;
  if (!/^20\d{10}$/.test(digits)) {
    const error = new Error('رقم هاتف مصري غير صالح');
    error.statusCode = 400;
    error.code = 'INVALID_PHONE';
    throw error;
  }
  return digits;
}

function hashTicket(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function recordVerifiedPhone(userId, phone, method = 'whatsapp_otp') {
  if (!userId) throw new Error('A user is required to record phone verification');
  const phoneE164 = normalizeEgyptianPhone(phone);

  const { data: owner, error: ownerError } = await supabase
    .from('account_phone_verifications')
    .select('user_id')
    .eq('phone_e164', phoneE164)
    .neq('user_id', userId)
    .maybeSingle();
  if (ownerError) throw ownerError;
  if (owner) {
    const error = new Error('هذا الرقم موثق بالفعل لحساب آخر');
    error.statusCode = 409;
    error.code = 'PHONE_ALREADY_VERIFIED';
    throw error;
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('account_phone_verifications')
    .upsert({
      user_id: userId,
      phone_e164: phoneE164,
      verification_method: method,
      verified_at: now,
      last_verified_at: now,
      updated_at: now
    }, { onConflict: 'user_id' })
    .select('user_id, phone_e164, verified_at, last_verified_at, verification_method')
    .single();
  if (error) {
    if (error.code === '23505') {
      const conflict = new Error('هذا الرقم موثق بالفعل لحساب آخر');
      conflict.statusCode = 409;
      conflict.code = 'PHONE_ALREADY_VERIFIED';
      throw conflict;
    }
    throw error;
  }
  return data;
}

async function issueTicket(phone, storeId, purpose = 'signup') {
  const phoneE164 = normalizeEgyptianPhone(phone);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TICKET_TTL_MINUTES * 60 * 1000).toISOString();
  const { error } = await supabase.from('phone_verification_tickets').insert({
    ticket_hash: hashTicket(token),
    phone_e164: phoneE164,
    store_id: storeId,
    purpose,
    expires_at: expiresAt
  });
  if (error) throw error;
  return { token, expiresAt };
}

async function claimTicket(userId, token, phone) {
  if (!userId || !token) {
    const error = new Error('بيانات إثبات الهاتف غير مكتملة');
    error.statusCode = 400;
    error.code = 'PHONE_VERIFICATION_TICKET_REQUIRED';
    throw error;
  }
  const phoneE164 = normalizeEgyptianPhone(phone);
  const { data, error: rpcError } = await supabase.rpc('claim_phone_verification_ticket', {
    p_user_id: userId,
    p_phone_e164: phoneE164,
    p_store_id: null,
    p_ticket_hash: hashTicket(token)
  });
  if (rpcError) {
    const error = new Error('انتهت صلاحية إثبات الهاتف أو تم استخدامه من قبل');
    error.statusCode = rpcError.code === '23505' ? 409 : 400;
    error.code = rpcError.code === '23505' ? 'PHONE_ALREADY_VERIFIED' : 'PHONE_VERIFICATION_TICKET_INVALID';
    throw error;
  }
  return Array.isArray(data) ? data[0] : data;
}

async function claimPendingPhone(userId, phone, storeId) {
  const phoneE164 = normalizeEgyptianPhone(phone);
  const { data, error } = await supabase.rpc('claim_phone_verification_ticket', {
    p_user_id: userId,
    p_phone_e164: phoneE164,
    p_store_id: storeId,
    p_ticket_hash: null
  });
  if (error) {
    if (error.code === 'P0001') return null;
    throw error;
  }
  return Array.isArray(data) ? data[0] : data;
}

async function isVerifiedForUser(userId, phone) {
  const phoneE164 = normalizeEgyptianPhone(phone);
  const { data, error } = await supabase
    .from('account_phone_verifications')
    .select('user_id, phone_e164')
    .eq('user_id', userId)
    .eq('phone_e164', phoneE164)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function getStatus(userId, storeId) {
  const [{ data: verification, error: verificationError }, { data: profile, error: profileError }] = await Promise.all([
    supabase.from('account_phone_verifications').select('phone_e164, verified_at, last_verified_at, verification_method').eq('user_id', userId).maybeSingle(),
    supabase.from('user_profiles').select('phone').eq('user_id', userId).eq('store_id', storeId).maybeSingle()
  ]);
  if (verificationError) throw verificationError;
  if (profileError) throw profileError;
  return {
    status: verification ? 'verified' : (profile?.phone ? 'legacy_unverified' : 'unverified'),
    phone: verification?.phone_e164 || profile?.phone || null,
    verified_at: verification?.verified_at || null,
    last_verified_at: verification?.last_verified_at || null,
    verification_method: verification?.verification_method || null
  };
}

module.exports = {
  normalizeEgyptianPhone,
  recordVerifiedPhone,
  issueTicket,
  claimTicket,
  claimPendingPhone,
  isVerifiedForUser,
  getStatus
};
