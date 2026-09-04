const { WhatsappService } = require('./whatsappService');
const { supabase } = require('./supabase');
const logger = require('../utils/logger');
const subscriptionLimitService = require('./subscriptionLimitService');

const CIRCUIT_COOLDOWN_MS = 60_000;

class WhatsAppPoolService {
  constructor() {
    this.accounts = new Map();
    this.loaded = false;
    this.loading = null;
  }

  async loadAccounts() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('*')
        .eq('enabled', true)
        .order('priority', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;

      const activeIds = new Set((data || []).map((row) => row.id));
      for (const [id, entry] of this.accounts) {
        if (!activeIds.has(id)) {
          await entry.service.shutdown().catch(() => {});
          this.accounts.delete(id);
        }
      }

      for (const row of data || []) {
        if (!this.accounts.has(row.id)) {
          this.accounts.set(row.id, { row, service: new WhatsappService({ accountId: row.id }) });
        } else {
          this.accounts.get(row.id).row = row;
        }
      }
      this.loaded = true;
      return this.accounts;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  async initializeAll() {
    await this.loadAccounts();
    await Promise.allSettled([...this.accounts.values()].map(({ service }) => service.initialize()));
  }

  async shutdown() {
    await Promise.allSettled([...this.accounts.values()].map(({ service }) => service.shutdown()));
  }

  isConnected() {
    return [...this.accounts.values()].some(({ service }) => service.isReady && service.sock && service.connectionState === 'open');
  }

  getStatus() {
    const accounts = [...this.accounts.values()].map(({ row, service }) => ({
      id: row.id,
      phone_number: row.phone_number,
      status: service.isReady && service.sock && service.connectionState === 'open' ? 'connected' : service.getStatus(),
      active_jobs: row.active_jobs || 0,
      max_concurrency: row.max_concurrency || 1,
      circuit_state: row.circuit_state || 'closed',
      connection_state: service.connectionState,
      reconnect_attempts: service.reconnectAttempts || 0,
      last_error: service.lastError || row.last_error || null,
      last_error_at: service.lastErrorAt || row.last_error_at || null,
      last_connected_at: service.lastConnectedAt || row.last_connected_at || null
    }));
    return {
      status: accounts.some(a => a.status === 'connected') ? 'connected' : 'disconnected',
      accounts
    };
  }

  async requestPairingCode(accountId, phoneNumber) {
    await this.loadAccounts();
    const account = this.accounts.get(accountId);
    if (!account) throw new Error('WhatsApp account not found');
    if (!account.service.sock) await account.service.initialize();
    return account.service.requestPairingCode(phoneNumber);
  }

  async resetAccount(accountId) {
    await this.loadAccounts();
    const account = this.accounts.get(accountId);
    if (!account) throw new Error('WhatsApp account not found');
    await account.service.shutdown();
    const replacement = {
      row: account.row,
      service: new WhatsappService({ accountId })
    };
    this.accounts.set(accountId, replacement);

    // Reset is an operational action, not just an in-memory replacement.
    // Start the replacement immediately so the API cannot report success
    // while the account remains disconnected until the next process restart.
    await replacement.service.initialize();
    return replacement.service.getStatus();
  }

  async removeAccount(accountId) {
    const entry = this.accounts.get(accountId);
    if (entry) {
      await entry.service.shutdown().catch(() => {});
      this.accounts.delete(accountId);
    }
    await this.loadAccounts();
  }

  selectAccount() {
    const now = Date.now();
    return [...this.accounts.values()]
      .filter(({ row, service }) => {
        if (!row.enabled || !service.isReady) return false;
        if ((row.circuit_state || 'closed') === 'open') {
          return row.circuit_opened_at && now - new Date(row.circuit_opened_at).getTime() >= CIRCUIT_COOLDOWN_MS
            && (row.active_jobs || 0) < (row.max_concurrency || 1);
        }
        return (row.active_jobs || 0) < (row.max_concurrency || 1);
      })
      .sort((a, b) => {
        const score = (x) => ((x.row.active_jobs || 0) / Math.max(1, x.row.weight || 1)) * 1000 + (x.row.priority || 100);
        return score(a) - score(b);
      })[0] || null;
  }

  async sendMessage(to, text, options = {}) {
    await this.loadAccounts();
    const idempotencyKey = options.idempotencyKey || `whatsapp-${options.storeId || 'platform'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let reserved = false;
    if (options.storeId) {
      reserved = await subscriptionLimitService.reserveFeatureUsage(
        options.storeId,
        'whatsapp_messages_month',
        1,
        idempotencyKey
      );
      if (!reserved) {
        const error = new Error('WhatsApp message limit exceeded');
        error.code = 'FEATURE_LIMIT_EXCEEDED';
        throw error;
      }
    }
    const candidates = options.accountId
      ? [this.accounts.get(options.accountId)].filter(Boolean)
      : [...this.accounts.values()]
        .filter(({ row, service }) => row.enabled && service.isReady && service.sock && service.connectionState === 'open')
        .filter(({ row }) => (row.circuit_state || 'closed') !== 'open')
        .sort((a, b) => {
          const score = (x) => ((x.row.active_jobs || 0) / Math.max(1, x.row.weight || 1)) * 1000 + (x.row.priority || 100);
          return score(a) - score(b);
        });
    let account = null;
    for (const candidate of candidates) {
      const { data: claimed, error: claimError } = await supabase.rpc('claim_whatsapp_account', { p_account_id: candidate.row.id });
      if (!claimError && claimed === true) {
        account = candidate;
        break;
      }
    }
    if (!account) {
      if (reserved) await subscriptionLimitService.rollbackFeatureUsage(idempotencyKey);
      const error = new Error('No connected WhatsApp account is available');
      error.code = 'WHATSAPP_POOL_EMPTY';
      throw error;
    }

    const { row, service } = account;
    row.active_jobs = (row.active_jobs || 0) + 1;
    try {
      const result = await service.sendMessage(to, text, options.retries || 3);
      row.active_jobs = Math.max(0, row.active_jobs - 1);
      row.consecutive_failures = 0;
      row.circuit_state = 'closed';
      await supabase.rpc('release_whatsapp_account', { p_account_id: row.id });
      await supabase.from('whatsapp_accounts').update({ consecutive_failures: 0, circuit_state: 'closed', last_success_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id);
      if (reserved) await subscriptionLimitService.commitFeatureUsage(idempotencyKey);
      return { result, accountId: row.id, idempotencyKey };
    } catch (error) {
      row.active_jobs = Math.max(0, row.active_jobs - 1);
      row.consecutive_failures = (row.consecutive_failures || 0) + 1;
      const circuitState = row.consecutive_failures >= 3 ? 'open' : 'closed';
      await supabase.rpc('release_whatsapp_account', { p_account_id: row.id });
      await supabase.from('whatsapp_accounts').update({ consecutive_failures: row.consecutive_failures, circuit_state: circuitState, circuit_opened_at: circuitState === 'open' ? new Date().toISOString() : null, last_error: error.message, last_error_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id);
      logger.warn(`WhatsApp account ${row.id} failed: ${error.message}`);
      if (reserved) await subscriptionLimitService.rollbackFeatureUsage(idempotencyKey);
      throw error;
    }
  }
}

module.exports = new WhatsAppPoolService();
