/**
 * twoFactorService.js
 * Handles 2FA logic: TOTP (Google Authenticator) + WhatsApp OTP
 */
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { supabase } = require('./supabase');
const logger = require('../utils/logger');
const otpService = require('./otpService');

// Encrypt/decrypt TOTP secret using AES-256
const ENCRYPTION_KEY = Buffer.from(
  (process.env.DATABASE_ENCRYPTION_KEY || '').substring(0, 64).padEnd(64, '0'),
  'hex'
).slice(0, 32);

function encryptSecret(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptSecret(text) {
  const [ivHex, encHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function generateBackupCodes(count = 8) {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
}

async function get2FAStatus(userId, storeId) {
  const { data, error } = await supabase
    .from('user_2fa_settings')
    .select('is_enabled, method, totp_verified')
    .eq('user_id', userId)
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) throw error;
  return {
    is_enabled: data?.is_enabled || false,
    method: data?.method || 'whatsapp',
    totp_configured: data?.totp_verified || false,
  };
}

async function setupTOTP(userId, storeId, storeName, userEmail) {
  const secret = speakeasy.generateSecret({
    name: storeName + ' (' + userEmail + ')',
    issuer: 'EG Parts',
    length: 32,
  });
  const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
  await supabase
    .from('user_2fa_settings')
    .upsert([{
      user_id: userId,
      store_id: storeId,
      is_enabled: false,
      method: 'totp',
      totp_secret: encryptSecret(secret.base32),
      totp_verified: false,
      updated_at: new Date().toISOString(),
    }], { onConflict: 'user_id,store_id' });
  return { secret: secret.base32, qr_code: qrCodeUrl };
}

async function verifyTOTPSetup(userId, storeId, token) {
  const { data, error } = await supabase
    .from('user_2fa_settings')
    .select('totp_secret')
    .eq('user_id', userId)
    .eq('store_id', storeId)
    .maybeSingle();
  if (error || !data?.totp_secret) throw new Error('لم يتم إعداد TOTP بعد');
  const secret = decryptSecret(data.totp_secret);
  const isValid = speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 2 });
  if (!isValid) return { success: false };
  const backupCodes = generateBackupCodes(8);
  await supabase.from('user_2fa_settings').update({
    totp_verified: true, is_enabled: true, method: 'totp',
    backup_codes: backupCodes.map(c => encryptSecret(c)),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('store_id', storeId);
  return { success: true, backup_codes: backupCodes };
}

async function enableWhatsApp2FA(userId, storeId) {
  const backupCodes = generateBackupCodes(8);
  await supabase.from('user_2fa_settings').upsert([{
    user_id: userId, store_id: storeId,
    is_enabled: true, method: 'whatsapp',
    totp_secret: null, totp_verified: false,
    backup_codes: backupCodes.map(c => encryptSecret(c)),
    updated_at: new Date().toISOString(),
  }], { onConflict: 'user_id,store_id' });
  return { success: true, backup_codes: backupCodes };
}

async function disable2FA(userId, storeId) {
  await supabase.from('user_2fa_settings').update({
    is_enabled: false, totp_secret: null, totp_verified: false,
    backup_codes: null, updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('store_id', storeId);
  return { success: true };
}

async function sendChallenge(userId, storeId, store) {
  const { data: settings } = await supabase.from('user_2fa_settings')
    .select('method').eq('user_id', userId).eq('store_id', storeId).maybeSingle();
  if (!settings) throw new Error('2FA غير مفعّل');
  if (settings.method === 'whatsapp') {
    const { data: profile } = await supabase.from('user_profiles')
      .select('phone').eq('user_id', userId).eq('store_id', storeId).maybeSingle();
    if (!profile?.phone) throw new Error('رقم الهاتف غير موجود في حسابك');
    const phone = '2' + profile.phone;
    await otpService.sendOTP(phone, store);
    return { method: 'whatsapp', phone_hint: '*****' + profile.phone.slice(-3) };
  }
  return { method: 'totp' };
}

async function verifyChallenge(userId, storeId, token, store) {
  const { data: settings } = await supabase.from('user_2fa_settings')
    .select('method, totp_secret, backup_codes')
    .eq('user_id', userId).eq('store_id', storeId).maybeSingle();
  if (!settings) throw new Error('2FA غير مفعّل');
  if (settings.backup_codes) {
    for (let i = 0; i < settings.backup_codes.length; i++) {
      try {
        const decrypted = decryptSecret(settings.backup_codes[i]);
        if (decrypted === token.toUpperCase()) {
          const newCodes = [...settings.backup_codes];
          newCodes.splice(i, 1);
          await supabase.from('user_2fa_settings')
            .update({ backup_codes: newCodes, updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('store_id', storeId);
          return { success: true, used_backup_code: true };
        }
      } catch (_) {}
    }
  }
  if (settings.method === 'whatsapp') {
    const { data: profile } = await supabase.from('user_profiles')
      .select('phone').eq('user_id', userId).eq('store_id', storeId).maybeSingle();
    if (!profile?.phone) throw new Error('رقم الهاتف غير موجود');
    const phone = '2' + profile.phone;
    const isValid = await otpService.verifyOTP(phone, token, store);
    return { success: isValid };
  }
  if (settings.method === 'totp') {
    if (!settings.totp_secret) throw new Error('TOTP غير مُعدّ');
    const secret = decryptSecret(settings.totp_secret);
    const isValid = speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 2 });
    return { success: isValid };
  }
  return { success: false };
}

module.exports = { get2FAStatus, setupTOTP, verifyTOTPSetup, enableWhatsApp2FA, disable2FA, sendChallenge, verifyChallenge };
