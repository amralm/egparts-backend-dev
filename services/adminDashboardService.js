const { supabase } = require('./supabase');

function parseNum(val) {
  if (val === null || val === undefined || val === '') return 0;
  const num = parseFloat(val.toString().replace(/,/g, ''));
  return Number.isNaN(num) ? 0 : num;
}

function getDateRange(period) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  let currentStart = null;
  let prevStart = null;
  let prevEnd = null;

  switch (period) {
    case 'today': {
      currentStart = todayStart;
      prevStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      prevEnd = todayStart;
      break;
    }
    case '7d': {
      currentStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
      const span = todayStart.getTime() - currentStart.getTime() + 24 * 60 * 60 * 1000;
      prevEnd = currentStart;
      prevStart = new Date(currentStart.getTime() - span);
      break;
    }
    case 'this_month': {
      currentStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      prevEnd = currentStart;
      break;
    }
    case 'all': {
      currentStart = null;
      prevStart = null;
      prevEnd = null;
      break;
    }
    case '30d':
    default: {
      currentStart = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
      const span = todayStart.getTime() - currentStart.getTime() + 24 * 60 * 60 * 1000;
      prevEnd = currentStart;
      prevStart = new Date(currentStart.getTime() - span);
      break;
    }
  }

  return { currentStart, prevStart, prevEnd, now };
}

function calculateDelta(current, prev) {
  if (prev === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - prev) / prev) * 100);
}

