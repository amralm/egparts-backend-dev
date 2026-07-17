const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const SECRET = process.env.OAUTH_ENCRYPTION_SECRET;

// Fail-fast verification for production deployments
if (process.env.NODE_ENV === 'production' && (!SECRET || SECRET === 'a-very-secure-encryption-secret-32b-key')) {
  console.error('FATAL ERROR: OAUTH_ENCRYPTION_SECRET environment variable is missing or insecure in production!');
  process.exit(1);
}

// Fallback for development/testing environments
const activeSecret = SECRET || 'a-very-secure-encryption-secret-32b-key';

function getSecretKey() {
  return crypto.createHash('sha256').update(activeSecret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const key = getSecretKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag
  };
}

function decrypt(ciphertext, iv, authTag) {
  const key = getSecretKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function signState(stateObj) {
  const payload = JSON.stringify(stateObj);
  const signature = crypto.createHmac('sha256', activeSecret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
}

function verifyState(stateStr) {
  try {
    const raw = JSON.parse(Buffer.from(stateStr, 'base64').toString('utf8'));
    const expectedSig = crypto.createHmac('sha256', activeSecret).update(raw.payload).digest('hex');
    if (raw.signature !== expectedSig) return null;
    return JSON.parse(raw.payload);
  } catch (e) {
    return null;
  }
}

function encryptCredentials(dataObj, keyStr) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(keyStr || process.env.DATABASE_ENCRYPTION_KEY).digest();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(JSON.stringify(dataObj), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag
  };
}

function decryptCredentials(encryptedObj, keyStr) {
  try {
    const key = crypto.createHash('sha256').update(keyStr || process.env.DATABASE_ENCRYPTION_KEY).digest();
    let ciphertext, iv, authTag;
    if (typeof encryptedObj === 'string') {
      const parsed = JSON.parse(encryptedObj);
      ciphertext = parsed.ciphertext;
      iv = parsed.iv;
      authTag = parsed.authTag;
    } else {
      ciphertext = encryptedObj.ciphertext;
      iv = encryptedObj.iv;
      authTag = encryptedObj.authTag;
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (err) {
    console.error('Failed to decrypt credentials:', err.message);
    return null;
  }
}

function getEncryptionKeyForVersion(version) {
  if (!version) return process.env.DATABASE_ENCRYPTION_KEY;
  const envKey = `DATABASE_ENCRYPTION_KEY_V${version}`;
  return process.env[envKey] || process.env.DATABASE_ENCRYPTION_KEY;
}

module.exports = {
  encrypt,
  decrypt,
  signState,
  verifyState,
  encryptCredentials,
  decryptCredentials,
  getEncryptionKeyForVersion
};

