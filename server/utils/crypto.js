const crypto = require('crypto');

/**
 * Encrypts a JSON object symmetrically using AES-256-GCM.
 * Outputs a string format of 'iv:tag:ciphertext' (hex-encoded).
 */
function encryptCredentials(dataObj, secretKey) {
  if (!secretKey || Buffer.byteLength(secretKey, 'utf8') < 32) {
    throw new Error('Encryption key must be at least 32 bytes long.');
  }
  try {
    const iv = crypto.randomBytes(12); // Standard IV size for GCM is 12 bytes
    const key = crypto.scryptSync(secretKey, 'salt', 32); // Derive a secure 32-byte key
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(dataObj), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag().toString('hex'); // 16-byte authentication tag
    
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
  } catch (err) {
    console.error('Encryption failed:', err.message);
    throw err;
  }
}

/**
 * Decrypts a symmetrically encrypted GCM string using the secretKey.
 * Verifies authenticity tag and parsed payload integrity.
 */
function decryptCredentials(encryptedString, secretKey) {
  if (!encryptedString) return {};
  if (!secretKey || Buffer.byteLength(secretKey, 'utf8') < 32) {
    throw new Error('Encryption key must be at least 32 bytes long.');
  }
  try {
    const parts = encryptedString.split(':');
    if (parts.length !== 3) {
      // Fallback to parse directly as JSON if unencrypted
      try {
        return JSON.parse(encryptedString);
      } catch {
        throw new Error('Invalid encrypted format.');
      }
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    
    const key = crypto.scryptSync(secretKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return {};
  }
}

function getEncryptionKeyForVersion(version) {
  const versionKey = process.env[`DATABASE_ENCRYPTION_KEY_V${version}`];
  if (versionKey) {
    if (Buffer.byteLength(versionKey, 'utf8') < 32) {
      throw new Error(`DATABASE_ENCRYPTION_KEY_V${version} must be at least 32 bytes long.`);
    }
    return versionKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing encryption key for version ${version}`);
  }
  return process.env.DATABASE_ENCRYPTION_KEY;
}

module.exports = {
  encryptCredentials,
  decryptCredentials,
  getEncryptionKeyForVersion
};
