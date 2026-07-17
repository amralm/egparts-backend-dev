/**
 * PaymentIntent Entity
 * Represents a payment intent in the system and encapsulates state transitions.
 */
class PaymentIntent {
  constructor({
    id,
    store_id,
    order_id,
    amount_cents,
    currency,
    status,
    provider,
    metadata,
    created_at,
    updated_at
  }) {
    if (!store_id) throw new Error('store_id is required');
    if (!order_id) throw new Error('order_id is required');
    if (amount_cents === undefined || amount_cents === null || typeof amount_cents !== 'number') {
      throw new Error('amount_cents must be a valid number');
    }
    if (!provider) throw new Error('provider is required');

    this.id = id;
    this.store_id = store_id;
    this.order_id = order_id;
    this.amount_cents = amount_cents;
    this.currency = currency || 'EGP';
    this.status = status || 'created';
    this.provider = provider;
    this.metadata = metadata || {};
    this.created_at = created_at || new Date().toISOString();
    this.updated_at = updated_at || new Date().toISOString();
  }

  transitionToProcessing() {
    this._assertNotTerminal();
    if (this.status !== 'created') {
      throw new Error(`Invalid state transition: ${this.status} -> processing`);
    }
    this.status = 'processing';
    this.updated_at = new Date().toISOString();
  }

  transitionToAuthorized() {
    this._assertNotTerminal();
    if (this.status !== 'processing') {
      throw new Error(`Invalid state transition: ${this.status} -> authorized`);
    }
    this.status = 'authorized';
    this.updated_at = new Date().toISOString();
  }

  transitionToCaptured() {
    this._assertNotTerminal();
    if (this.status !== 'authorized' && this.status !== 'processing') {
      throw new Error(`Invalid state transition: ${this.status} -> captured`);
    }
    this.status = 'captured';
    this.updated_at = new Date().toISOString();
  }

  transitionToFailed(reason) {
    this._assertNotTerminal();
    if (this.status !== 'processing' && this.status !== 'authorized') {
      throw new Error(`Invalid state transition: ${this.status} -> failed`);
    }
    this.status = 'failed';
    this.metadata.failure_reason = reason;
    this.updated_at = new Date().toISOString();
  }

  transitionToCancelled() {
    this._assertNotTerminal();
    this.status = 'cancelled';
    this.updated_at = new Date().toISOString();
  }

  _assertNotTerminal() {
    if (['captured', 'failed', 'cancelled'].includes(this.status)) {
      throw new Error(`PaymentIntent is in terminal state: ${this.status} and cannot be modified`);
    }
  }

  toDatabase() {
    return {
      id: this.id,
      store_id: this.store_id,
      order_id: this.order_id,
      amount_cents: this.amount_cents,
      currency: this.currency,
      status: this.status,
      provider: this.provider,
      metadata: this.metadata,
      created_at: this.created_at,
      updated_at: this.updated_at
    };
  }
}

module.exports = PaymentIntent;
