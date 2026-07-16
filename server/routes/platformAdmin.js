const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

// === BLOCKED IPs ===
router.get('/platform/blocked-ips', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('blocked_ips')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    res.json(data || []);
  } catch (err) {
    console.error('Blocked IPs error:', err);
    res.status(500).json({ error: 'Failed to load blocked IPs' });
  }
});

router.post('/platform/blocked-ips/block', async (req, res) => {
  try {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ error: 'Missing IP address' });
    const { error } = await supabase.from('blocked_ips').upsert(
      { ip_address: ip, reason: reason || '', blocked_by: 'admin' },
      { onConflict: 'ip_address' }
    );
    if (error) return res.status(500).json({ error: 'Failed to block IP' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to block IP' });
  }
});

router.post('/platform/blocked-ips/unblock', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'Missing IP address' });
    const { error } = await supabase.from('blocked_ips').delete().eq('ip_address', ip);
    if (error) return res.status(500).json({ error: 'Failed to unblock IP' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblock IP' });
  }
});

// === LOGIN LOGS ===
router.get('/platform/login-logs', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const { data, error, count } = await supabase
      .from('user_login_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    res.json({ logs: data || [], total: count || 0, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('Login logs error:', err);
    res.status(500).json({ error: 'Failed to load login logs' });
  }
});

router.delete('/platform/login-logs/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('user_login_logs').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete log' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete log' });
  }
});

// === PLATFORM HEALTH ===
router.get('/health/platform', async (req, res) => {
  try {
    const { count: storeCount } = await supabase.from('stores').select('id', { count: 'exact', head: true });
    const { count: userCount } = await supabase.from('user_profiles').select('id', { count: 'exact', head: true });
    const { count: orderCount } = await supabase.from('orders').select('id', { count: 'exact', head: true });
    const { count: productCount } = await supabase.from('products').select('id', { count: 'exact', head: true });

    const recentOrders = await supabase.from('orders').select('id, created_at, status, total').order('created_at', { ascending: false }).limit(10);
    const activeStores = await supabase.from('stores').select('id, name, subdomain').eq('is_active', true);

    res.json({
      stores: { total: storeCount || 0, active: activeStores?.data?.length || 0 },
      users: { total: userCount || 0 },
      orders: { total: orderCount || 0, recent: recentOrders?.data || [] },
      products: { total: productCount || 0 },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Platform health error:', err);
    res.status(500).json({ error: 'Failed to load platform health' });
  }
});

// === COPILOT ===
router.get('/copilot/weekly-review', async (req, res) => {
  try {
    const { data: orders } = await supabase
      .from('orders')
      .select('id, total, status, created_at')
      .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
      .order('created_at', { ascending: false });

    const totalRevenue = (orders || []).filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + (o.total || 0), 0);
    const totalOrders = (orders || []).length;
    const cancelledOrders = (orders || []).filter(o => o.status === 'cancelled').length;

    res.json({
      period: '7 days',
      total_orders: totalOrders,
      cancelled_orders: cancelledOrders,
      total_revenue: totalRevenue,
      average_order_value: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
      orders: orders || []
    });
  } catch (err) {
    console.error('Copilot weekly review error:', err);
    res.status(500).json({ error: 'Failed to generate weekly review' });
  }
});

router.get('/copilot/usage', async (req, res) => {
  res.json({ used: 0, limit: 100, remaining: 100 });
});

router.post('/copilot/consultant', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ answer: 'AI service is not configured. Please set GEMINI_API_KEY.' });

    const { GoogleGenAI } = require('@google/genai');
    const genAI = new GoogleGenAI({ apiKey });
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(`You are a business consultant for an e-commerce store. Answer concisely in Arabic. Question: ${question}`);
    res.json({ answer: result.response.text() });
  } catch (err) {
    console.error('Copilot consultant error:', err);
    res.status(500).json({ error: 'AI consultation failed' });
  }
});

router.post('/copilot/action-queue/approve', async (req, res) => {
  res.json({ success: true, message: 'Action approved' });
});

// === ADMIN ORDERS (cross-store) ===
router.get('/orders/admin/list', async (req, res) => {
  try {
    const { page = 1, limit = 50, status, store_id } = req.query;
    let query = supabase.from('orders').select('*, stores!inner(name, subdomain)', { count: 'exact' });
    if (status) query = query.eq('status', status);
    if (store_id) query = query.eq('store_id', store_id);
    const offset = (page - 1) * limit;
    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ orders: data || [], total: count || 0, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('Admin orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

router.put('/orders/admin/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Missing status' });
    const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

router.get('/platform/orders/:id/customer-address', async (req, res) => {
  try {
    const { data: order } = await supabase.from('orders').select('shipping_address, customer_name, customer_phone').eq('id', req.params.id).maybeSingle();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load customer address' });
  }
});

// === USERS SUB-ENDPOINTS ===
router.get('/platform/users/:id/addresses', async (req, res) => {
  try {
    const { data } = await supabase.from('user_addresses').select('*').eq('user_id', req.params.id);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load addresses' });
  }
});

router.get('/platform/users/:id/details', async (req, res) => {
  try {
    const userId = req.params.id;
    const { data: profile } = await supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle();
    const { data: orders } = await supabase.from('orders').select('id, total, status, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20);
    res.json({ profile, recent_orders: orders || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user details' });
  }
});

router.delete('/platform/users/:id', async (req, res) => {
  try {
    // Don't actually delete users, just mark them as banned
    const { error } = await supabase.from('user_profiles').update({ is_banned: true, ban_reason: 'Deleted by admin' }).eq('user_id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete user' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.post('/platform/invitations/:id/resend', async (req, res) => {
  try {
    const { data: invitation } = await supabase.from('store_admin_invitations').select('*').eq('id', req.params.id).maybeSingle();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    const newToken = require('uuid').v4();
    await supabase.from('store_admin_invitations').update({ token: newToken, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }).eq('id', req.params.id);
    res.json({ success: true, new_token: newToken });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

router.post('/platform/invitations/:id/revoke', async (req, res) => {
  try {
    const { error } = await supabase.from('store_admin_invitations').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to revoke invitation' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

// === MISC ===
router.get('/orders/recent-purchases', async (req, res) => {
  try {
    const { data } = await supabase.from('orders').select('id, total, created_at').eq('status', 'confirmed').order('created_at', { ascending: false }).limit(5);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load recent purchases' });
  }
});

module.exports = router;