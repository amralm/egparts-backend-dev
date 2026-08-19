const express = require('express');
const { z } = require('zod');
const { supabase } = require('../services/supabase');
const { verifyPlatformAdmin } = require('../middleware/platformAdmin');
const { validateBody } = require('../middleware/requestValidation');
const pool = require('../services/whatsappPoolService');

const accountSchema = z.object({
  phone_number: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/),
  display_name: z.string().trim().max(160).optional().default(''),
  priority: z.number().int().min(0).max(10000).optional().default(100),
  weight: z.number().int().min(1).max(100).optional().default(1),
  max_concurrency: z.number().int().min(1).max(100).optional().default(1),
  enabled: z.boolean().optional().default(true)
}).strict();

const router = express.Router();
router.use(verifyPlatformAdmin);

router.get('/status', async (req, res) => {
  res.json(pool.getStatus());
});

router.get('/accounts', async (req, res) => {
  const { data, error } = await supabase.from('whatsapp_accounts').select('*').order('priority').order('created_at');
  if (error) return res.status(500).json({ error: 'Failed to load WhatsApp accounts' });
  res.json(data || []);
});

router.post('/accounts', validateBody(accountSchema), async (req, res) => {
  const { data, error } = await supabase.from('whatsapp_accounts').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.code === '23505' ? 'Phone number already exists' : 'Failed to create account' });
  await pool.loadAccounts();
  res.status(201).json(data);
});

router.post('/accounts/:id/pairing-code', async (req, res) => {
  try {
    const account = await supabase.from('whatsapp_accounts').select('phone_number').eq('id', req.params.id).single();
    if (account.error) return res.status(404).json({ error: 'WhatsApp account not found' });
    const code = await pool.requestPairingCode(req.params.id, account.data.phone_number);
    res.json({ success: true, code });
  } catch (error) {
    res.status(409).json({ error: error.message, code: 'WHATSAPP_PAIRING_FAILED' });
  }
});

router.patch('/accounts/:id', validateBody(accountSchema.partial()), async (req, res) => {
  const { data, error } = await supabase.from('whatsapp_accounts').update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: 'Failed to update WhatsApp account' });
  await pool.loadAccounts();
  res.json(data);
});

router.post('/accounts/:id/reset', async (req, res) => {
  const { data: account, error } = await supabase.from('whatsapp_accounts').select('id').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'WhatsApp account not found' });
  const { error: sessionError } = await supabase.from('whatsapp_sessions').delete().eq('whatsapp_account_id', account.id);
  if (sessionError) return res.status(500).json({ error: 'Failed to clear WhatsApp session' });
  const { error: updateError } = await supabase.from('whatsapp_accounts').update({ status: 'pending', active_jobs: 0, consecutive_failures: 0, circuit_state: 'closed', circuit_opened_at: null, last_error: null, updated_at: new Date().toISOString() }).eq('id', account.id);
  if (updateError) return res.status(500).json({ error: 'Failed to reset WhatsApp account' });
  await pool.loadAccounts();
  res.json({ success: true });
});

module.exports = router;
