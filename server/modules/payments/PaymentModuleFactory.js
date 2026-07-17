/**
 * PaymentModuleFactory
 * Creates a fully-wired PaymentService + PaymentOrchestrator instance.
 * This is the single entry point to the Payment Module for all routes.
 * No external code should ever instantiate these classes directly.
 */

const PaymentService = require('./services/PaymentService');
const PaymentOrchestrator = require('./services/PaymentOrchestrator');
const PaymentIntentRepository = require('./repositories/PaymentIntentRepository');
const PaymentIntentTransactionRepository = require('./repositories/PaymentIntentTransactionRepository');
const PaymentTimelineRepository = require('./repositories/PaymentTimelineRepository');
const PaymentOutboxRepository = require('./repositories/PaymentOutboxRepository');

let _orchestrator = null;
let _service = null;

function getPaymentService() {
  if (!_service) {
    const intentRepo = new PaymentIntentRepository();
    const transactionRepo = new PaymentIntentTransactionRepository();
    const timelineRepo = new PaymentTimelineRepository();
    const outboxRepo = new PaymentOutboxRepository();

    _service = new PaymentService(intentRepo, transactionRepo, timelineRepo, outboxRepo);
  }
  return _service;
}

function getPaymentOrchestrator() {
  if (!_orchestrator) {
    const outboxRepo = new PaymentOutboxRepository();

    // Lazy-load the event bus to avoid circular dependencies
    let eventBus;
    try {
      eventBus = require('../../../services/eventBus');
    } catch {
      // Fallback no-op event bus if not available
      eventBus = { publish: async () => {} };
    }

    _orchestrator = new PaymentOrchestrator(getPaymentService(), outboxRepo, eventBus);
  }
  return _orchestrator;
}

module.exports = { getPaymentService, getPaymentOrchestrator };
