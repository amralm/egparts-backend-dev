class PaymentOrchestrator {
  constructor(paymentService, outboxRepo, eventBus) {
    this.paymentService = paymentService;
    this.outboxRepo = outboxRepo;
    this.eventBus = eventBus;
  }

  async initiate(storeId, orderId, amountCents, currency, providerCode, customerData) {
    const result = await this.paymentService.createIntent(
      storeId,
      orderId,
      amountCents,
      currency,
      providerCode,
      customerData
    );
    return result;
  }

  async processOutbox(limit = 5) {
    const pending = await this.outboxRepo.getPending(limit);
    let processedCount = 0;

    for (const event of pending) {
      try {
        await this.eventBus.publish({
          eventName: event.event_type,
          payload: event.payload
        });
        await this.outboxRepo.markProcessed(event.id);
        processedCount++;
      } catch (err) {
        await this.outboxRepo.markFailed(event.id, err.message);
      }
    }

    return { processed: processedCount };
  }
}

module.exports = PaymentOrchestrator;
