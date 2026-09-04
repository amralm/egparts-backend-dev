'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabase } = require('../services/supabase');
const { verifyPermission } = require('../middleware/auth');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');
const logger = require('../utils/logger');
const whatsappPoolService = require('../services/whatsappPoolService');
const { generateReceiptPdf } = require('../services/receiptPdfService');
const {
  posOrderSchema,
  posReturnSchema,
  openShiftSchema,
  cashMovementSchema,
  closeShiftSchema,
  sendReceiptSchema
} = require('../schemas/posSchemas');

// ── GET /api/pos/products ──
// Fast, indexed product search and catalog for POS tablet cashier
router.get('/products', verifyPermission(['tenant.orders.read', 'orders.view', 'tenant.products.read', 'products.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { q, category_id, category } = req.query;
    const catFilter = category || category_id;

    let query = supabase
      .from('products')
      .select('id, name, price, stock_quantity, stock, image, category, part_number, is_active, is_deleted, specs')
      .eq('store_id', req.store.id)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .order('name', { ascending: true })
      .limit(200);

    if (catFilter && catFilter !== 'all') {
      query = query.eq('category', catFilter);
    }

    if (q && q.trim()) {
      const searchTerm = q.trim();
      query = query.or(`name.ilike.%${searchTerm}%,part_number.ilike.%${searchTerm}%,category.ilike.%${searchTerm}%`);
    }

    const { data: products, error } = await query;
    if (error) throw error;

    const normalized = (products || []).map(p => ({
      ...p,
      stock_quantity: p.stock_quantity !== null && p.stock_quantity !== undefined ? p.stock_quantity : (p.stock || 0),
      sku: p.part_number || '',
      barcode: p.specs?.barcode || p.part_number || ''
    }));

    sendSuccess(res, { products: normalized });
  } catch (err) {
    logger.error('[pos] products lookup failed:', err.message);
    apiError(res, 500, 'Failed to fetch POS products', 'HTTP_500');
  }
});

// ── GET /api/pos/categories ──
// Quick category filter buttons for POS
router.get('/categories', verifyPermission(['tenant.orders.read', 'orders.view', 'tenant.products.read', 'products.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { data, error } = await supabase
      .from('products')
      .select('category')
      .eq('store_id', req.store.id)
      .eq('is_deleted', false)
      .eq('is_active', true)
      .not('category', 'is', null);

    if (error) throw error;

    const uniqueCategories = [...new Set((data || []).map(p => p.category?.trim()).filter(Boolean))].map(cat => ({
      id: cat,
      name: cat
    }));

    sendSuccess(res, { categories: uniqueCategories });
  } catch (err) {
    logger.error('[pos] categories lookup failed:', err.message);
    apiError(res, 500, 'Failed to fetch categories', 'HTTP_500');
  }
});

// ── POST /api/pos/orders ──
// Executes atomic POS cashier sale, decrements stock atomically, and records delivered order
router.post('/orders', verifyPermission(['tenant.orders.write', 'orders.create', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = posOrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات الطلب غير صالحة', 'VALIDATION_ERROR');
  }

  const {
    items,
    payment_method,
    discount_amount,
    customer_name,
    customer_phone,
    notes,
    cash_tendered,
    change_due
  } = parseResult.data;

  const userId = req.user?.sub || req.user?.id || null;

  try {
    // 1. Execute atomic RPC
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_pos_order_atomic', {
      p_store_id: req.store.id,
      p_user_id: userId,
      p_items: items,
      p_payment_method: payment_method === 'card' ? 'card' : 'cash',
      p_discount_amount: Number(discount_amount) || 0,
      p_customer_name: customer_name || 'عميل نقدي',
      p_customer_phone: customer_phone || null,
      p_notes: notes || '',
      p_cash_tendered: cash_tendered != null ? Number(cash_tendered) : null,
      p_change_due: change_due != null ? Number(change_due) : null
    });

    if (rpcError) {
      logger.error('[pos] atomic order error:', rpcError.message);
      return apiError(res, 400, rpcError.message || 'تعذر إتمام عملية البيع بالكاشير', 'POS_ORDER_FAILED');
    }

    // 2. Fetch store order prefix
    const { data: settings } = await supabase
      .from('site_settings')
      .select('order_prefix, brand_name, brand_logo, logo_url')
      .eq('store_id', req.store.id)
      .maybeSingle();

    const orderPrefix = settings?.order_prefix || 'EG-';
    const formattedOrderNumber = `${orderPrefix}${rpcResult.order_number}`;

    logger.info(`[pos] Sale completed: Order #${formattedOrderNumber} (Store: ${req.store.id}) Total: ${rpcResult.total} EGP`);

    sendSuccess(res, {
      ...rpcResult,
      order_prefix: orderPrefix,
      formatted_order_number: formattedOrderNumber,
      store_name: settings?.brand_name || req.store.name || 'المتجر',
      store_logo: settings?.logo_url || settings?.brand_logo || null,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    logger.error('[pos] order creation failed:', err.message);
    apiError(res, 500, err.message || 'حدث خطأ أثناء إتمام الطلب', 'HTTP_500');
  }
});

