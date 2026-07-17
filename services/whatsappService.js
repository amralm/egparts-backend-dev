const { 
  makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  BufferJSON,
  initAuthCreds,
  proto
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
    this.MAX_RECONNECT_ATTEMPTS = 5;
    this.lastQR = null;
    this.pairingCode = null;
    this.sessionId = 'main_whatsapp_session'; // ✅ Unique ID for session in DB
    
    this.queue = new PQueue({ 
      concurrency: 1, 
      interval: 1000, 
      intervalCap: 1,
      maxSize: 100 
    });
  }

  // ✅ Helper: DB-backed Auth State
  async useSupabaseAuthState() {
    const writeData = async (data, key) => {
      try {
        const id = `${this.sessionId}:${key}`;
        const content = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await supabase
          .from('whatsapp_sessions')
          .upsert({ id, data: content, updated_at: new Date() });
      } catch (err) {
        logger.error(`Error writing session data for ${key}:`, err);
      }
    };

    const readData = async (key) => {
      try {
        const id = `${this.sessionId}:${key}`;
        const { data, error } = await supabase
          .from('whatsapp_sessions')
          .select('data')
          .eq('id', id)
          .single();
        
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
        logger.error(`Error removing session data for ${key}:`, err);
      }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const data = {};
            await Promise.all(
              ids.map(async (id) => {
                let value = await readData(`${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
              })
            );
            return data;
          },
          set: async (data) => {
            const tasks = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const key = `${category}-${id}`;
                tasks.push(async () => value ? writeData(value, key) : removeData(key));
              }
            }
            // Execute in batches of 5 to prevent Supabase rate limits & crashes
            for (let i = 0; i < tasks.length; i += 5) {
              await Promise.all(tasks.slice(i, i + 5).map(fn => fn()));
            }
          }
        }
      },
      saveCreds: () => writeData(creds, 'creds')
    };
  }

  async initialize() {
    logger.info(`🔐 Initializing WhatsApp with Supabase persistent storage...`);
    
    const { state, saveCreds } = await this.useSupabaseAuthState();
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require('pino')({ level: 'silent' }),
      browser: ["EG-PARTS", "Chrome", "1.0.0"]
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQR = qr;
        logger.info('New QR Code available at /qr');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect.error instanceof Boom) ? 
          lastDisconnect.error.output.statusCode : 0;
        
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS;
        
        logger.warn(`WhatsApp connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
        
        this.isReady = false;
        this.pairingCode = null;
        
        if (shouldReconnect) {
          this.reconnectAttempts++;
          const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, 30000);
          setTimeout(() => this.initialize(), delay);
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
  }

  // ✅ New Method: Request Pairing Code via Phone Number
  async requestPairingCode(phoneNumber) {
    try {
      if (this.isReady) throw new Error('WhatsApp is already connected.');
      
      // Ensure socket is initialized
      if (!this.sock) await this.initialize();
      
      // phoneNumber should be without + (e.g. 201122551272)
      const code = await this.sock.requestPairingCode(phoneNumber);
      this.pairingCode = code;
      return code;
    } catch (error) {
      logger.error('Failed to request pairing code:', error);
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

          const formattedId = `${to.replace('+', '')}@s.whatsapp.net`;
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
      this.sock.end();
      this.isReady = false;
    }
  }
}

const instance = new WhatsappService();
module.exports = instance;
