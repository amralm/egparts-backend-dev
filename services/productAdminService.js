'use strict';

const { supabase } = require('./supabase');
const { safeDeleteR2Objects, extractR2Key } = require('../utils/r2Helper');
const logger = require('../utils/logger');

async function listProducts(storeId, viewMode = 'active') {
  let query = supabase
    .from('products')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });

  query = viewMode === 'deleted'
    ? query.eq('is_deleted', true)
    : query.eq('is_deleted', false);

  const { data, error } = await query;
  if (error) throw error;

  const { data: orderItems, error: orderErr } = await supabase
    .from('order_items')
    .select('product_id, orders!order_items_order_id_fkey!inner(status, store_id)')
    .eq('orders.store_id', storeId)
    .in('orders.status', ['pending', 'confirmed', 'processing']);

  if (orderErr) {
    console.warn('[admin-products] active order counts unavailable:', orderErr.message);
  }

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

    // 1. Fetch current product to check if media is being replaced or removed
    const { data: currentProduct } = await supabase
      .from('products')
      .select('image, gallery')
      .eq('id', productId)
      .eq('store_id', storeId)
      .maybeSingle();

    const { data, error } = await supabase
      .from('products')
      .update(productPayload)
      .eq('id', productId)
      .eq('store_id', storeId)
      .select('*')
      .maybeSingle();

    if (error) throw error;

    // 2. Compute removed media files and safely delete from R2 (non-blocking)
    if (currentProduct) {
      const removedKeys = [];

      // Check if main image changed
      if (productPayload.image !== undefined && currentProduct.image && productPayload.image !== currentProduct.image) {
        removedKeys.push(currentProduct.image);
      }

      // Check if gallery images removed
      if (Array.isArray(productPayload.gallery) && Array.isArray(currentProduct.gallery)) {
        const newGallerySet = new Set(productPayload.gallery.map(extractR2Key).filter(Boolean));
        currentProduct.gallery.forEach((oldImg) => {
          const oldKey = extractR2Key(oldImg);
          if (oldKey && !newGallerySet.has(oldKey)) {
            removedKeys.push(oldImg);
          }
        });
      }

      if (removedKeys.length > 0) {
        safeDeleteR2Objects(removedKeys).catch((err) => {
          logger.warn(`[productAdminService] Background R2 media cleanup warning: ${err.message}`);
        });
      }
    }

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
  if (!data) throw new Error('Product not found or access denied');
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
  if (!product) throw new Error('Product not found or access denied');

  const { error: ordErr } = await supabase.from('order_items').update({ product_id: null }).eq('product_id', productId);
  if (ordErr) throw ordErr;
  
  const { error: invErr } = await supabase.from('inventory_adjustments').delete().eq('product_id', productId);
  if (invErr) throw invErr;

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId)
    .eq('store_id', storeId);

  if (error) throw error;

  // Collect all media keys to delete from Cloudflare R2
  const mediaKeys = [];
  if (product?.image) mediaKeys.push(product.image);
  if (Array.isArray(product?.gallery)) {
    product.gallery.forEach((key) => {
      if (key) mediaKeys.push(key);
    });
  }

  // Delete all product media from Cloudflare R2
  if (mediaKeys.length > 0) {
    safeDeleteR2Objects(mediaKeys).catch((err) => {
      logger.warn(`[productAdminService] R2 media deletion warning on hard delete: ${err.message}`);
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
  if (!data) throw new Error('Product not found or access denied');
  return data;
}

async function bulkUnpriceProducts(storeId, { productIds, all } = {}) {
  let query = supabase
    .from('products')
    .update({ price: null, old_price: null })
    .eq('store_id', storeId)
    .eq('is_deleted', false);

  if (!all && Array.isArray(productIds) && productIds.length > 0) {
    query = query.in('id', productIds);
  }

  const { data, error } = await query.select('id');
  if (error) throw error;
  return { updatedCount: data?.length || 0 };
}

module.exports = {
  listProducts,
  saveProduct,
  softDeleteProduct,
  hardDeleteProduct,
  restoreProduct,
  bulkUnpriceProducts
};
