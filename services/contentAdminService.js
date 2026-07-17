const { supabase } = require('./supabase');

async function listProductCategories(storeId) {
  const { data, error } = await supabase
    .from('products')
    .select('category')
    .eq('store_id', storeId)
    .neq('category', null);

  if (error) throw error;
  return [...new Set((data || []).map((product) => product.category).filter(Boolean))];
}

async function getStoreContent(storeId) {
  const { data, error } = await supabase
    .from('site_settings')
    .select('content')
    .eq('store_id', storeId)
    .maybeSingle();

  if (error) throw error;
  return data?.content || null;
}

async function updateStoreContent(storeId, content) {
  const { data, error } = await supabase
    .from('site_settings')
    .update({ content })
    .eq('store_id', storeId)
    .select('content')
    .maybeSingle();

  if (error) throw error;
  return data?.content || content;
}

module.exports = {
  listProductCategories,
  getStoreContent,
  updateStoreContent
};