// ── GET /api/pos/orders/lookup/:query ──
// Look up an existing order by barcode or order number for returns
router.get('/orders/lookup/:query', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const rawQuery = req.params.query.trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawQuery);
    const cleanedNumber = rawQuery.replace(/\D/g, '');

    let orderQuery = supabase
      .from('orders')
      .select('id, order_number, total, subtotal, discount, discount_amount, payment_method, status, payment_status, items, created_at, phone, metadata')
      .eq('store_id', req.store.id);

    if (isUuid) {
      orderQuery = orderQuery.eq('id', rawQuery);
    } else if (cleanedNumber) {
      orderQuery = orderQuery.eq('order_number', Number(cleanedNumber));
    } else {
      return apiError(res, 400, 'صيغة رقم الفاتورة أو الباركود غير صالحة', 'INVALID_LOOKUP_QUERY');
    }

    const { data: order, error } = await orderQuery.maybeSingle();
    if (error) throw error;
    if (!order) {
      return apiError(res, 404, 'لم يتم العثور على فاتورة بهذا الرقم في هذا المتجر', 'ORDER_NOT_FOUND');
    }

    // Check existing returns on this order
    const { data: existingReturns } = await supabase
      .from('pos_returns')
      .select('id, return_number, items, total_refund, created_at, refund_method')
      .eq('order_id', order.id)
      .eq('store_id', req.store.id);

    // Calculate returned quantities per product
    const returnedQtys = {};
    for (const ret of (existingReturns || [])) {
      if (Array.isArray(ret.items)) {
        for (const item of ret.items) {
          const itemId = item.id || item.product_id;
          if (itemId) {
            returnedQtys[itemId] = (returnedQtys[itemId] || 0) + (Number(item.qty) || 0);
          }
        }
      }
    }

    // Attach returnable status to each item
    const items = (Array.isArray(order.items) ? order.items : []).map(item => {
      const itemId = item.id || item.product_id;
      const originalQty = Number(item.qty || item.quantity || 1);
      const alreadyReturned = returnedQtys[itemId] || 0;
      const returnableQty = Math.max(0, originalQty - alreadyReturned);

      return {
        ...item,
        id: itemId,
        original_qty: originalQty,
        already_returned_qty: alreadyReturned,
        returnable_qty: returnableQty,
        can_return: returnableQty > 0
      };
    });

    const isFullyReturned = items.length > 0 && items.every(i => i.returnable_qty === 0);

    sendSuccess(res, {
      order: {
        ...order,
        items,
        is_fully_returned: isFullyReturned,
        returns_history: existingReturns || []
      }
    });
  } catch (err) {
    logger.error('[pos] order lookup failed:', err.message);
    apiError(res, 500, 'فشل البحث عن الفاتورة', 'HTTP_500');
  }
});

