const { supabase } = require('./supabase');

async function getDashboard(storeId, settings = {}) {
  const [productsResult, ordersResult, profilesResult] = await Promise.all([
    supabase
      .from('products')
      .select('id, name, image, price, stock_quantity, low_stock_threshold')
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
  }

  const revenue = orders.reduce((acc, order) => {
    if (order.status !== 'delivered') return acc;
    const total = parseFloat(order.total?.toString().replace(/,/g, '') || 0);
    return acc + (Number.isNaN(total) ? 0 : total);
  }, 0);

  const validOrderIds = new Set(
    orders.filter((order) => order.status !== 'cancelled' && order.status !== 'rejected').map((order) => order.id)
  );
  const orderIds = orders.map((order) => order.id);
  let orderItems = [];
  if (orderIds.length) {
    const { data, error } = await supabase
      .from('order_items')
      .select('order_id, product_id, quantity')
      .in('order_id', orderIds);
    if (error) throw error;
    orderItems = data || [];
  }

  const productSales = {};
  for (const item of orderItems) {
    if (validOrderIds.has(item.order_id)) {
      productSales[item.product_id] = (productSales[item.product_id] || 0) + (item.quantity || 1);
    }
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
      revenue,
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
