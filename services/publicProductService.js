const { supabase } = require('./supabase');

async function getProductDetail(storeId, productId, options = {}) {
  const productResult = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .eq('store_id', storeId)
    .single();

  if (productResult.error || !productResult.data || productResult.data.is_deleted || productResult.data.is_active === false) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    throw err;
  }

  const product = productResult.data;

  const jobs = [];

  if (product.category) {
    jobs.push(
      supabase
        .from('products')
        .select('*')
        .eq('store_id', storeId)
        .eq('category', product.category)
        .eq('is_active', true)
        .neq('id', product.id)
        .limit(4)
    );
  } else {
    jobs.push(Promise.resolve({ data: [], error: null }));
  }

  let crossQuery = supabase
    .from('products')
    .select('*')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .neq('id', product.id)
    .limit(12);

  if (options.crossSellDemo === false && product.category) {
    crossQuery = crossQuery.eq('category', product.category);
  }
  jobs.push(options.crossSellActive === false ? Promise.resolve({ data: [], error: null }) : crossQuery);

  jobs.push(
    supabase
      .from('reviews')
      .select('*')
      .eq('store_id', storeId)
      .eq('product_id', productId)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
  );

  jobs.push(supabase.rpc('get_product_sales_today', { p_product_id: product.id }));

  const [similarResult, crossResult, reviewsResult, salesResult] = await Promise.all(jobs);

  const crossProducts = crossResult.data || [];
  const shuffledCrossProducts = [...crossProducts].sort(() => 0.5 - Math.random()).slice(0, 4);

  return {
    product,
    similar_products: similarResult.data || [],
    cross_sell_products: shuffledCrossProducts,
    reviews: reviewsResult.data || [],
    real_sales_today: salesResult.data || 0
  };
}

async function submitReview(storeId, productId, review) {
  const sanitizedName = String(review.user_name || '').trim().slice(0, 100);
  const sanitizedComment = String(review.comment || '').trim().slice(0, 2000);
  const rating = Number(review.rating);

  if (sanitizedName.length < 2 || sanitizedComment.length < 5 || rating < 1 || rating > 5) {
    const err = new Error('Invalid review');
    err.statusCode = 400;
    throw err;
  }

  const { data, error } = await supabase
    .from('reviews')
    .insert({
      store_id: storeId,
      product_id: productId,
      user_name: sanitizedName,
      rating,
      comment: sanitizedComment,
      status: 'pending'
    })
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data;
}

module.exports = {
  getProductDetail,
  submitReview
};