// ── POST /api/pos/returns ──
// Execute atomic cashier return with inventory restock or scrap
router.post('/returns', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = posReturnSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات الإرجاع غير صالحة', 'VALIDATION_ERROR');
  }

  const { order_id, items, refund_method, reason } = parseResult.data;
  const userId = req.user?.sub || req.user?.id || null;

  try {
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_pos_return_atomic', {
      p_store_id: req.store.id,
      p_order_id: order_id,
      p_user_id: userId,
      p_items: items,
      p_refund_method: refund_method,
      p_reason: reason || 'مرتجع كاشير'
    });

    if (rpcError) {
      logger.error('[pos] atomic return error:', rpcError.message);
      return apiError(res, 400, rpcError.message || 'تعذر إتمام عملية الإرجاع', 'POS_RETURN_FAILED');
    }

    logger.info(`[pos] Return processed: ${rpcResult.return_number} (Store: ${req.store.id}) Refund: ${rpcResult.total_refund} EGP`);

    sendSuccess(res, {
      ...rpcResult,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    logger.error('[pos] return creation failed:', err.message);
    apiError(res, 500, err.message || 'حدث خطأ أثناء إتمام عملية الإرجاع', 'HTTP_500');
  }
});

// ── POST /api/pos/orders/:id/send-receipt ──
// Generate vector PDF receipt and dispatch to customer via WhatsApp
router.post('/orders/:id/send-receipt', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = sendReceiptSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'رقم الهاتف مطلوب', 'VALIDATION_ERROR');
  }

  const { phone } = parseResult.data;

  try {
    // 1. Fetch order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, total, total_amount, subtotal, discount, discount_amount, payment_method, items, created_at, phone, metadata')
      .eq('id', req.params.id)
      .eq('store_id', req.store.id)
      .single();

    if (orderError || !order) {
      return apiError(res, 404, 'الفاتورة غير موجودة', 'ORDER_NOT_FOUND');
    }

    // 2. Fetch store prefix & branding
    const { data: settings } = await supabase
      .from('site_settings')
      .select('order_prefix, brand_name')
      .eq('store_id', req.store.id)
      .maybeSingle();

    const orderPrefix = settings?.order_prefix || 'EG-';
    const formattedOrderNumber = `${orderPrefix}${order.order_number}`;

    // 3. Generate high-quality single-page vector PDF receipt
    const { pdfBuffer, fileName } = await generateReceiptPdf({
      order: {
        ...order,
        formatted_order_number: formattedOrderNumber
      },
      store: {
        name: settings?.brand_name || req.store.name || 'المتجر',
        subdomain: req.store.subdomain
      },
      cashierName: order.metadata?.cashier_name || 'الكاشير'
    });

    // 4. Dispatch via WhatsApp Pool
    const caption = `إيصال فاتورة مبيعات رقم ${formattedOrderNumber} من ${settings?.brand_name || req.store.name || 'المتجر'}. شكراً لتعاملكم معنا!`;
    await whatsappPoolService.sendDocument(phone, pdfBuffer, fileName, caption, {
      storeId: req.store.id
    });

    sendSuccess(res, {
      sent: true,
      phone,
      fileName,
      message: 'تم إرسال الفاتورة بنجاح عبر واتساب'
    });
  } catch (err) {
    logger.error('[pos] send receipt failed:', err.message);
    apiError(res, 500, err.message || 'فشل إرسال الفاتورة عبر واتساب', 'WHATSAPP_SEND_FAILED');
  }
});

// ── GET /api/pos/shifts/current ──
// Get current active open shift for this store
router.get('/shifts/current', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const { data: shift, error } = await supabase
      .from('pos_shifts')
      .select('*')
      .eq('store_id', req.store.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!shift) {
      return sendSuccess(res, { shift: null });
    }

    const openingCash = Number(shift.opening_cash) || 0;
    const cashSales = Number(shift.cash_sales) || 0;
    const cardSales = Number(shift.card_sales) || 0;
    const totalSales = Number(shift.total_sales) || 0;
    const payIns = Number(shift.pay_ins) || 0;
    const payOuts = Number(shift.pay_outs) || 0;
    const expectedCash = openingCash + cashSales + payIns - payOuts;

    sendSuccess(res, {
      shift: {
        ...shift,
        opening_cash: openingCash,
        cash_sales: cashSales,
        card_sales: cardSales,
        total_sales: totalSales,
        pay_ins: payIns,
        pay_outs: payOuts,
        expected_cash: expectedCash
      }
    });
  } catch (err) {
    logger.error('[pos] get current shift failed:', err.message);
    apiError(res, 500, 'فشل جلب بيانات الوردية الحالية', 'HTTP_500');
  }
});

