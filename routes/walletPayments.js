const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
/**
 * Manual Wallet Payment Routes
 * Handles the full lifecycle of manual wallet payments (Vodafone Cash, Etisalat Cash, etc.)
 *
 * Flow:
 *   Customer submits order → selects manual_wallet → POST /initiate
 *   Customer uploads receipt → POST /submit-proof
 *   Merchant reviews → GET /pending-proofs (admin)
 *   Merchant approves → POST /approve
 *   Cron job eventually archives/deletes proof image (per retention policy)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { verifyUser, verifyPermission } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const r2 = require('../services/r2StorageService');
const assetPipeline = require('../services/assetPipeline/AssetPipeline');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const { getPaymentService } = require('../server/modules/payments/PaymentModuleFactory');
const {
  registerProof,
  applyDecisionToProof,
  deleteProofImmediately,
} = require('../services/proofRetentionJob');
const rateLimit = require('express-rate-limit');
const { decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
const { validateBody } = require('../middleware/requestValidation');
const { walletSettingsSchema, intentSchema, proofDecisionSchema } = require('../schemas/paymentSchemas');

function proofIsExpired(proof) {
  return Boolean(proof?.proof_expires_at && new Date(proof.proof_expires_at).getTime() <= Date.now());
}

// In-memory storage (files go to Cloudflare R2 via AssetPipeline)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

const walletRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, code: 'RATE_LIMITED', message: 'طلبات كثيرة جداً، حاول بعد دقيقة', data: null },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===== GET Wallet Numbers for a Store =====
// Returns wallet numbers so the customer knows where to transfer.
// SECURITY: Returns wallet number only (not credentials or config details).
router.get('/info', async (req, res) => {
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);

  try {
    const wallets = [];
    let instructions = null;

    // 1. Check New Architecture: store_payment_gateways
    const { data: gateway } = await supabase
      .from('store_payment_gateways')
      .select('credentials, key_version, is_active')
      .eq('store_id', req.store.id)
      .eq('provider_name', 'manual_wallet')
      .eq('is_active', true)
      .maybeSingle();

    if (gateway?.credentials) {
      const key = getEncryptionKeyForVersion(gateway.key_version);
      const creds = decryptCredentials(gateway.credentials, key) || {};
      
      const activeWallets = (creds.wallets || [])
        .filter(w => w.enabled)
        .sort((a, b) => (a.priority || 10) - (b.priority || 10));

      wallets.push(...activeWallets);
    }

    // 2. Fallback to site_settings
    const { data: settings } = await supabase
      .from('site_settings')
      .select('vodafone_cash_number, etisalat_cash_number, orange_cash_number, manual_wallet_enabled, manual_wallet_instructions')
      .eq('store_id', req.store.id)
      .maybeSingle();

    if (settings) {
      instructions = settings.manual_wallet_instructions || null;
      if (wallets.length === 0 && settings.manual_wallet_enabled) {
        if (settings.vodafone_cash_number) {
          wallets.push({ id: 'legacy-vodafone', provider: 'vodafone_cash', label: 'فودافون كاش', number: settings.vodafone_cash_number });
        }
        if (settings.etisalat_cash_number) {
          wallets.push({ id: 'legacy-etisalat', provider: 'etisalat_cash', label: 'اتصالات كاش', number: settings.etisalat_cash_number });
        }
        if (settings.orange_cash_number) {
          wallets.push({ id: 'legacy-orange', provider: 'orange_cash', label: 'أورانج كاش', number: settings.orange_cash_number });
        }
      }
    }

    if (wallets.length === 0) {
      return apiError(res, 404, 'Manual wallet not available', `HTTP_404`);
    }

    let amount = null;
    let currency = 'EGP';
    let order_number = null;

    const intentId = req.query.intentId || req.query.intent_id;
    if (intentId) {
      const { data: intent } = await supabase
        .from('payment_intents')
        .select(`
          amount_cents,
          currency,
          order_id,
          orders ( order_number )
        `)
        .eq('id', intentId)
        .eq('store_id', req.store.id)
        .single();
      
      if (intent) {
        amount = intent.amount_cents ? intent.amount_cents / 100 : null;
        if (intent.currency) currency = intent.currency;
        if (intent.orders && intent.orders.order_number) {
          order_number = intent.orders.order_number;
        }
      }
    }

    return sendSuccess(res, {
      wallets,
      instructions,
      amount,
      currency,
      order_number
    });
  } catch (err) {
    console.error('[wallet/info] Error:', err.message);
    return apiError(res, 500, 'Failed to load wallet info', `HTTP_500`);
  }
});

// ===== GET Wallet Settings (Admin Only) =====
router.get('/settings', verifyPermission('payments.view'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);

  try {
    const { data: gateway } = await supabase
      .from('store_payment_gateways')
      .select('credentials, key_version, is_active')
      .eq('store_id', req.store.id)
      .eq('provider_name', 'manual_wallet')
      .maybeSingle();

    let wallets = [];
    let is_active = false;

    if (gateway) {
      is_active = gateway.is_active;
      if (gateway.credentials) {
        const key = getEncryptionKeyForVersion(gateway.key_version);
        const creds = decryptCredentials(gateway.credentials, key) || {};
        wallets = creds.wallets || [];
      }
    }

    return sendSuccess(res, { wallets, is_active });
  } catch (err) {
    console.error('[wallet/settings] Error:', err.message);
    return apiError(res, 500, 'Failed to fetch wallet settings', `HTTP_500`);
  }
});

// ===== POST/PUT Wallet Settings (Admin Only) =====
// PUT is the canonical REST verb for updates; POST is kept for backward compat.
async function saveWalletSettings(req, res) {
  const { wallets, is_active } = req.body;
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);

  try {
    const { encryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
    
    // Ensure wallets have IDs
    const { v4: uuidv4 } = require('uuid');
    const processedWallets = (wallets || []).map(w => ({
      ...w,
      id: w.id || uuidv4()
    }));

    const encryptionKey = getEncryptionKeyForVersion();
    const encryptedCreds = encryptCredentials({ wallets: processedWallets }, encryptionKey);

    const { error: upsertErr } = await supabase
      .from('store_payment_gateways')
      .upsert({
        store_id: req.store.id,
        provider_name: 'manual_wallet',
        is_active: is_active ?? true,
        credentials: encryptedCreds,
        key_version: 1,
        updated_at: new Date().toISOString()
      }, { onConflict: 'store_id,provider_name' });

    if (upsertErr) throw upsertErr;

    // Also sync legacy site_settings
    await supabase
      .from('site_settings')
      .update({ manual_wallet_enabled: !!(is_active) })
      .eq('store_id', req.store.id);

    return sendSuccess(res, { message: 'تم حفظ إعدادات المحافظ الإلكترونية بنجاح' });
  } catch (err) {
    console.error('[wallet/settings] Error:', err.message);
    return apiError(res, 500, 'Failed to save wallet settings', `HTTP_500`);
  }
}

router.post('/settings', walletRateLimiter, verifyPermission('payments.configure'), validateBody(walletSettingsSchema), saveWalletSettings);
router.put('/settings', walletRateLimiter, verifyPermission('payments.configure'), validateBody(walletSettingsSchema), saveWalletSettings);

// ===== POST Initiate Manual Wallet Payment =====
// Creates the PaymentIntent via the Payment Module.
router.post('/initiate', walletRateLimiter, verifyUser, validateBody(intentSchema), async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) return apiError(res, 400, 'order_id is required', `HTTP_400`);
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);

  try {
    // Verify order belongs to this store and user
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, total, user_id, payment_status')
      .eq('id', order_id)
      .eq('store_id', req.store.id)
      .eq('user_id', req.user.sub)
      .single();

    if (orderError || !order) return apiError(res, 404, 'Order not found', `HTTP_404`);
    if (order.payment_status === 'paid') return apiError(res, 400, 'Order already paid', `HTTP_400`);

    const paymentService = getPaymentService();
    const result = await paymentService.createIntent(
      req.store.id,
      order_id,
      Math.round(order.total * 100),
      'EGP',
      'manual_wallet',
      { user_id: req.user.sub }
    );

    return sendSuccess(res, { intent_id: result.provider_reference?.replace('wallet_manual_', '') || null,
      ...result, });
  } catch (err) {
    console.error('[wallet/initiate] Error:', err.message);
    return apiError(res, 500, 'Failed to initiate wallet payment', `HTTP_500`);
  }
});

// ===== POST Submit Payment Proof (Receipt Upload) =====
// Customer uploads screenshot of their transfer as proof.
router.post('/submit-proof', walletRateLimiter, verifyUser, upload.single('receipt'), async (req, res) => {
  const { intent_id, last_four_digits, transfer_time, wallet_id } = req.body;
  let uploadedProofKey = null;
  let uploadedQuotaBytes = 0;
  let retentionRegistered = false;

  if (!intent_id || !req.file) {
    return apiError(res, 400, 'intent_id and receipt image are required', `HTTP_400`);
  }

  if (!wallet_id) {
    return apiError(res, 400, 'wallet_id is required', `HTTP_400`);
  }
  if (!req.store?.id) {
    return apiError(res, 404, 'Store not found', `HTTP_404`);
  }

  try {
    // 1. Verify the intent belongs to this store
    const { data: intent } = await supabase
      .from('payment_intents')
      .select('id, order_id, store_id, status, metadata')
      .eq('id', intent_id)
      .eq('store_id', req.store.id)
      .single();

    if (!intent) return apiError(res, 404, 'Payment intent not found', `HTTP_404`);
    if (intent.status === 'captured') return apiError(res, 400, 'Already confirmed', `HTTP_400`);
    if (intent.status === 'waiting_verification') return apiError(res, 409, 'Proof already submitted', 'PROOF_ALREADY_SUBMITTED');
    const { data: intentOrder } = await supabase.from('orders').select('user_id, payment_method, created_at').eq('id', intent.order_id).eq('store_id', req.store.id).maybeSingle();
    if (!intentOrder || intentOrder.user_id !== req.user.sub || intentOrder.payment_method !== 'manual_wallet') return apiError(res, 403, 'Payment intent does not belong to this customer', `HTTP_403`);

    // 2. Fetch the actual wallet details to store a snapshot
    let selectedWallet = null;
    const { data: gateway } = await supabase
      .from('store_payment_gateways')
      .select('credentials, key_version')
      .eq('store_id', req.store.id)
      .eq('provider_name', 'manual_wallet')
      .eq('is_active', true)
      .maybeSingle();

    if (gateway?.credentials) {
      const key = getEncryptionKeyForVersion(gateway.key_version);
      const creds = decryptCredentials(gateway.credentials, key) || {};
      selectedWallet = (creds.wallets || []).find(w => w.id === wallet_id);
    }
    
    // Fallback to legacy matching if not found
    if (!selectedWallet) {
      const { data: settings } = await supabase
        .from('site_settings')
        .select('vodafone_cash_number, etisalat_cash_number, orange_cash_number')
        .eq('store_id', req.store.id)
        .maybeSingle();
      
      if (settings) {
        if (wallet_id === 'legacy-vodafone') selectedWallet = { id: wallet_id, provider: 'vodafone_cash', label: 'فودافون كاش', number: settings.vodafone_cash_number };
        else if (wallet_id === 'legacy-etisalat') selectedWallet = { id: wallet_id, provider: 'etisalat_cash', label: 'اتصالات كاش', number: settings.etisalat_cash_number };
        else if (wallet_id === 'legacy-orange') selectedWallet = { id: wallet_id, provider: 'orange_cash', label: 'أورانج كاش', number: settings.orange_cash_number };
      }
    }

    if (!selectedWallet) return apiError(res, 400, 'Invalid wallet selected', `HTTP_400`);

    // 3. Upload through AssetPipeline
    const uploadResult = await assetPipeline.process({
      buffer:       req.file.buffer,
      mimetype:     req.file.mimetype,
      originalname: req.file.originalname,
      policyName:   'receipt',
      storeId:      req.store.id,
      uploadedBy:   req.user.sub,
      correlationId: req.correlationId,
      // Audit / GC tags stored on the R2 object.
      // Used by future GC jobs to trace orphaned receipt objects by intent.
      extraMetadata: {
        owner_type: 'payment_intent',
        owner_id:   intent_id,
      },
    });
    const r2Key = uploadResult.key;
    uploadedProofKey = r2Key;

    // Save the R2 key (not a URL) in metadata for later presigned URL generation
    const proofMeta = {
      r2_key: r2Key,
      quota_bytes: uploadResult.metrics?.processedBytes || 0,
      last_four_digits: last_four_digits || null,
      transfer_time: transfer_time || null,
      wallet_id: wallet_id || null,
      wallet_snapshot: selectedWallet,
      submitted_at: new Date().toISOString(),
      quota_feature_key: 'uploaded_images',
      lifecycle_status: 'uploaded', // uploaded → verified → archived → expired → deleted
    };
    uploadedQuotaBytes = proofMeta.quota_bytes;

    // Merge metadata and update status
    const { data: existing, error: fetchError } = await supabase
      .from('payment_intents')
      .select('metadata')
      .eq('id', intent_id)
      .eq('store_id', req.store.id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    const newMeta = { ...(existing?.metadata || {}), proof: proofMeta };
    const { error: updateIntentError } = await supabase
      .from('payment_intents')
      .update({ metadata: newMeta, status: 'waiting_verification' })
      .eq('id', intent_id)
      .eq('store_id', req.store.id);

    if (updateIntentError) {
      console.error('[wallet/submit-proof] Failed to update intent:', updateIntentError);
      throw updateIntentError;
    }

    await registerProof({
      intentId: intent_id,
      storeId: req.store.id,
      r2Key,
      quotaBytes: proofMeta.quota_bytes,
      submittedAt: proofMeta.submitted_at,
    });
    retentionRegistered = true;

    // Update order payment_status so the frontend reflects 'waiting_verification'
    if (intent.order_id) {
      const { error: orderError } = await supabase
        .from('orders')
        .update({ payment_status: 'waiting_verification' })
        .eq('id', intent.order_id);
      if (orderError) throw orderError;
    }

    // Log to timeline
    const { error: timelineError } = await supabase.from('payment_timelines').insert({
      intent_id: intent_id,
      event_name: 'proof_submitted',
      description: 'Customer uploaded payment receipt',
      payload: { wallet_id, last_four_digits, receipt_path: r2Key },
    });

    if (timelineError) {
      console.error('[wallet/submit-proof] Timeline logging failed:', timelineError);
      // We don't throw here to not fail the user request if only logging fails
    }

    // Send WhatsApp confirmation to customer: proof received, pending review
    // This is the REAL confirmation they were waiting for, not the initial "طلب جديد"
    try {
      const { data: orderForNotif } = await supabase
        .from('orders')
        .select('id, phone, total, order_number')
        .eq('id', intent.order_id)
        .single();

      if (orderForNotif?.phone) {
        const orderNum = orderForNotif.order_number || intent.order_id.split('-')[0].toUpperCase();
        const notifMsg = `\u2705 *\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u0625\u062b\u0628\u0627\u062a \u0627\u0644\u062f\u0641\u0639*`
          + `\n\n\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u0644\u0642\u0637\u0629 \u0634\u0627\u0634\u0629 \u062a\u062d\u0648\u064a\u0644\u0643 \u0644\u0637\u0644\u0628 \u0631\u0642\u0645 *EG-${orderNum}* \u0628\u0646\u062c\u0627\u062d\u060c \u0648\u0633\u064a\u062a\u0645 \u0645\u0631\u0627\u062c\u0639\u062a\u0647 \u062e\u0644\u0627\u0644 \u062f\u0642\u0627\u0626\u0642 \u0648\u0633\u064a\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0637\u0644\u0628\u0643.`
          + `\n\n\u26a0\ufe0f \u0644\u0627 \u062a\u063a\u0644\u0642 \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u062d\u062a\u0649 \u062a\u062a\u0644\u0642\u0649 \u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0646\u0647\u0627\u0626\u064a.`;

        await supabase.from('notification_queue').insert({
          recipient: orderForNotif.phone,
          payload: {
            message: notifMsg,
            event_type: 'wallet_proof_received',
            order_number: `EG-${orderNum}`,
          },
          type: 'whatsapp',
          status: 'pending',
          order_id: intent.order_id,
          store_id: req.store.id,
          idempotency_key: `wallet-proof:${intent_id}`,
        });
      }
    } catch (notifErr) {
      // Notification failure must never block proof upload
      console.error('[wallet/submit-proof] Notification failed (non-fatal):', notifErr.message);
    }

    return sendSuccess(res, { message: 'Receipt uploaded successfully' });
  } catch (err) {
    // If the durable retention record was not created, clean up the object and
    // its quota immediately so a failed request cannot orphan R2 bytes.
    if (!retentionRegistered && uploadedProofKey) {
      try {
        await r2.deleteObject(uploadedProofKey);
        if (uploadedQuotaBytes > 0) {
          await subscriptionLimitService.decrementFeatureUsage(req.store.id, 'storage_bytes', uploadedQuotaBytes);
        }
        await subscriptionLimitService.decrementFeatureUsage(req.store.id, 'uploaded_images', 1);
      } catch (cleanupError) {
        console.error('[wallet/submit-proof] Upload compensation failed:', cleanupError.message);
      }
    }
    console.error('[wallet/submit-proof] Error:', err.message);
    return apiError(res, 500, 'Failed to upload receipt', `HTTP_500`);
  }
});

// ===== GET Pending Proofs (Admin Only) =====
// Merchant sees all pending wallet payments awaiting review.
router.get('/pending-proofs', verifyPermission('payments.view'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);

  try {
    const { data: intents, error } = await supabase
      .from('payment_intents')
      .select('id, order_id, amount_cents, currency, status, metadata, created_at, updated_at')
      .eq('store_id', req.store.id)
      .eq('provider', 'manual_wallet')
      .eq('status', 'waiting_verification')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Build pre-signed URLs via R2 (expire after 1 hour, never expose raw key)
    const result = await Promise.all((intents || []).map(async (intent) => {
      let proofUrl = null;
      const r2Key = intent.metadata?.proof?.r2_key;
      if (r2Key && !proofIsExpired(intent.metadata?.proof)) {
        try {
          proofUrl = await r2.getPresignedUrl(r2Key, 3600);
        } catch (err) {
          console.error('[wallet/pending-proofs] Failed to generate presigned URL:', err.message);
        }
      }

      return {
        intent_id: intent.id,
        order_id: intent.order_id,
        amount: (intent.amount_cents / 100).toFixed(2),
        currency: intent.currency,
        status: intent.status,
        wallet_id: intent.metadata?.proof?.wallet_id || null,
        wallet_snapshot: intent.metadata?.proof?.wallet_snapshot || null,
        wallet_type: intent.metadata?.proof?.wallet_snapshot?.provider || intent.metadata?.proof?.wallet_type || null,
        last_four_digits: intent.metadata?.proof?.last_four_digits || null,
        transfer_time: intent.metadata?.proof?.transfer_time || null,
        submitted_at: intent.metadata?.proof?.submitted_at || intent.updated_at,
        proof_expires_at: intent.metadata?.proof?.proof_expires_at || null,
        proof_available: Boolean(proofUrl),
        proof_url: proofUrl,
      };
    }));

    return sendSuccess(res, { pending: result });
  } catch (err) {
    console.error('[wallet/pending-proofs] Error:', err.message);
    return apiError(res, 500, 'Failed to fetch pending proofs', `HTTP_500`);
  }
});

// ===== GET Active Payment Proof for an Order (Admin Only) =====
// Resolves the active payment intent and fetches its presigned URL.
// Business Logic: Intent Priority -> captured/succeeded > waiting_verification > processing > failed.
router.get('/order-proof/:orderId', verifyPermission('payments.view'), async (req, res) => {
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);
  const { orderId } = req.params;

  try {
    const { data: intents, error } = await supabase
      .from('payment_intents')
      .select('id, order_id, amount_cents, currency, status, metadata, created_at, updated_at')
      .eq('store_id', req.store.id)
      .eq('order_id', orderId)
      .eq('provider', 'manual_wallet');

    if (error) throw error;
    if (!intents || intents.length === 0) {
      return sendSuccess(res, { proof: null });
    }

    // Determine active intent by status priority
    const priorities = { 'captured': 1, 'succeeded': 1, 'waiting_verification': 2, 'processing': 3, 'requires_payment_method': 3, 'failed': 4, 'canceled': 4 };
    
    intents.sort((a, b) => {
      const pA = priorities[a.status] || 5;
      const pB = priorities[b.status] || 5;
      if (pA !== pB) return pA - pB;
      // Break tie with most recent
      return new Date(b.created_at) - new Date(a.created_at);
    });

    const activeIntent = intents[0];
    
    let proofUrl = null;
    const r2Key = activeIntent.metadata?.proof?.r2_key;
    if (r2Key && !proofIsExpired(activeIntent.metadata?.proof)) {
      try {
        proofUrl = await r2.getPresignedUrl(r2Key, 3600);
      } catch (err) {
        console.error(`[wallet/order-proof] Failed to generate presigned URL for ${r2Key}:`, err.message);
      }
    }

    return sendSuccess(res, {
      proof: {
        intent_id: activeIntent.id,
        order_id: activeIntent.order_id,
        amount: (activeIntent.amount_cents / 100).toFixed(2),
        currency: activeIntent.currency,
        status: activeIntent.status,
        wallet_id: activeIntent.metadata?.proof?.wallet_id || null,
        wallet_snapshot: activeIntent.metadata?.proof?.wallet_snapshot || null,
        wallet_type: activeIntent.metadata?.proof?.wallet_snapshot?.provider || activeIntent.metadata?.proof?.wallet_type || null,
        last_four_digits: activeIntent.metadata?.proof?.last_four_digits || null,
        transfer_time: activeIntent.metadata?.proof?.transfer_time || null,
        submitted_at: activeIntent.metadata?.proof?.submitted_at || activeIntent.updated_at,
        proof_expires_at: activeIntent.metadata?.proof?.proof_expires_at || null,
        proof_available: Boolean(proofUrl),
        proof_url: proofUrl,
      }
    });

  } catch (err) {
    console.error('[wallet/order-proof] Error:', err.message);
    return apiError(res, 500, 'Failed to fetch order proof', `HTTP_500`);
  }
});

// ===== POST Approve Wallet Payment (Admin Only) =====
// Merchant confirms the payment after reviewing the receipt.
// This is a TRANSACTION: Payment captured + Order confirmed + Timeline logged.
router.post('/approve', verifyPermission('payments.approve'), validateBody(proofDecisionSchema.pick({ intent_id: true })), async (req, res) => {
  const { intent_id } = req.body;

  if (!intent_id) return apiError(res, 400, 'intent_id is required', `HTTP_400`);
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);

  try {
    // 1. Fetch intent and verify ownership
    const { data: intent, error: intentErr } = await supabase
      .from('payment_intents')
      .select('*')
      .eq('id', intent_id)
      .eq('store_id', req.store.id)
      .eq('provider', 'manual_wallet')
      .single();

    if (intentErr || !intent) return apiError(res, 404, 'Payment intent not found', `HTTP_404`);
    if (intent.status === 'captured') return apiError(res, 400, 'Already approved', `HTTP_400`);
    if (intent.status !== 'waiting_verification') {
      return apiError(res, 400, `Cannot approve payment in status: ${intent.status}`, 'INVALID_PAYMENT_STATUS');
    }

    // One locked database transaction owns intent, order, timeline and outbox.
    const now = new Date().toISOString();
    const { data: approval, error: approvalError } = await supabase.rpc('approve_manual_wallet_payment', {
      p_intent_id: intent_id,
      p_store_id: req.store.id,
      p_admin_id: req.user.sub,
    });
    if (approvalError) throw approvalError;

    const { data: approvedIntent, error: approvedIntentError } = await supabase
      .from('payment_intents')
      .select('metadata')
      .eq('id', intent_id)
      .eq('store_id', req.store.id)
      .single();
    if (approvedIntentError) throw approvedIntentError;

    const decision = await applyDecisionToProof({
      intentId: intent_id,
      storeId: req.store.id,
      metadata: approvedIntent.metadata || intent.metadata || {},
      approved: true,
      decisionAt: now,
    });

    if (decision.days === 0) {
      await deleteProofImmediately(
        intent_id,
        req.store.id,
        { ...(approvedIntent.metadata || intent.metadata || {}) },
        'Approved proof: store retention override is 0 days'
      );
    }

    return sendSuccess(res, { message: 'تم تأكيد الدفع وتحديث حالة الطلب بنجاح.' });
  } catch (err) {
    console.error('[wallet/approve] Error:', err.message);
    return apiError(res, 500, 'Failed to approve payment', `HTTP_500`);
  }
});

// ===== POST Reject Wallet Payment (Admin Only) =====
// Merchant rejects a payment receipt (wrong amount, fake screenshot, etc.)
router.post('/reject', verifyPermission('payments.approve'), validateBody(proofDecisionSchema), async (req, res) => {
  const { intent_id, reason } = req.body;

  if (!intent_id) return apiError(res, 400, 'intent_id is required', `HTTP_400`);
  if (!req.store?.id) return apiError(res, 404, 'Store not found', `HTTP_404`);

  try {
    const { data: intent, error: intentErr } = await supabase
      .from('payment_intents')
      .select('id, order_id, store_id, status, metadata')
      .eq('id', intent_id)
      .eq('store_id', req.store.id)
      .eq('provider', 'manual_wallet')
      .single();

    if (intentErr || !intent) return apiError(res, 404, 'Payment intent not found', `HTTP_404`);
    if (intent.status !== 'waiting_verification') {
      return apiError(res, 400, `Cannot reject payment in status: ${intent.status}`, 'INVALID_PAYMENT_STATUS');
    }

    const now = new Date().toISOString();
    const { data: rejection, error: rejectionError } = await supabase.rpc('reject_manual_wallet_payment', {
      p_intent_id: intent_id,
      p_store_id: req.store.id,
      p_admin_id: req.user.sub,
      p_reason: reason || null,
    });
    if (rejectionError) throw rejectionError;
    const rejectedMetadata = {
      ...(intent.metadata || {}),
      rejected_by: req.user.sub,
      rejected_at: now,
      rejection_reason: reason || 'Merchant rejected payment',
      proof: { ...(intent.metadata?.proof || {}), lifecycle_status: 'rejected' },
    };

    await applyDecisionToProof({
      intentId: intent_id,
      storeId: req.store.id,
      metadata: rejectedMetadata,
      approved: false,
      decisionAt: now,
    });

    // Rejected receipts have no retention requirement. Try immediately; the
    // durable queue retries if R2 or the network is unavailable.
    if (intent.metadata?.proof?.r2_key) {
      await deleteProofImmediately(
        intent_id,
        req.store.id,
        rejectedMetadata,
        `Rejected by merchant: ${reason || 'no reason given'}`
      );
    }

    return sendSuccess(res, { message: 'تم رفض إيصال الدفع.', result: rejection });
  } catch (err) {
    console.error('[wallet/reject] Error:', err.message);
    return apiError(res, 500, 'Failed to reject payment', `HTTP_500`);
  }
});

module.exports = router;
