const { supabase } = require('./supabase');

async function listProducts(storeId, viewMode = 'active') {
  let query = supabase
    .from('products')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });

  query = viewMode === 'deleted'
    ? query.eq('is_deleted', true)
    : query.neq('is_deleted', true);

  const { data, error } = await query;
  if (error) throw error;

  const { data: orderItems, error: orderErr } = await supabase
    .from('order_items')
    .select('product_id, orders!order_items_order_id_fkey!inner(status, store_id)')
    .eq('orders.store_id', storeId)
    .in('orders.status', ['pending', 'confirmed', 'processing']);

  if (orderErr) throw orderErr;

  const activeCounts = {};
  (orderItems || []).forEach((item) => {
    activeCounts[item.product_id] = (activeCounts[item.product_id] || 0) + 1;
  });

  return (data || []).map((product) => ({
    ...product,
    active_orders_count: activeCounts[product.id] || 0
  }));
}

async function saveProduct(storeId, payload, productId = null) {
  const productPayload = { ...payload, store_id: storeId };
  if (productId) {
    delete productPayload.store_id;
    const { data, error } = await supabase
      .from('products')
      .update(productPayload)
      .eq('id', productId)
      .eq('store_id', storeId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('products')
    .insert([productPayload])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function softDeleteProduct(storeId, productId) {
  const { data, error } = await supabase
    .from('products')
    .update({
      is_deleted: true,
      is_active: false,
      deleted_at: new Date().toISOString()
    })
    .eq('id', productId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function hardDeleteProduct(storeId, productId) {
  const { data: product, error: fetchErr } = await supabase
    .from('products')
    .select('image, gallery')
    .eq('id', productId)
    .eq('store_id', storeId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  await supabase.from('order_items').update({ product_id: null }).eq('product_id', productId);
  await supabase.from('inventory_adjustments').delete().eq('product_id', productId);

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId)
    .eq('store_id', storeId);
  if (error) throw error;

  const mediaKeys = [];
  if (product?.image && !/^https?:\/\//.test(product.image)) mediaKeys.push(product.image);
  if (Array.isArray(product?.gallery)) {
    product.gallery.forEach((key) => {
      if (key && !/^https?:\/\//.test(key)) mediaKeys.push(key);
    });
  }

  return { mediaKeys };
}

async function restoreProduct(storeId, productId) {
  const { data, error } = await supabase
    .from('products')
    .update({ is_deleted: false, deleted_at: null })
    .eq('id', productId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data;
}

module.exports = {
  listProducts,
  saveProduct,
  softDeleteProduct,
  hardDeleteProduct,
  restoreProduct
};