// ── POST /api/pos/shifts/open ──
// Open a new cashier shift with starting cash float
router.post('/shifts/open', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = openShiftSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات فتح الوردية غير صالحة', 'VALIDATION_ERROR');
  }

  const { opening_cash, notes } = parseResult.data;
  const userId = req.user?.sub || req.user?.id || null;

  try {
    // Check if an open shift already exists
    const { data: existing } = await supabase
      .from('pos_shifts')
      .select('id, opened_at, cashier_name')
      .eq('store_id', req.store.id)
      .eq('status', 'open')
      .maybeSingle();

    if (existing) {
      return apiError(res, 400, 'يوجد وردية مفتوحة بالفعل لهذا المتجر. يرجى إغلاقها أولاً.', 'SHIFT_ALREADY_OPEN');
    }

    // Resolve cashier name
    let cashierName = req.user?.user_metadata?.full_name || req.user?.name;
    if (!cashierName && userId) {
      const { data: prof } = await supabase.from('user_profiles').select('full_name').eq('user_id', userId).maybeSingle();
      cashierName = prof?.full_name;
    }
    cashierName = cashierName || 'الكاشير';

    const { data: newShift, error } = await supabase
      .from('pos_shifts')
      .insert({
        store_id: req.store.id,
        cashier_user_id: userId,
        cashier_name: cashierName,
        opening_cash: Number(opening_cash) || 0,
        notes: notes || '',
        status: 'open',
        pay_ins: 0,
        pay_outs: 0,
        cash_sales: 0,
        card_sales: 0,
        total_sales: 0,
        expected_cash: Number(opening_cash) || 0,
        cash_movements: []
      })
      .select()
      .single();

    if (error) throw error;

    logger.info(`[pos] Shift opened for store ${req.store.id} by ${cashierName} with ${opening_cash} EGP`);

    sendSuccess(res, {
      shift: {
        ...newShift,
        expected_cash: Number(newShift.opening_cash)
      }
    });
  } catch (err) {
    logger.error('[pos] open shift failed:', err.message);
    apiError(res, 500, err.message || 'فشل فتح الوردية', 'HTTP_500');
  }
});

// ── POST /api/pos/shifts/movement ──
// Record Cash In / Cash Out drawer movement
router.post('/shifts/movement', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = cashMovementSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات الحركة غير صالحة', 'VALIDATION_ERROR');
  }

  const { type, amount, reason } = parseResult.data;
  const userId = req.user?.sub || req.user?.id || null;

  try {
    // 1. Fetch current open shift
    const { data: shift, error: shiftError } = await supabase
      .from('pos_shifts')
      .select('*')
      .eq('store_id', req.store.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (shiftError || !shift) {
      return apiError(res, 400, 'لا توجد وردية مفتوحة لتسجيل الحركة النقدية', 'NO_OPEN_SHIFT');
    }

    const movement = {
      id: crypto.randomUUID(),
      type,
      amount: Number(amount),
      reason,
      cashier_id: userId,
      created_at: new Date().toISOString()
    };

    const currentMovements = Array.isArray(shift.cash_movements) ? shift.cash_movements : [];
    const updatedMovements = [...currentMovements, movement];

    const currentPayIns = Number(shift.pay_ins) || 0;
    const currentPayOuts = Number(shift.pay_outs) || 0;

    const newPayIns = type === 'pay_in' ? currentPayIns + Number(amount) : currentPayIns;
    const newPayOuts = type === 'pay_out' ? currentPayOuts + Number(amount) : currentPayOuts;

    const { data: updatedShift, error: updateError } = await supabase
      .from('pos_shifts')
      .update({
        cash_movements: updatedMovements,
        pay_ins: newPayIns,
        pay_outs: newPayOuts,
        updated_at: new Date().toISOString()
      })
      .eq('id', shift.id)
      .select()
      .single();

    if (updateError) throw updateError;

    const expectedCash = (Number(updatedShift.opening_cash) || 0) +
      (Number(updatedShift.cash_sales) || 0) +
      newPayIns - newPayOuts;

    sendSuccess(res, {
      movement,
      shift: {
        ...updatedShift,
        expected_cash: expectedCash
      }
    });
  } catch (err) {
    logger.error('[pos] cash movement failed:', err.message);
    apiError(res, 500, err.message || 'فشل تسجيل الحركة النقدية', 'HTTP_500');
  }
});

