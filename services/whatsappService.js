const { 
  makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  BufferJSON,
  initAuthCreds,
  proto,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const logger = require('../utils/logger');
const path = require('path');
const { default: PQueue } = require('p-queue');
const { supabase } = require('./supabase');

// ✅ Initialize Supabase for Session Storage
class WhatsappService {
  constructor() {
    this.sock = null;
    this.isReady = false;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 10;
    this.lastQR = null;
    this.pairingCode = null;
    this.connectionState = 'close';
    this.sessionId = 'main_whatsapp_session'; // ✅ Unique ID for session in DB
    this.isInitializing = false;
    
    this.queue = new PQueue({ 
      concurrency: 1, 
      interval: 1000, 
      intervalCap: 1,
      maxSize: 100 
    });
  }

  // ✅ High-Performance DB-backed Auth State with Batch Queries
  async useSupabaseAuthState() {
    const writeData = async (data, key) => {
      try {
        const id = `${this.sessionId}:${key}`;
        const content = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await supabase
          .from('whatsapp_sessions')
          .upsert({ id, data: content, updated_at: new Date() });
      } catch (err) {
        logger.error(`Error writing session data for ${key}:`, err.message);
      }
    };

    const readData = async (key) => {
      try {
        const id = `${this.sessionId}:${key}`;
        const { data, error } = await supabase
          .from('whatsapp_sessions')
          .select('data')
          .eq('id', id)
          .maybeSingle();
        
        if (error || !data) return null;
        return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
      } catch (err) {
        return null;
      }
    };

    const removeData = async (key) => {
      try {
        const id = `${this.sessionId}:${key}`;
        await supabase.from('whatsapp_sessions').delete().eq('id', id);
      } catch (err) {
        logger.error(`Error removing session data for ${key}:`, err.message);
      }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const data = {};
            if (!ids || ids.length === 0) return data;

            try {
              const fullIds = ids.map(id => `${this.sessionId}:${type}-${id}`);
              const { data: rows, error } = await supabase
                .from('whatsapp_sessions')
                .select('id, data')
                .in('id', fullIds);

              if (!error && rows) {
                const prefix = `${this.sessionId}:${type}-`;
                for (const row of rows) {
                  const rawId = row.id.replace(prefix, '');
                  let value = JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
                  if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                  }
                  data[rawId] = value;
                }
              }
            } catch (err) {
              logger.error(`Error in batch get for ${type}:`, err.message);
            }

            return data;
          },
          set: async (data) => {
            const upserts = [];
            const deletes = [];

            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const key = `${this.sessionId}:${category}-${id}`;
                if (value) {
                  upserts.push({
                    id: key,
                    data: JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
                    updated_at: new Date()
                  });
                } else {
                  deletes.push(key);
                }
              }
            }

            try {
              // Batch upsert in chunks of 50 to avoid any payload limits
              if (upserts.length > 0) {
                for (let i = 0; i < upserts.length; i += 50) {
                  const batch = upserts.slice(i, i + 50);
                  await supabase.from('whatsapp_sessions').upsert(batch);
                }
              }
              if (deletes.length > 0) {
                for (let i = 0; i < deletes.length; i += 50) {
                  const batch = deletes.slice(i, i + 50);
                  await supabase.from('whatsapp_sessions').delete().in('id', batch);
                }
              }
            } catch (err) {
              logger.error('Error in batch set session data:', err.message);
            }
          }
        }
      },
      saveCreds: () => writeData(creds, 'creds')
    };
  }

  async initialize() {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      logger.info(`🔐 Initializing WhatsApp with Supabase persistent storage...`);
      
      // Clean up any old socket listeners before creating a new one
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          this.sock.end();
        } catch (e) {
          // ignore cleanup errors
        }
        this.sock = null;
      }

      const { state, saveCreds } = await this.useSupabaseAuthState();

      let version = [2, 3000, 1045310503];
      try {
        if (typeof fetchLatestWaWebVersion === 'function') {
          const v = await fetchLatestWaWebVersion();
          if (v?.version) version = v.version;
        } else if (typeof fetchLatestBaileysVersion === 'function') {
          const v = await fetchLatestBaileysVersion();
          if (v?.version) version = v.version;
        }
      } catch (e) {
        logger.warn('Failed to fetch WA Web version dynamically, using fallback:', e.message);
      }

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
        syncFullHistory: false
      });
      this.connectionState = 'connecting';

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection) this.connectionState = connection;

        if (qr) {
          this.lastQR = qr;
          logger.info('New QR Code available at /qr');
        }

        if (connection === 'close') {
          const error = lastDisconnect?.error;
          const statusCode = (error instanceof Boom) 
            ? error.output.statusCode 
            : (error?.statusCode || 0);

          logger.warn(`WhatsApp connection closed. Status: ${statusCode}. Message: ${error?.message || 'none'}`);

          this.isReady = false;
          this.pairingCode = null;

          // 1. Session logged out — clean DB and recreate fresh
          if (statusCode === DisconnectReason.loggedOut) {
            logger.warn('WhatsApp session logged out. Purging old session from DB...');
            await supabase.from('whatsapp_sessions').delete().like('id', `${this.sessionId}:%`).catch(() => {});
            this.reconnectAttempts = 0;
            this.lastQR = null;
            setTimeout(() => this.initialize(), 1000);
            return;
          }

          // 2. Restart required (status 515) — happens right after QR scan or pairing! Must restart immediately.
          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            logger.info('🔄 Restart required by WhatsApp protocol (handshake completed). Reconnecting immediately...');
            setTimeout(() => this.initialize(), 500);
            return;
          }

          // 3. General reconnection with reasonable backoff
          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            const delay = Math.min(Math.pow(2, Math.min(this.reconnectAttempts, 4)) * 1000, 15000);
            logger.info(`Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(() => this.initialize(), delay);
          } else {
            logger.error('Max reconnection attempts reached. Please use /qr/reset to start fresh.');
          }
        } else if (connection === 'open') {
          logger.info('✅ WhatsApp connection opened successfully (Persistent)');
          this.isReady = true;
          this.reconnectAttempts = 0;
          this.lastQR = null;
          this.pairingCode = null;
        }
      });

      this.sock.ev.on('creds.update', saveCreds);
    } catch (err) {
      logger.error('Error during WhatsApp initialization:', err.message);
    } finally {
      this.isInitializing = false;
    }
  }

  // ✅ New Method: Request Pairing Code via Phone Number
  async requestPairingCode(phoneNumber) {
    try {
      if (this.isReady) throw new Error('WhatsApp is already connected.');

      const cleanNumber = String(phoneNumber || '').replace(/\D/g, '');
      if (!/^\d{8,15}$/.test(cleanNumber)) {
        throw new Error('رقم الهاتف غير صالح. استخدم الرقم الدولي بدون + أو مسافات.');
      }

      // Ensure socket is initialized, then give Baileys time to establish its
      // WebSocket before asking WhatsApp for a pairing code.
      if (!this.sock) await this.initialize();

      const deadline = Date.now() + 30000;
      while (this.sock && this.connectionState === 'close' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!this.sock || this.connectionState === 'close') {
        throw new Error('تعذر إنشاء اتصال واتساب. اضغط إعادة تعيين الجلسة ثم حاول مرة أخرى.');
      }

      const code = await this.sock.requestPairingCode(cleanNumber);
      this.pairingCode = code;
      return code;
    } catch (error) {
      logger.error('Failed to request pairing code:', error.message);
      throw error;
    }
  }

  // ✅ New Method: Get Connection Status
  getStatus() {
    if (this.isReady) return 'connected';
    if (this.sock && this.reconnectAttempts > 0) return 'connecting';
    return 'disconnected';
  }

  // ✅ Send via Queue with automatic retries
  async sendMessage(to, text, retries = 3) {
    return this.queue.add(async () => {
      let lastError;
      
      for (let i = 0; i < retries; i++) {
        try {
          if (!this.isReady) {
            logger.warn(`WhatsApp not ready, attempt ${i + 1} of ${retries}. Waiting for reconnection...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for auto-reconnect
            if (!this.isReady) throw new Error('خدمة واتساب غير جاهزة حالياً');
          }

          let cleanedTo = to.replace(/\D/g, '');
          if (cleanedTo.startsWith('01') && cleanedTo.length === 11) {
            cleanedTo = '2' + cleanedTo;
          }
          const formattedId = `${cleanedTo}@s.whatsapp.net`;
          await this.sock.sendMessage(formattedId, { text });
          logger.info(`Message sent successfully to ${to.slice(0, 6)}XXXX (Attempt ${i + 1})`);
          return true;
        } catch (error) {
          lastError = error;
          logger.error(`Retry ${i + 1}/${retries} failed for ${to.slice(0, 6)}XXXX: ${error.message}`);
          if (i < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500)); // Delay between retries
          }
        }
      }
      
      throw lastError || new Error('فشل الإرسال بعد عدة محاولات');
    });
  }

  async shutdown() {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end();
      } catch (e) {}
      this.sock = null;
      this.isReady = false;
      this.connectionState = 'close';
    }
  }
}

const instance = new WhatsappService();
module.exports = instance;
