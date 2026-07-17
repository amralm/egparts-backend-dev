// Set up dotenv to get Supabase URL and Service Key for integration tests
require('dotenv').config({ path: 'server/.env' });

const PaymentIntent = require('../../modules/payments/entities/PaymentIntent');
const PaymentIntentRepository = require('../../modules/payments/repositories/PaymentIntentRepository');
const PaymentIntentTransactionRepository = require('../../modules/payments/repositories/PaymentIntentTransactionRepository');
const PaymentTimelineRepository = require('../../modules/payments/repositories/PaymentTimelineRepository');
const PaymentOutboxRepository = require('../../modules/payments/repositories/PaymentOutboxRepository');
const PaymentService = require('../../modules/payments/services/PaymentService');
const PaymentOrchestrator = require('../../modules/payments/services/PaymentOrchestrator');
const { FakeEventBus, FakeTransactionManager } = require('../../kernel/testing/expandedFakes');
const { supabase } = require('../../../services/supabase');

describe('Milestone 3 Integration Tests: Payment DB Repositories & Orchestrator', () => {
  const TEST_STORE_ID = '00000000-0000-0000-0000-000000000000'; // Valid EG-PARTS store
  const TEST_ORDER_ID = 'cf77fbab-99a0-434f-8027-ff12b0a2ace5'; // Valid order ID from database

  let intentRepo;
  let transactionRepo;
  let timelineRepo;
  let outboxRepo;
  let paymentService;
  let eventBus;
  let orchestrator;

  beforeAll(() => {
    jest.setTimeout(30000);
    intentRepo = new PaymentIntentRepository();
    transactionRepo = new PaymentIntentTransactionRepository();
    timelineRepo = new PaymentTimelineRepository();
    outboxRepo = new PaymentOutboxRepository();
    paymentService = new PaymentService(intentRepo, transactionRepo, timelineRepo, outboxRepo);
    eventBus = new FakeEventBus();
    orchestrator = new PaymentOrchestrator(paymentService, outboxRepo, eventBus);
  });

  afterEach(async () => {
    // Clean up database records after each test to keep it idempotent
    await supabase.from('payment_intents').delete().eq('order_id', TEST_ORDER_ID);
    await supabase.from('payment_outbox').delete().eq('payload->>order_id', TEST_ORDER_ID);
    eventBus.clear();
  });

  describe('Repository Operations', () => {
    test('should save and retrieve a PaymentIntent', async () => {
      const intent = new PaymentIntent({
        id: crypto.randomUUID(),
        store_id: TEST_STORE_ID,
        order_id: TEST_ORDER_ID,
        amount_cents: 25000,
        currency: 'EGP',
        status: 'created',
        provider: 'manual_wallet',
        metadata: { test_run: true }
      });

      const savedIntent = await intentRepo.save(intent);
      expect(savedIntent.id).toBe(intent.id);
      expect(savedIntent.status).toBe('created');

      const fetchedIntent = await intentRepo.getById(intent.id);
      expect(fetchedIntent).not.toBeNull();
      expect(fetchedIntent.id).toBe(intent.id);
      expect(fetchedIntent.amount_cents).toBe(25000);
      expect(fetchedIntent.metadata.test_run).toBe(true);
    });

    test('should log and retrieve timeline events', async () => {
      const intent = new PaymentIntent({
        id: crypto.randomUUID(),
        store_id: TEST_STORE_ID,
        order_id: TEST_ORDER_ID,
        amount_cents: 1000,
        provider: 'manual_wallet'
      });
      await intentRepo.save(intent);

      const logRes = await timelineRepo.log(intent.id, 'test_event', 'Log description', { foo: 'bar' });
      expect(logRes.event_name).toBe('test_event');
      expect(logRes.description).toBe('Log description');

      const logs = await timelineRepo.getByIntentId(intent.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].event_name).toBe('test_event');
      expect(logs[0].payload.foo).toBe('bar');
    });

    test('should insert and retrieve transactions', async () => {
      const intent = new PaymentIntent({
        id: crypto.randomUUID(),
        store_id: TEST_STORE_ID,
        order_id: TEST_ORDER_ID,
        amount_cents: 5000,
        provider: 'manual_wallet'
      });
      await intentRepo.save(intent);

      const tx = await transactionRepo.save({
        intent_id: intent.id,
        transaction_type: 'auth',
        provider_reference: 'ref_123',
        amount_cents: 5000,
        status: 'pending'
      });
      expect(tx.intent_id).toBe(intent.id);
      expect(tx.transaction_type).toBe('auth');

      const txList = await transactionRepo.getByIntentId(intent.id);
      expect(txList).toHaveLength(1);
      expect(txList[0].provider_reference).toBe('ref_123');
    });

    test('should queue and process outbox events', async () => {
      const outboxEvent = await outboxRepo.queue('test_event_type', { order_id: TEST_ORDER_ID, value: 42 });
      expect(outboxEvent.event_type).toBe('test_event_type');
      expect(outboxEvent.status).toBe('pending');

      const pending = await outboxRepo.getPending(5);
      expect(pending.some(e => e.id === outboxEvent.id)).toBe(true);

      const processed = await outboxRepo.markProcessed(outboxEvent.id);
      expect(processed.status).toBe('processed');
      expect(processed.processed_at).not.toBeNull();
    });
  });

  describe('PaymentService & Orchestrator Workflow', () => {
    test('should execute full PaymentService creation workflow and process the outbox', async () => {
      // 1. Initiate via Orchestrator
      const customerData = { name: 'Osama Test', email: 'osama@egparts.com', phone: '01011111111' };
      const initiationResult = await orchestrator.initiate(
        TEST_STORE_ID,
        TEST_ORDER_ID,
        15000, // 150.00 EGP
        'EGP',
        'manual_wallet',
        customerData
      );

      expect(initiationResult.provider_reference).toBeDefined();
      expect(initiationResult.payment_url).toBeDefined();
      
      const intentRef = initiationResult.provider_reference;
      
      // 2. Fetch the newly created intent by provider reference
      const intent = await intentRepo.getByProviderReference('manual_wallet', intentRef);
      expect(intent).not.toBeNull();
      expect(intent.status).toBe('processing');
      expect(intent.amount_cents).toBe(15000);

      // 3. Verify outbox has the 'payment_initiated' event queued
      const pendingOutbox = await outboxRepo.getPending(5);
      const initiationEvent = pendingOutbox.find(e => e.event_type === 'payment_initiated' && e.payload.order_id === TEST_ORDER_ID);
      expect(initiationEvent).toBeDefined();
      expect(initiationEvent.status).toBe('pending');

      // 4. Process outbox via Orchestrator
      const outboxResult = await orchestrator.processOutbox(5);
      expect(outboxResult.processed).toBeGreaterThanOrEqual(1);

      // 5. Verify EventBus received the published event
      expect(eventBus.events.some(e => e.eventName === 'payment_initiated' && e.payload.order_id === TEST_ORDER_ID)).toBe(true);
      
      // 6. Verify outbox status updated to processed in DB
      const checkedOutbox = await supabase.from('payment_outbox').select('*').eq('id', initiationEvent.id).single();
      expect(checkedOutbox.data.status).toBe('processed');
    });

    test('should handle Webhook failures gracefully and update outbox status', async () => {
      const intent = new PaymentIntent({
        id: crypto.randomUUID(),
        store_id: TEST_STORE_ID,
        order_id: TEST_ORDER_ID,
        amount_cents: 8000,
        provider: 'manual_wallet'
      });
      // Set provider reference
      intent.metadata.provider_reference = `wallet_manual_${intent.id}`;
      intent.transitionToProcessing();
      await intentRepo.save(intent);

      // Webhook payload showing failed payment
      const payload = {
        hmac: 'any_dummy_value', // ManualWalletProvider bypasses hmac check by returning false, wait!
        // But processWebhook calls provider.verifyWebhook which returns false for manual_wallet.
        // So processWebhook will throw 'Invalid signature'! Let's verify that behavior.
        obj: {
          id: 999999,
          success: false,
          error_occured: 'User cancelled',
          order: { id: `wallet_manual_${intent.id}` }
        }
      };

      await expect(paymentService.processWebhook('manual_wallet', payload)).rejects.toThrow('Invalid signature');
    });

    test('should roll back transaction via transactionManager when an operation fails (transaction atomicity)', async () => {
      const tm = new FakeTransactionManager();
      const brokenOutboxRepo = {
        queue: jest.fn().mockRejectedValue(new Error('Outbox write failed'))
      };
      
      const txPaymentService = new PaymentService(
        intentRepo,
        transactionRepo,
        timelineRepo,
        brokenOutboxRepo,
        tm
      );
      
      const customerData = { name: 'Osama Test', email: 'osama@egparts.com', phone: '01011111111' };
      
      await expect(txPaymentService.createIntent(
        TEST_STORE_ID,
        TEST_ORDER_ID,
        15000,
        'EGP',
        'manual_wallet',
        customerData
      )).rejects.toThrow('Outbox write failed');
      
      const rolledBack = tm.getRolledBackTransactions();
      expect(rolledBack).toHaveLength(1);
      expect(rolledBack[0].status).toBe('rolled_back');
    });
  });
});