async function getDashboard(storeId, settings = {}, period = '30d') {
  const { currentStart, prevStart, prevEnd, now } = getDateRange(period);

  const [productsResult, ordersResult, profilesResult, analyticsResult] = await Promise.all([
    supabase
      .from('products')
      .select('id, name, image, price, cost_price, stock_quantity, low_stock_threshold')
      .eq('store_id', storeId),
    supabase
      .from('orders')
      .select('id, total, status, items, user_id, created_at, phone, payment_method, metadata')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .limit(1000),
    supabase
      .from('user_profiles')
      .select('user_id, full_name, phone', { count: 'exact' })
      .eq('store_id', storeId),
    supabase
      .from('analytics_events')
      .select('event_type, created_at')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .limit(3000)
  ]);

  if (productsResult.error) throw productsResult.error;
  if (ordersResult.error) throw ordersResult.error;
  if (profilesResult.error) throw profilesResult.error;

  const products = productsResult.data || [];
  const allOrders = ordersResult.data || [];
  const profiles = profilesResult.data || [];
  const profileMap = new Map(profiles.map((profile) => [profile.user_id, profile]));
  const allEvents = analyticsResult.data || [];

  // Filter orders by period
  const orders = currentStart
    ? allOrders.filter(o => new Date(o.created_at) >= currentStart)
    : allOrders;

  // Previous period orders for growth comparison
  const prevOrders = (prevStart && prevEnd)
    ? allOrders.filter(o => {
        const d = new Date(o.created_at);
        return d >= prevStart && d < prevEnd;
      })
    : [];

  // Filter analytics events by period
  const events = currentStart
    ? allEvents.filter(e => new Date(e.created_at) >= currentStart)
    : allEvents;

  let low = 0;
  let out = 0;
  let totalValue = 0;
  let inventoryCostValue = 0;
  let productsWithCostCount = 0;
  const lowStockItems = [];
  const globalThreshold = settings.low_stock_threshold ?? 10;
  const isWarningEnabled = settings.low_stock_warning_enabled !== false;

  for (const product of products) {
    const stock = Math.max(0, parseInt(product.stock_quantity, 10) || 0);
    if (stock <= 0) out += 1;
    else if (isWarningEnabled && stock <= globalThreshold) {
      low += 1;
      lowStockItems.push(product);
    }

    const price = parseNum(product.price);
    if (stock > 0) totalValue += price * stock;

    const cost = parseNum(product.cost_price);
    if (cost > 0) productsWithCostCount += 1;
    if (stock > 0) inventoryCostValue += cost * stock;
  }

  const costCoveragePercent = products.length > 0
    ? Math.round((productsWithCostCount / products.length) * 100)
    : 100;

  // Revenue in current period
  const revenue = orders.reduce((acc, order) => {
    if (order.status !== 'delivered') return acc;
    return acc + parseNum(order.total);
  }, 0);

  // Revenue in previous period
  const prevRevenue = prevOrders.reduce((acc, order) => {
    if (order.status !== 'delivered') return acc;
    return acc + parseNum(order.total);
  }, 0);

  const revenueGrowth = calculateDelta(revenue, prevRevenue);
  const ordersGrowth = calculateDelta(orders.length, prevOrders.length);

  const validOrderIds = new Set(
    orders.filter((order) => order.status !== 'cancelled' && order.status !== 'rejected').map((order) => order.id)
  );
  const deliveredOrderIds = new Set(
    orders.filter((order) => order.status === 'delivered').map((order) => order.id)
  );
  const orderIds = orders.map((order) => order.id);
  let orderItems = [];
  if (orderIds.length) {
    const { data, error } = await supabase
      .from('order_items')
      .select('order_id, product_id, quantity, unit_price, unit_cost_snapshot, gross_profit')
      .in('order_id', orderIds);
    if (error) throw error;
    orderItems = data || [];
  }

  const productSales = {};
  const productProfitMap = {};
  const productCostMap = new Map(products.map((p) => [p.id.toString(), parseNum(p.cost_price)]));

  let cogs = 0;
  let netProfit = 0;

  for (const item of orderItems) {
    const pid = item.product_id ? item.product_id.toString() : null;
    if (!pid) continue;

    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);

    // Sales volume tracked from all valid non-cancelled/rejected orders
    if (validOrderIds.has(item.order_id)) {
      productSales[pid] = (productSales[pid] || 0) + qty;
    }

    // Profit and COGS strictly tracked from delivered orders only
    if (deliveredOrderIds.has(item.order_id)) {
      const unitCost = item.unit_cost_snapshot !== null && item.unit_cost_snapshot !== undefined
        ? parseNum(item.unit_cost_snapshot)
        : (productCostMap.get(pid) || 0);

      const itemCost = unitCost * qty;
      cogs += itemCost;

      let itemProfit = 0;
      if (item.gross_profit !== null && item.gross_profit !== undefined && !Number.isNaN(parseFloat(item.gross_profit))) {
        itemProfit = parseNum(item.gross_profit);
      } else {
        const salePrice = parseNum(item.unit_price);
        itemProfit = (salePrice - unitCost) * qty;
      }

      netProfit += itemProfit;
      productProfitMap[pid] = (productProfitMap[pid] || 0) + itemProfit;
    }
  }

  if (netProfit === 0 && revenue > 0 && cogs > 0) {
    netProfit = revenue - cogs;
  }

  const profitMargin = revenue > 0
    ? Math.min(100, Math.max(-100, Math.round((netProfit / revenue) * 100)))
    : 0;

  const formatProduct = (candidateId, qty, profit) => {
    const product = products.find((c) => c.id.toString() === candidateId.toString());
    return {
      id: candidateId.toString(),
      name: product?.name || 'منتج',
      image: product?.image || null,
      qty: Number(qty || 0),
      profit: Math.round(Number(profit || 0))
    };
  };

  const topProductsByQty = Object.entries(productSales)
    .map(([id, qty]) => formatProduct(id, qty, productProfitMap[id] || 0))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  const topProductsByProfit = Object.entries(productProfitMap)
    .map(([id, profit]) => formatProduct(id, productSales[id] || 0, profit))
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 5);

  const topProducts = topProductsByQty;

  const recentOrders = allOrders.slice(0, 7).map((order) => {
    const profile = order.user_id ? profileMap.get(order.user_id) : null;
    return {
      ...order,
      phone: order.phone || profile?.phone || '-',
      full_name: profile?.full_name || (order.user_id ? 'Customer' : 'Guest customer')
    };
  });

  // ── 1. Daily / Period Timeline Trend (for SVG Area/Bar Chart) ──
  const daysCount = period === 'today' ? 1 : period === '7d' ? 7 : 30;
  const timelineMap = new Map();

  if (period === 'today') {
    // 24-hour breakdown for today
    for (let h = 0; h < 24; h += 3) {
      const key = `${String(h).padStart(2, '0')}:00`;
      timelineMap.set(key, { key, label: key, revenue: 0, orders: 0, profit: 0 });
    }
    for (const order of orders) {
      const d = new Date(order.created_at);
      const hourSlot = Math.floor(d.getHours() / 3) * 3;
      const key = `${String(hourSlot).padStart(2, '0')}:00`;
      const slot = timelineMap.get(key) || { key, label: key, revenue: 0, orders: 0, profit: 0 };
      slot.orders += 1;
      if (order.status === 'delivered') {
        slot.revenue += parseNum(order.total);
      }
      timelineMap.set(key, slot);
    }
  } else {
    // Daily buckets
    const numDays = daysCount;
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let i = numDays - 1; i >= 0; i--) {
      const dayDate = new Date(todayMidnight.getTime() - i * 24 * 60 * 60 * 1000);
      const isoDay = dayDate.toISOString().split('T')[0];
      const label = `${dayDate.getDate()}/${dayDate.getMonth() + 1}`;
      timelineMap.set(isoDay, { key: isoDay, label, revenue: 0, orders: 0, profit: 0 });
    }

    for (const order of orders) {
      const isoDay = order.created_at ? order.created_at.split('T')[0] : null;
      if (isoDay && timelineMap.has(isoDay)) {
        const slot = timelineMap.get(isoDay);
        slot.orders += 1;
        if (order.status === 'delivered') {
          slot.revenue += parseNum(order.total);
        }
      }
    }
  }

  const timeline = Array.from(timelineMap.values()).map(slot => ({
    ...slot,
    revenue: Math.round(slot.revenue),
    profit: Math.round(slot.revenue * (profitMargin > 0 ? profitMargin / 100 : 0.25)) // Proportional estimated daily profit
  }));

  // ── 2. Payment Methods & Sales Channels Breakdown ──
  const paymentBreakdown = {
    cod: { count: 0, total: 0, label: 'الدفع عند الاستلام' },
    card: { count: 0, total: 0, label: 'بطاقات بنكية (Paymob)' },
    manual_wallet: { count: 0, total: 0, label: 'محافظ إلكترونية / إنستاباي' },
    pos_cashier: { count: 0, total: 0, label: 'كاشير الفرع (POS)' }
  };

  for (const order of orders) {
    const isPos = order.metadata?.source === 'pos_terminal' || order.payment_method === 'pos_cashier' || order.payment_method === 'cash';
    let methodKey = 'cod';
    if (isPos) {
      methodKey = 'pos_cashier';
    } else if (order.payment_method === 'card') {
      methodKey = 'card';
    } else if (order.payment_method === 'manual_wallet') {
      methodKey = 'manual_wallet';
    } else {
      methodKey = 'cod';
    }

    if (!paymentBreakdown[methodKey]) {
      paymentBreakdown[methodKey] = { count: 0, total: 0, label: methodKey };
    }
    paymentBreakdown[methodKey].count += 1;
    if (order.status === 'delivered') {
      paymentBreakdown[methodKey].total += parseNum(order.total);
    }
  }

  const paymentBreakdownList = Object.entries(paymentBreakdown).map(([key, data]) => ({
    key,
    label: data.label,
    count: data.count,
    total: Math.round(data.total),
    percent: orders.length > 0 ? Math.round((data.count / orders.length) * 100) : 0
  })).sort((a, b) => b.count - a.count);

  // ── 3. E-commerce Conversion Funnel Pipeline ──
  // Step 1: Checkout Visits / Initiated (checkout_start from analytics_events + fallback to orders)
  const checkoutStartEvents = events.filter(e => e.event_type === 'checkout_start').length;
  const checkoutStarts = Math.max(checkoutStartEvents, orders.length);

  // Step 2: Customer Identity / OTP / Verification passed
  const otpSuccessEvents = events.filter(e => e.event_type === 'otp_success').length;
  const identityVerified = Math.max(otpSuccessEvents, Math.min(checkoutStarts, orders.length));

  // Step 3: Orders placed (all orders created)
  const ordersPlaced = orders.length;

  // Step 4: Orders Delivered / Paid
  const ordersDelivered = orders.filter(o => o.status === 'delivered').length;

  const funnel = [
    {
      step: 'checkout_start',
      label: 'بدء عملية الشراء والسلة',
      count: checkoutStarts,
      rate: 100
    },
    {
      step: 'identity_verified',
      label: 'تأكيد الهاتف وتفاصيل العنوان',
      count: identityVerified,
      rate: checkoutStarts > 0 ? Math.min(100, Math.round((identityVerified / checkoutStarts) * 100)) : 100
    },
    {
      step: 'orders_placed',
      label: 'تأكيد وإتمام الطلب',
      count: ordersPlaced,
      rate: checkoutStarts > 0 ? Math.min(100, Math.round((ordersPlaced / checkoutStarts) * 100)) : 0
    },
    {
      step: 'orders_delivered',
      label: 'تسليم الطلب وتحصيل المبلغ',
      count: ordersDelivered,
      rate: ordersPlaced > 0 ? Math.min(100, Math.round((ordersDelivered / ordersPlaced) * 100)) : 0
    }
  ];

  const overallConversionRate = checkoutStarts > 0 ? Math.round((ordersPlaced / checkoutStarts) * 100) : 0;
  const abandonmentRate = Math.max(0, 100 - overallConversionRate);

  return {
    period,
    stats: {
      products: products.length,
      lowStock: low,
      outOfStock: out,
      orders: orders.length,
      allTimeOrders: allOrders.length,
      totalValue: Math.round(totalValue),
      inventoryCostValue: Math.round(inventoryCostValue),
      revenue: Math.round(revenue),
      prevRevenue: Math.round(prevRevenue),
      revenueGrowth,
      ordersGrowth,
      cogs: Math.round(cogs),
      netProfit: Math.round(netProfit),
      profitMargin,
      costCoveragePercent,
      productsWithCostCount,
      users: profilesResult.count ?? new Set(allOrders.map((order) => order.user_id).filter(Boolean)).size
    },
    timeline,
    paymentBreakdown: paymentBreakdownList,
    funnel: {
      steps: funnel,
      overallConversionRate,
      abandonmentRate,
      checkoutStarts,
      ordersPlaced,
      ordersDelivered
    },
    recentOrders,
    topProducts,
    topProductsByQty,
    topProductsByProfit,
    lowStockItems: lowStockItems.slice(0, 5)
  };
}

module.exports = {
  getDashboard
};
