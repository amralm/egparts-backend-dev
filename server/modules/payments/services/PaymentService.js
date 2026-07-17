const crypto = require('crypto');
const { supabase } = require('../../../../services/supabase');
const PaymentIntent = require('../entities/PaymentIntent');
const PaymentRegistry = require('../providers/PaymentRegistry');

class PaymentService {
  constructor(intentRepo, transactionRepo, timelineRepo, outboxRepo, transactionManager = null) {
    this.intentRepo = intentRepo;
    this.transactionRepo = transactionRepo;
    this.timelineRepo = timelineRepo;
    this.outboxRepo = outboxRepo;
    this.transactionManager = transactionManager;
  }

  async createIntent(storeId, orderId, amountCents, currency, providerCode, customerData) {
    const provider = PaymentRegistry.get(providerCode);
    const intent = new PaymentIntent({
      id: crypto.randomUUID(),
      store_id: storeId,
      order_id: orderId,
      amount_cents: amountCents,
      currency: currency || 'EGP',
      status: 'created',
      provider: providerCode
    });

    const storeSettings = await this._getStoreSettings(storeId, providerCode);
    const initiationResult = await provider.initiatePayment(intent, customerData, storeSettings);

    intent.metadata = intent.metadata || {};
    intent.metadata.provider_reference = initiationResult.provider_reference;
    intent.transitionToProcessing();

    await this._runTransactional(async (txClient) => {
      await this.intentRepo.save(intent, txClient);
      await this.transactionRepo.save({
        intent_id: intent.id,
        transaction_type: 'auth',
        provider_reference: initiationResult.provider_reference,
        amount_cents: amountCents,
        status: 'pending'
      }, txClient);
      await this.timelineRepo.log(
        intent.id,
        'intent_created',
        'Payment intent initiated successfully',
        initiationResult,
        txClient
      );
      await this.outboxRepo.queue(
        'payment_initiated',
        { intent_id: intent.id, order_id: orderId },
        txClient
      );
    });

    return {
      provider_reference: initiationResult.provider_reference,
      payment_url: initiationResult.payment_url
    };
  }

  async processWebhook(providerCode, payload) {
    const provider = PaymentRegistry.get(providerCode);
    const providerReference = String(payload.obj?.order?.id || payload.obj?.order || '');

    const intent = await this.intentRepo.getByProviderReference(providerCode, providerReference);
    if (!intent) throw new Error(`PaymentIntent not found for reference: ${providerReference}`);

    const storeSettings = await this._getStoreSettings(intent.store_id, providerCode);
    const verified = await provider.verifyWebhook(payload, {}, storeSettings);

    if (!verified) {
      await this.timelineRepo.log(intent.id, 'webhook_failed', 'HMAC verification failed for webhook payload', payload);
      throw new Error('Invalid signature');
    }

    const isSuccess = payload.obj?.success === true;

    await this._runTransactional(async (txClient) => {
      if (isSuccess) {
        intent.transitionToCaptured();
        await this.intentRepo.save(intent, txClient);
        await this.transactionRepo.save({
          intent_id: intent.id,
          transaction_type: 'capture',
          provider_reference: String(payload.obj.id),
          amount_cents: intent.amount_cents,
          status: 'completed'
        }, txClient);
        await this.timelineRepo.log(
          intent.id,
          'payment_captured',
          'Webhook reported successful payment capture',
          payload.obj,
          txClient
        );
        await this.outboxRepo.queue(
          'payment_captured',
          {
            intent_id: intent.id,
            order_id: intent.order_id,
            transaction_id: String(payload.obj.id)
          },
          txClient
        );
      } else {
        intent.transitionToFailed(payload.obj?.error_occured || 'Provider declined payment');
        await this.intentRepo.save(intent, txClient);
        await this.transactionRepo.save({
          intent_id: intent.id,
          transaction_type: 'capture',
          provider_reference: String(payload.obj.id || ''),
          amount_cents: intent.amount_cents,
          status: 'failed'
        }, txClient);
        await this.timelineRepo.log(
          intent.id,
          'payment_failed',
          'Webhook reported failed payment transfer',
          payload.obj,
          txClient
        );
        await this.outboxRepo.queue(
          'payment_failed',
          { intent_id: intent.id, order_id: intent.order_id },
          txClient
        );
      }
    });
  }

  async _getStoreSettings(storeId, providerCode) {
    if (providerCode === 'manual_wallet') {
      const { data: settings } = await supabase
        .from('site_settings')
        .select('vodafone_cash_number, payment_screenshot_number')
        .eq('store_id', storeId)
        .maybeSingle();
      return settings || {};
    }

    const { data: gw } = await supabase
      .from('store_payment_gateways')
      .select('*')
      .eq('store_id', storeId)
      .eq('provider_name', providerCode)
      .maybeSingle();

    if (!gw) return {};

    const { decryptCredentials, getEncryptionKeyForVersion } = require('../../../../utils/crypto');
    const key = getEncryptionKeyForVersion(gw.key_version);
    return decryptCredentials(gw.credentials, key) || {};
  }

  async _runTransactional(callback) {
    if (this.transactionManager) {
      const tx = await this.transactionManager.begin();
      try {
        const result = await callback(supabase);
        await this.transactionManager.commit(tx);
        return result;
      } catch (err) {
        await this.transactionManager.rollback(tx);
        throw err;
      }
    }
    return await callback(supabase);
  }
}

module.exports = PaymentService;
