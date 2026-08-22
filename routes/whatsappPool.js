const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const { supabase } = require('../services/supabase');
const { verifyPlatformAdmin } = require('../middleware/platformAdmin');
const { validateBody, validateParams } = require('../middleware/requestValidation');
const pool = require('../services/whatsappPoolService');
const { accountSchema } = require('../schemas/whatsappSchemas');
const { whatsappAccountIdParamSchema } = require('../schemas/platformSchemas');

const router = express.Router();
router.use(verifyPlatformAdmin);

router.get('/status', async (req, res) => {
  sendSuccess(res, pool.getStatus());
});

router.get('/accounts', async (req, res) => {
  const { data, error } = await supabase.from('whatsapp_accounts').select('*').order('priority').order('created_at');
  if (error) return apiError(res, 500, 'Failed to load WhatsApp accounts', `HTTP_500`);
  sendSuccess(res, data || []);
});

router.post('/accounts', validateBody(accountSchema), async (req, res) => {
  const { data, error } = await supabase.from('whatsapp_accounts').insert(req.body).select().single();
  if (error) return apiError(res, 400, error.code === '23505' ? 'Phone number already exists' : 'Failed to create account', error.code === '23505' ? 'WHATSAPP_ACCOUNT_EXISTS' : 'WHATSAPP_ACCOUNT_CREATE_FAILED');
  await pool.loadAccounts();
  sendSuccess(res, data, { status: 201 });
});

router.post('/accounts/:id/pairing-code', validateParams(whatsappAccountIdParamSchema), async (req, res) => {
  try {
    const account = await supabase.from('whatsapp_accounts').select('phone_number').eq('id', req.params.id).single();
    if (account.error) return apiError(res, 404, 'WhatsApp account not found', `HTTP_404`);
    const code = await pool.requestPairingCode(req.params.id, account.data.phone_number);
    sendSuccess(res, { code });
  } catch (error) {
    apiError(res, 409, error.message, 'WHATSAPP_PAIRING_FAILED');
  }
});

router.patch('/accounts/:id', validateParams(whatsappAccountIdParamSchema), validateBody(accountSchema.partial()), async (req, res) => {
  const { data, error } = await supabase.from('whatsapp_accounts').update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return apiError(res, 400, 'Failed to update WhatsApp account', `HTTP_400`);
  await pool.loadAccounts();
  sendSuccess(res, data);
});

router.post('/accounts/:id/reset', validateParams(whatsappAccountIdParamSchema), async (req, res) => {
  const { data: account, error } = await supabase.from('whatsapp_accounts').select('id').eq('id', req.params.id).single();
  if (error) return apiError(res, 404, 'WhatsApp account not found', `HTTP_404`);
  const { error: sessionError } = await supabase.from('whatsapp_sessions').delete().eq('whatsapp_account_id', account.id);
  if (sessionError) return apiError(res, 500, 'Failed to clear WhatsApp session', `HTTP_500`);
  const { error: updateError } = await supabase.from('whatsapp_accounts').update({ status: 'pending', active_jobs: 0, consecutive_failures: 0, circuit_state: 'closed', circuit_opened_at: null, last_error: null, updated_at: new Date().toISOString() }).eq('id', account.id);
  if (updateError) return apiError(res, 500, 'Failed to reset WhatsApp account', `HTTP_500`);
  await pool.resetAccount(account.id);
  sendSuccess(res, {});
});

module.exports = router;