// ── POST /api/pos/shifts/close ──
// Close cashier shift, calculate drawer discrepancy, and produce Z-Report
router.post('/shifts/close', verifyPermission(['tenant.orders.write', 'orders.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = closeShiftSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, parseResult.error.errors[0]?.message || 'بيانات إغلاق الوردية غير صالحة', 'VALIDATION_ERROR');
  }

  const { actual_cash, notes } = parseResult.data;

  try {
    const { data: shift, error: shiftError } = await supabase
      .from('pos_shifts')
      .select('*')
      .eq('store_id', req.store.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (shiftError || !shift) {
      return apiError(res, 400, 'لا توجد وردية مفتوحة لإغلاقها', 'NO_OPEN_SHIFT');
    }

    const openingCash = Number(shift.opening_cash) || 0;
    const cashSales = Number(shift.cash_sales) || 0;
    const cardSales = Number(shift.card_sales) || 0;
    const totalSales = Number(shift.total_sales) || 0;
    const payIns = Number(shift.pay_ins) || 0;
    const payOuts = Number(shift.pay_outs) || 0;
    const expectedCash = openingCash + cashSales + payIns - payOuts;
    const actualCash = Number(actual_cash);
    const difference = actualCash - expectedCash;

    const { data: closedShift, error: closeError } = await supabase
      .from('pos_shifts')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        expected_cash: expectedCash,
        actual_cash: actualCash,
        difference: difference,
        notes: notes || shift.notes || '',
        updated_at: new Date().toISOString()
      })
      .eq('id', shift.id)
      .select()
      .single();

    if (closeError) throw closeError;

    logger.info(`[pos] Shift ${shift.id} closed for store ${req.store.id}. Expected: ${expectedCash} EGP, Actual: ${actualCash} EGP, Diff: ${difference} EGP`);

    sendSuccess(res, {
      shift: closedShift,
      z_report: {
        shift_id: closedShift.id,
        opened_at: closedShift.opened_at,
        closed_at: closedShift.closed_at,
        cashier_name: closedShift.cashier_name,
        opening_cash: openingCash,
        cash_sales: cashSales,
        card_sales: cardSales,
        total_sales: totalSales,
        pay_ins: payIns,
        pay_outs: payOuts,
        expected_cash: expectedCash,
        actual_cash: actualCash,
        difference: difference,
        discrepancy_status: difference === 0 ? 'exact' : (difference > 0 ? 'surplus' : 'deficit')
      }
    });
  } catch (err) {
    logger.error('[pos] close shift failed:', err.message);
    apiError(res, 500, err.message || 'فشل إغلاق الوردية', 'HTTP_500');
  }
});

// ── GET /api/pos/shifts/history ──
// List past shifts with Z-Report metrics
router.get('/shifts/history', verifyPermission(['tenant.orders.read', 'orders.view', 'orders.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: shifts, count, error } = await supabase
      .from('pos_shifts')
      .select('*', { count: 'exact' })
      .eq('store_id', req.store.id)
      .order('opened_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    sendSuccess(res, {
      shifts: shifts || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (err) {
    logger.error('[pos] shift history failed:', err.message);
    apiError(res, 500, 'فشل جلب سجل الورديات', 'HTTP_500');
  }
});

module.exports = router;
