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
  const updatePayload = { content };
  if (content?.site_name) {
    updatePayload.brand_name = content.site_name;
  }

  const { data, error } = await supabase
    .from('site_settings')
    .update(updatePayload)
    .eq('store_id', storeId)
    .select('content')
    .maybeSingle();

  if (error) throw error;
  
  // If row doesn't exist, create it
  if (!data) {
    const { data: upsertData, error: upsertError } = await supabase
      .from('site_settings')
      .upsert({ store_id: storeId, ...updatePayload }, { onConflict: 'store_id' })
      .select('content')
      .maybeSingle();
    
    if (upsertError) throw upsertError;
    return upsertData?.content || content;
  }
  
  return data?.content || content;
}

module.exports = {
  listProductCategories,
  getStoreContent,
  updateStoreContent
};
