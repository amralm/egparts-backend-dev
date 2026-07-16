const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { verifyUser } = require('../middleware/auth');

// Wallet info (public — no auth needed, shows enabled/disabled status only)
router.get('/wallet/info', async (req, res) => {
  try {
    const { data } = await supabase
      .from('site_settings')
      .select('key, value')
      .eq('store_id', req.store.id)
      .eq('key', 'wallet_enabled')
      .maybeSingle();

    // Also fetch bank details
    const { data: bankData } = await supabase
      .from('site_settings')
      .select('key, value')
      .eq('store_id', req.store.id)
      .in('key', ['wallet_bank_name', 'wallet_account_number', 'wallet_account_name']);

    const bankDetails = {};
    if (bankData) bankData.forEach(r => { bankDetails[r.key.replace('wallet_', '')] = r.value; });

    res.json({ enabled: data?.value === 'true', bank_details: bankDetails });
  } catch (err) {
    console.error('Wallet info error:', err);
    res.status(500).json({ error: 'Failed to load wallet info' });
  }
});

// Wallet settings (admin GET)
router.get('/wallet/settings', async (req, res) => {
  try {
    const { data } = await supabase
      .from('site_settings')
      .select('key, value')
      .eq('store_id', req.store.id)
      .in('key', ['wallet_enabled', 'wallet_bank_name', 'wallet_account_number', 'wallet_account_name']);

    const settings = {};
    if (data) data.forEach(r => { settings[r.key] = r.value; });

    res.json(settings);
  } catch (err) {
    console.error('Wallet settings error:', err);
    res.status(500).json({ error: 'Failed to load wallet settings' });
  }
});

// Wallet settings (admin — requires auth)
router.post('/wallet/settings', verifyUser, async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    await Promise.all(entries.map(([key, value]) =>
      supabase.from('site_settings').upsert(
        { store_id: req.store.id, key, value: String(value) },
        { onConflict: 'store_id,key' }
      )
    ));
    res.json({ success: true });
  } catch (err) {
    console.error('Save wallet settings error:', err);
    res.status(500).json({ error: 'Failed to save wallet settings' });
  }
});

// Initiate wallet payment (requires auth)
router.post('/wallet/initiate', verifyUser, async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .eq('store_id', req.store.id)
      .maybeSingle();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    // Fetch bank details for instructions
    const { data: bankData } = await supabase
      .from('site_settings')
      .select('key, value')
      .eq('store_id', req.store.id)
      .in('key', ['wallet_bank_name', 'wallet_account_number', 'wallet_account_name']);

    const bankDetails = {};
    if (bankData) bankData.forEach(r => { bankDetails[r.key.replace('wallet_', '')] = r.value; });

    res.json({
      order_id,
      amount: order.total,
      bank_details: bankDetails,
      instructions: 'قم بتحويل المبلغ إلى الحساب البنكي وأرفق إيصال الدفع'
    });
  } catch (err) {
    console.error('Wallet initiate error:', err);
    res.status(500).json({ error: 'Failed to initiate wallet payment' });
  }
});

// Submit proof of payment
router.post('/wallet/submit-proof', verifyUser, async (req, res) => {
  try {
    const { order_id, image_url, transaction_ref } = req.body;
    if (!order_id || !image_url) return res.status(400).json({ error: 'Missing required fields' });

    const { error } = await supabase.from('payment_transactions').insert({
      store_id: req.store.id,
      order_id,
      method: 'wallet',
      status: 'pending_verification',
      proof_image_url: image_url,
      transaction_ref: transaction_ref || null
    });

    if (error) {
      console.error('Submit proof DB error:', error);
      return res.status(500).json({ error: 'Failed to submit proof' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Submit proof error:', err);
    res.status(500).json({ error: 'Failed to submit proof' });
  }
});

// List pending proofs (admin)
router.get('/wallet/pending-proofs', verifyUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_transactions')
      .select('*, orders(*)')
      .eq('store_id', req.store.id)
      .eq('method', 'wallet')
      .eq('status', 'pending_verification')
      .order('created_at', { ascending: false });

    res.json({ proofs: data || [] });
  } catch (err) {
    console.error('Pending proofs error:', err);
    res.status(500).json({ error: 'Failed to load pending proofs' });
  }
});

// Approve wallet payment
router.post('/wallet/approve', verifyUser, async (req, res) => {
  try {
    const { transaction_id } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Missing transaction_id' });

    await supabase
      .from('payment_transactions')
      .update({ status: 'completed' })
      .eq('id', transaction_id)
      .eq('store_id', req.store.id);

    // Also update the order status
    const { data: tx } = await supabase
      .from('payment_transactions')
      .select('order_id')
      .eq('id', transaction_id)
      .maybeSingle();

    if (tx?.order_id) {
      await supabase
        .from('orders')
        .update({ payment_status: 'paid', status: 'confirmed' })
        .eq('id', tx.order_id)
        .eq('store_id', req.store.id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Wallet approve error:', err);
    res.status(500).json({ error: 'Failed to approve' });
  }
});

// Reject wallet payment
router.post('/wallet/reject', verifyUser, async (req, res) => {
  try {
    const { transaction_id } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Missing transaction_id' });

    await supabase
      .from('payment_transactions')
      .update({ status: 'rejected' })
      .eq('id', transaction_id)
      .eq('store_id', req.store.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Wallet reject error:', err);
    res.status(500).json({ error: 'Failed to reject' });
  }
});

// Get proof image for an order
router.get('/wallet/order-proof/:orderId', verifyUser, async (req, res) => {
  try {
    const { data } = await supabase
      .from('payment_transactions')
      .select('proof_image_url, transaction_ref, status, created_at')
      .eq('order_id', req.params.orderId)
      .eq('store_id', req.store.id)
      .eq('method', 'wallet')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json(data || {});
  } catch (err) {
    console.error('Order proof error:', err);
    res.status(500).json({ error: 'Failed to load proof' });
  }
});

module.exports = router;