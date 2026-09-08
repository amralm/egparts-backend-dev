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
  delete product.cost_price;

  let productOptions = [];
  let productVariants = [];

  if (product.has_variants) {
    const { data: dbOptions, error: optErr } = await supabase
      .from('product_options')
      .select('id, name, normalized_name, sort_order')
      .eq('product_id', productId)
      .eq('store_id', storeId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (!optErr && dbOptions) {
      const optionIds = dbOptions.map(o => o.id);
      let dbValues = [];
      if (optionIds.length > 0) {
        const { data: valData } = await supabase
          .from('product_option_values')
          .select('id, option_id, value, normalized_value, sort_order')
          .in('option_id', optionIds)
          .eq('store_id', storeId)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true });
        dbValues = valData || [];
      }

      productOptions = dbOptions.map(opt => ({
        id: opt.id,
        name: opt.name,
        normalized_name: opt.normalized_name,
        sort_order: opt.sort_order,
        values: dbValues
          .filter(v => v.option_id === opt.id)
          .map(v => ({
            id: v.id,
            option_id: v.option_id,
            value: v.value,
            normalized_value: v.normalized_value,
            sort_order: v.sort_order
          }))
      }));
    }

    const { data: dbVariants, error: varErr } = await supabase
      .from('product_variants')
      .select('id, product_id, sku, barcode, price, old_price, stock_quantity, is_active, combination_key')
      .eq('product_id', productId)
      .eq('store_id', storeId)
      .eq('is_archived', false)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (!varErr && dbVariants) {
      const variantIds = dbVariants.map(v => v.id);
      let junctionRows = [];
      if (variantIds.length > 0) {
        const { data: juncData } = await supabase
          .from('product_variant_option_values')
          .select('variant_id, option_value_id')
          .in('variant_id', variantIds)
          .eq('store_id', storeId);
        junctionRows = juncData || [];
      }

      productVariants = dbVariants.map(v => ({
        id: v.id,
        product_id: v.product_id,
        sku: v.sku,
        barcode: v.barcode,
        price: v.price != null ? Number(v.price) : Number(product.price),
        old_price: v.old_price != null ? Number(v.old_price) : (product.old_price != null ? Number(product.old_price) : null),
        stock_quantity: Number(v.stock_quantity || 0),
        is_active: v.is_active,
        combination_key: v.combination_key,
        option_value_ids: junctionRows.filter(j => j.variant_id === v.id).map(j => j.option_value_id)
      }));
    }
  }

  product.options = productOptions;
  product.variants = productVariants;

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
    options: productOptions,
    variants: productVariants,
    similar_products: (similarResult.data || []).map(p => { delete p.cost_price; return p; }),
    cross_sell_products: shuffledCrossProducts.map(p => { delete p.cost_price; return p; }),
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
