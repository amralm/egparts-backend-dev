const { supabase } = require('./supabase');

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
  const lowStockItems = [];
  const globalThreshold = settings.low_stock_threshold ?? 10;
  const isWarningEnabled = settings.low_stock_warning_enabled !== false;

  for (const product of products) {
    const stock = product.stock_quantity || 0;
    if (stock <= 0) out += 1;
    else if (isWarningEnabled && stock <= globalThreshold) {
      low += 1;
      lowStockItems.push(product);
    }

    const price = parseFloat(product.price?.toString().replace(/,/g, '') || 0);
    if (!Number.isNaN(price) && stock > 0) totalValue += price * stock;

    const cost = parseFloat(product.cost_price?.toString().replace(/,/g, '') || 0);
    if (!Number.isNaN(cost) && stock > 0) inventoryCostValue += cost * stock;
  }

  const revenue = orders.reduce((acc, order) => {
    if (order.status !== 'delivered') return acc;
    const total = parseFloat(order.total?.toString().replace(/,/g, '') || 0);
    return acc + (Number.isNaN(total) ? 0 : total);
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
  const productCostMap = new Map(products.map((p) => [p.id.toString(), parseFloat(p.cost_price || 0)]));

  let cogs = 0;
  let netProfit = 0;

  for (const item of orderItems) {
    if (validOrderIds.has(item.order_id)) {
      productSales[item.product_id] = (productSales[item.product_id] || 0) + (item.quantity || 1);
    }

    if (deliveredOrderIds.has(item.order_id)) {
      const qty = item.quantity || 1;
      let unitCost = item.unit_cost_snapshot !== null && item.unit_cost_snapshot !== undefined
        ? parseFloat(item.unit_cost_snapshot)
        : (productCostMap.get(item.product_id?.toString()) || 0);
      if (Number.isNaN(unitCost)) unitCost = 0;

      cogs += (unitCost * qty);

      if (item.gross_profit !== null && item.gross_profit !== undefined && !Number.isNaN(parseFloat(item.gross_profit))) {
        netProfit += parseFloat(item.gross_profit);
      } else {
        const salePrice = parseFloat(item.unit_price || 0);
        netProfit += ((salePrice - unitCost) * qty);
      }
    }
  }

  if (netProfit === 0 && revenue > 0 && cogs > 0) {
    netProfit = Math.max(0, revenue - cogs);
  }

  const topProducts = Object.entries(productSales)
    .map(([id, qty]) => {
      const product = products.find((candidate) => candidate.id.toString() === id.toString());
      return { id, qty, name: product?.name || 'Unknown product', image: product?.image };
    })
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

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
      totalValue,
      inventoryCostValue,
      revenue,
      cogs,
      netProfit,
      users: profilesResult.count ?? new Set(orders.map((order) => order.user_id).filter(Boolean)).size
    },
    recentOrders,
    topProducts,
    lowStockItems: lowStockItems.slice(0, 5)
  };
}

module.exports = {
  getDashboard
};
