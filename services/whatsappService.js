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
  constructor(options = {}) {
    this.sock = null;
    this.isReady = false;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 10;
    this.lastQR = null;
    this.pairingCode = null;
    this.connectionState = 'close';
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastConnectedAt = null;
    this.isShutdown = false;
    this.lastSavePromise = Promise.resolve();
    this.accountId = options.accountId || null;
    this.sessionId = options.sessionId || (this.accountId ? `whatsapp_account_${this.accountId}` : 'main_whatsapp_session');
    this.storeId = null;
    this.isInitializing = false;
    this.pairingRequestPromise = null;
    
    this.queue = new PQueue({ 
      concurrency: 1, 
      interval: 1000, 
      intervalCap: 1,
      maxSize: 100 
    });
  }

  // ✅ High-Performance DB-backed Auth State with Batch Queries
  async resolveStoreId() {
    if (this.storeId) return this.storeId;

    if (process.env.WHATSAPP_STORE_ID) {
      this.storeId = process.env.WHATSAPP_STORE_ID.trim();
      return this.storeId;
    }

    if (this.accountId) {
      const { data: account, error } = await supabase
        .from('whatsapp_accounts')
        .select('store_id')
        .eq('id', this.accountId)
        .maybeSingle();
      if (error) throw error;
      if (account?.store_id) {
        this.storeId = account.store_id;
        return this.storeId;
      }

      // Central-pool accounts have no tenant owner. Keep their encrypted
      // auth state under the platform system store, while accountId still
      // isolates every WhatsApp session and dispatch job.
      this.storeId = process.env.WHATSAPP_POOL_STORE_ID || '00000000-0000-0000-0000-000000000000';
      return this.storeId;
    }

    throw new Error('WHATSAPP_STORE_ID is required for the legacy WhatsApp service; use whatsappPoolService for multi-tenant sessions');
  }

  async useSupabaseAuthState() {
    const storeId = await this.resolveStoreId();
    const writeData = async (data, key) => {
      try {
        const id = `${this.sessionId}:${key}`;
        const content = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        const { error } = await supabase
          .from('whatsapp_sessions')
          .upsert({ id, store_id: storeId, whatsapp_account_id: this.accountId, data: content, updated_at: new Date() });
        if (error) throw error;
      } catch (err) {
        logger.error(`Error writing session data for ${key}: ${err?.message || JSON.stringify(err)}`);
        throw err;
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
                    store_id: storeId,
                    whatsapp_account_id: this.accountId,
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
                  const { error } = await supabase.from('whatsapp_sessions').upsert(batch);
                  if (error) throw error;
                }
              }
              if (deletes.length > 0) {
                for (let i = 0; i < deletes.length; i += 50) {
                  const batch = deletes.slice(i, i + 50);
                  const { error } = await supabase.from('whatsapp_sessions').delete().in('id', batch);
                  if (error) throw error;
                }
              }
            } catch (err) {
              logger.error(`Error in batch set session data: ${err?.message || JSON.stringify(err)}`);
              throw err;
            }
          }
        }
      },
      saveCreds: () => {
        this.lastSavePromise = writeData(creds, 'creds');
        this.lastSavePromise.then(() => logger.info('WhatsApp credentials persisted')).catch(() => {});
        return this.lastSavePromise;
      }
    };
  }

  async initialize() {
    if (this.isInitializing) return;
    this.isShutdown = false;
    this.isInitializing = true;
    this.isReady = false;
    this.connectionState = 'connecting';

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

        if (connection) {
          this.connectionState = connection;
          logger.info(`WhatsApp connection state: ${connection}`);
        }

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
          this.lastError = error?.message || `Connection closed (${statusCode || 'unknown'})`;
          this.lastErrorAt = new Date().toISOString();
          await this.syncAccountStatus(this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS ? 'failed' : 'pending');

          // 1. Session logged out — clean DB and recreate fresh
          if (statusCode === DisconnectReason.loggedOut) {
            logger.warn('WhatsApp session logged out. Purging old session from DB...');
            await supabase.from('whatsapp_sessions').delete().like('id', `${this.sessionId}:%`).catch(() => {});
            this.reconnectAttempts = 0;
            this.lastQR = null;
            setTimeout(() => { if (!this.isShutdown) this.initialize(); }, 1000);
            return;
          }

          // 2. Restart required (status 515) — happens right after QR scan or pairing! Must restart immediately.
          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            logger.info('🔄 Restart required by WhatsApp protocol (handshake completed). Reconnecting immediately...');
            await this.lastSavePromise.catch(() => {});
            setTimeout(() => { if (!this.isShutdown) this.initialize(); }, 1000);
            return;
          }

          // 3. General reconnection with reasonable backoff
          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            const delay = Math.min(Math.pow(2, Math.min(this.reconnectAttempts, 4)) * 1000, 15000);
            logger.info(`Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(() => { if (!this.isShutdown) this.initialize(); }, delay);
          } else {
            logger.error('Max reconnection attempts reached. Please use /qr/reset to start fresh.');
          }
        } else if (connection === 'open') {
          logger.info('✅ WhatsApp connection opened successfully (Persistent)');
          this.isReady = true;
          this.reconnectAttempts = 0;
          this.lastQR = null;
          this.pairingCode = null;
          this.lastError = null;
          this.lastErrorAt = null;
          this.lastConnectedAt = new Date().toISOString();
          await this.syncAccountStatus('connected');
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
    if (this.pairingRequestPromise) return this.pairingRequestPromise;
    this.pairingRequestPromise = this._requestPairingCode(phoneNumber);
    try {
      return await this.pairingRequestPromise;
    } finally {
      this.pairingRequestPromise = null;
    }
  }

  async _requestPairingCode(phoneNumber) {
    try {
      if (this.isReady) throw new Error('WhatsApp is already connected.');

      const cleanNumber = String(phoneNumber || '').replace(/\D/g, '');
      if (!/^\d{8,15}$/.test(cleanNumber)) {
        throw new Error('رقم الهاتف غير صالح. استخدم الرقم الدولي بدون + أو مسافات.');
      }
      logger.info(`Pairing code requested for phone ending ${cleanNumber.slice(-4)}`);

      // Ensure socket is initialized, then give Baileys time to establish its
      // WebSocket before asking WhatsApp for a pairing code.
      if (!this.sock || this.connectionState === 'close') {
        this.reconnectAttempts = 0;
        await this.initialize();
      }

      const socketDeadline = Date.now() + 30000;
      while (!this.sock && this.isInitializing && Date.now() < socketDeadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      const deadline = Date.now() + 30000;
      while (this.sock && this.connectionState === 'close' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!this.sock || this.connectionState === 'close') {
        throw new Error('تعذر إنشاء socket واتساب. أعد المحاولة بعد لحظات.');
      }

      // Baileys pairing is intentionally requested while the socket is
      // connecting; waiting for `open` prevents unregistered accounts from
      // ever receiving a pairing code.
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (!this.sock || this.connectionState === 'close') {
        throw new Error('اتصال socket واتساب غير صالح.');
      }

      let code;
      try {
        code = await this.sock.requestPairingCode(cleanNumber);
      } catch (firstError) {
        // Retry once from a clean session; the first socket can be half-open
        // even while its connection state still reports `connecting`.
        await this.resetSession();
        await this.initialize();
        const retryDeadline = Date.now() + 30000;
        while (this.sock && this.connectionState === 'close' && Date.now() < retryDeadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!this.sock || this.connectionState === 'close') {
          throw new Error('تعذر إعادة تهيئة socket واتساب. حاول مرة أخرى.');
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
        code = await this.sock.requestPairingCode(cleanNumber);
      }
      this.pairingCode = code;
      logger.info(`Pairing code generated for phone ending ${cleanNumber.slice(-4)}`);
      return code;
    } catch (error) {
      logger.error('Failed to request pairing code:', error.message);
      throw error;
    }
  }

  // ✅ New Method: Get Connection Status
  getStatus() {
    if (this.isReady) return 'connected';
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) return 'failed';
    if (this.connectionState === 'connecting' || (this.sock && this.reconnectAttempts > 0)) return this.reconnectAttempts > 0 ? 'retrying' : 'connecting';
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
    this.isShutdown = true;
    this.reconnectAttempts = 0;
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

  async resetSession() {
    await this.shutdown();
    if (this.accountId) {
      const { error } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .like('id', `${this.sessionId}:%`);
      if (error) throw error;
    }
    this.isShutdown = false;
    this.pairingCode = null;
    this.lastQR = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.connectionState = 'close';
    await this.syncAccountStatus('pending');
  }

  async syncAccountStatus(status) {
    if (!this.accountId) return;
    const payload = { status, updated_at: new Date().toISOString() };
    if (status === 'connected') {
      const now = new Date().toISOString();
      payload.last_connected_at = now;
      payload.last_success_at = now;
    }
    if (status === 'pending') {
      payload.last_error = null;
      payload.last_error_at = null;
    }
    const { error } = await supabase.from('whatsapp_accounts').update(payload).eq('id', this.accountId);
    if (error) logger.debug(`Failed to sync WhatsApp account ${this.accountId} status: ${error.message}`);
  }
}

const instance = new WhatsappService();
module.exports = instance;
module.exports.WhatsappService = WhatsappService;
