const { supabase } = require('./supabase');

function parseNum(val) {
  if (val === null || val === undefined || val === '') return 0;
  const num = parseFloat(val.toString().replace(/,/g, ''));
  return Number.isNaN(num) ? 0 : num;
}

async function getDashboard(storeId, settings = {}) {
  const [productsResult, ordersResult, profilesResult] = await Promise.all([
    supabase
      .from('products')
      .select('id, name, image, price, cost_price, stock_quantity, low_stock_threshold')
      .eq('store_id', storeId),
    supabase
      .from('orders')
      .select('id, total, status, items, user_id, created_at, phone')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .limit(1000),
    supabase
      .from('user_profiles')
      .select('user_id, full_name, phone', { count: 'exact' })
      .eq('store_id', storeId)
  ]);

  if (productsResult.error) throw productsResult.error;
  if (ordersResult.error) throw ordersResult.error;
  if (profilesResult.error) throw profilesResult.error;

  const products = productsResult.data || [];
  const orders = ordersResult.data || [];
  const profiles = profilesResult.data || [];
  const profileMap = new Map(profiles.map((profile) => [profile.user_id, profile]));

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

  const revenue = orders.reduce((acc, order) => {
    if (order.status !== 'delivered') return acc;
    return acc + parseNum(order.total);
  }, 0);

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

  const recentOrders = orders.slice(0, 7).map((order) => {
    const profile = order.user_id ? profileMap.get(order.user_id) : null;
    return {
      ...order,
      phone: order.phone || profile?.phone || '-',
      full_name: profile?.full_name || (order.user_id ? 'Customer' : 'Guest customer')
    };
  });

  return {
    stats: {
      products: products.length,
      lowStock: low,
      outOfStock: out,
      orders: orders.length,
      totalValue: Math.round(totalValue),
      inventoryCostValue: Math.round(inventoryCostValue),
      revenue: Math.round(revenue),
      cogs: Math.round(cogs),
      netProfit: Math.round(netProfit),
      profitMargin,
      costCoveragePercent,
      productsWithCostCount,
      users: profilesResult.count ?? new Set(orders.map((order) => order.user_id).filter(Boolean)).size
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
