const bcrypt = require('bcrypt');
const { Mutex } = require('async-mutex');
const whatsappService = require('./whatsappService');
const { supabase } = require('./supabase');
const logger = require('../utils/logger');

class OTPService {
  constructor() {
    this.OTP_EXPIRY_MINUTES = 5;
    this.COOLDOWN_SECONDS = 120;

    this.MAX_ATTEMPTS = 5;
    this.SALT_ROUNDS = 10;

    // Per-phone mutexes to prevent race conditions on OTP verify
    this.phoneMutexes = {};

    // ✅ Start periodic cleanup (every 10 minutes)
    setInterval(() => this.cleanupExpired(), 10 * 60 * 1000);
    // ✅ Reclaim idle mutexes every 30 minutes to avoid unbounded memory growth.
    setInterval(() => this.cleanupIdleMutexes(), 30 * 60 * 1000);
  }

  getPhoneMutex(phone) {
    if (!this.phoneMutexes[phone]) {
      this.phoneMutexes[phone] = { mutex: new Mutex(), lastUsed: Date.now() };
    }
    this.phoneMutexes[phone].lastUsed = Date.now();
    return this.phoneMutexes[phone].mutex;
  }

  /**
   * Drop mutex entries for phones that haven't been touched recently and aren't locked.
   * Prevents the phoneMutexes map from growing without bound over the server's lifetime.
   */
  cleanupIdleMutexes() {
    const IDLE_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    for (const phone of Object.keys(this.phoneMutexes)) {
      const entry = this.phoneMutexes[phone];
      if (now - entry.lastUsed > IDLE_MS && !entry.mutex.isLocked()) {
        delete this.phoneMutexes[phone];
      }
    }
  }

  async sendOTP(phone, store = null) {
    // 1. Check for existing record and cooldown
    const { data: existing } = await supabase
      .from('otp_codes')
      .select('*')
      .eq('phone', phone)
      .single();

    if (existing) {
      const now = new Date();
      const lastSent = new Date(existing.last_sent_at);
      const diffSeconds = Math.floor((now - lastSent) / 1000);

      if (diffSeconds < this.COOLDOWN_SECONDS) {
        throw new Error(`يرجى الانتظار ${this.COOLDOWN_SECONDS - diffSeconds} ثانية قبل طلب كود جديد`);
      }
    }

    // 3. Generate and Hash OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const hash = await bcrypt.hash(code, this.SALT_ROUNDS);
    
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + this.OTP_EXPIRY_MINUTES);
    
    // 4. Upsert with reset attempts
    const { error } = await supabase
      .from('otp_codes')
      .upsert({ 
        phone, 
        code_hash: hash, 
        attempts: 0,
        last_sent_at: new Date().toISOString(),
        expires_at: expiry.toISOString() 
      }, { onConflict: 'phone' });

    if (error) {
      logger.error('Failed to upsert OTP in Supabase:', error);
      throw new Error('فشل في معالجة طلب التحقق');
    }

    // Load store brand name dynamically from site_settings or fallback
    let storeName = 'EG-PARTS';
    if (store && store.id) {
      try {
        const { data: settings } = await supabase
          .from('site_settings')
          .select('brand_name')
          .eq('store_id', store.id)
          .single();
        storeName = settings?.brand_name || store.name || 'EG-PARTS';
      } catch (err) {
        storeName = store.name || 'EG-PARTS';
      }
    }

    // 5. Send via WhatsApp (Secured by EG-PARTS Cloud branding)
    const message = `رمز التحقق الخاص بك لمتجر ${storeName} (مؤمن بواسطة EG-PARTS Cloud) هو: ${code}\nصالح لمدة 5 دقائق. يرجى عدم مشاركة هذا الرمز مع الآخرين لسرية وأمان حسابك.`;
    
    try {
      await whatsappService.sendMessage(phone, message);
      logger.info(`OTP sent successfully to masked number: ${phone.slice(0, 6)}XXXX`);
      return true;
    } catch (error) {
      logger.error(`Error sending OTP to WhatsApp: ${error.message}`);
      throw new Error('فشل في إرسال الرسالة عبر واتساب، يرجى المحاولة لاحقاً');
    }
  }

  async verifyOTP(phone, code) {
    const mutex = this.getPhoneMutex(phone);
    return mutex.runExclusive(async () => {
      const { data, error } = await supabase
        .from('otp_codes')
        .select('*')
        .eq('phone', phone)
        .single();

      if (error || !data) {
        logger.warn(`Verification failed: No OTP found for ${phone.slice(0, 6)}XXXX`);
        return false;
      }

      // Check if max attempts exceeded
      if (data.attempts >= this.MAX_ATTEMPTS) {
        logger.error(`Max attempts reached for ${phone.slice(0, 6)}XXXX`);
        throw new Error('تم تجاوز عدد المحاولات المسموح بها، يرجى طلب كود جديد');
      }

      // Check expiry
      if (new Date() > new Date(data.expires_at)) {
        await this.deleteOTP(phone);
        throw new Error('انتهت صلاحية الكود، يرجى طلب كود جديد');
      }

      // Verify Hash
      const isValid = await bcrypt.compare(code, data.code_hash);

      if (!isValid) {
        // Increment attempts
        await supabase
          .from('otp_codes')
          .update({ attempts: data.attempts + 1 })
          .eq('phone', phone);
        
        logger.warn(`Invalid OTP attempt ${data.attempts + 1} for ${phone.slice(0, 6)}XXXX`);
        return false;
      }

      // Success - delete record
      await this.deleteOTP(phone);
      logger.info(`Successful OTP verification for ${phone.slice(0, 6)}XXXX`);
      return true;
    });
  }

  async deleteOTP(phone) {
    await supabase.from('otp_codes').delete().eq('phone', phone);
  }

  async cleanupExpired() {
    try {
      const { error } = await supabase
        .from('otp_codes')
        .delete()
        .lt('expires_at', new Date().toISOString());
      
      if (error) logger.error('Cleanup error:', error);
    } catch (err) {
      logger.error('Failed to cleanup expired OTPs:', err);
    }
  }
}

module.exports = new OTPService();
