const { supabase } = require('./supabase');

async function listWishlist(storeId, userId) {
  const { data, error } = await supabase
    .from('wishlists')
    .select('product_id')
    .eq('store_id', storeId)
    .eq('user_id', userId);

  if (error) throw error;
  return (data || []).map((item) => item.product_id);
}

async function listWishlistProducts(storeId, userId) {
  const productIds = await listWishlist(storeId, userId);
  if (!productIds.length) return [];

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .in('id', productIds)
    .eq('store_id', storeId)
    .eq('is_active', true)
    .neq('is_deleted', true);

  if (error) throw error;
  return data || [];
}

async function addWishlistItem(storeId, userId, productId) {
  const { data, error } = await supabase
    .from('wishlists')
    .upsert([{ store_id: storeId, user_id: userId, product_id: productId }], {
      onConflict: 'store_id,user_id,product_id'
    })
    .select('product_id')
    .maybeSingle();

  if (error) throw error;
  return data?.product_id || productId;
}

async function removeWishlistItem(storeId, userId, productId) {
  const { error } = await supabase
    .from('wishlists')
    .delete()
    .eq('store_id', storeId)
    .eq('user_id', userId)
    .eq('product_id', productId);

  if (error) throw error;
}

module.exports = {
  listWishlist,
  listWishlistProducts,
  addWishlistItem,
  removeWishlistItem
};
