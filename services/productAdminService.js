'use strict';

const crypto = require('crypto');
const { supabase } = require('./supabase');
const { safeDeleteR2Objects, extractR2Key } = require('../utils/r2Helper');
const { normalizeArabicToken } = require('./location/canonicalLocations');
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

async function getProductDetail(storeId, productId) {
  const { data: product, error: prodErr } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .eq('store_id', storeId)
    .maybeSingle();

  if (prodErr || !product) {
    throw new Error('Product not found or access denied');
  }

  let options = [];
  let variants = [];

  if (product.has_variants) {
    // 1. Fetch options with values
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

      options = dbOptions.map(opt => ({
        ...opt,
        values: dbValues.filter(v => v.option_id === opt.id)
      }));
    }

    // 2. Fetch variants
    const { data: dbVariants, error: varErr } = await supabase
      .from('product_variants')
      .select('*')
      .eq('product_id', productId)
      .eq('store_id', storeId)
      .eq('is_archived', false)
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

      variants = dbVariants.map(v => ({
        ...v,
        option_value_ids: junctionRows.filter(j => j.variant_id === v.id).map(j => j.option_value_id)
      }));
    }
  }

  return { product, options, variants };
}

async function saveProduct(storeId, payload, productId = null) {
  const { options: incomingOptions, variants: incomingVariants, ...rawProductPayload } = payload;
  const hasVariants = Boolean(rawProductPayload.has_variants);
  const productPayload = { ...rawProductPayload, store_id: storeId, has_variants: hasVariants };

  let currentProduct = null;
  if (productId) {
    delete productPayload.store_id;

    // Fetch current product to check media and current state
    const { data: current } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .eq('store_id', storeId)
      .maybeSingle();

    if (!current) throw new Error('Product not found or access denied');
    currentProduct = current;

    // If product currently has variants or will have variants, do not let external payload directly overwrite stock_quantity
    if (hasVariants || currentProduct.has_variants) {
      delete productPayload.stock_quantity;
      delete productPayload.stock;
    }
  }

  // 1. Upsert or update product row
  let savedProduct;
  if (productId) {
    const { data, error } = await supabase
      .from('products')
      .update(productPayload)
      .eq('id', productId)
      .eq('store_id', storeId)
      .select('*')
      .maybeSingle();

    if (error) throw error;
    savedProduct = data;

    // Media garbage collection for removed images in R2
    if (currentProduct) {
      const removedKeys = [];
      if (productPayload.image !== undefined && currentProduct.image && productPayload.image !== currentProduct.image) {
        removedKeys.push(currentProduct.image);
      }
      if (Array.isArray(productPayload.gallery) && Array.isArray(currentProduct.gallery)) {
        const newGallerySet = new Set(productPayload.gallery.map(extractR2Key).filter(Boolean));
        currentProduct.gallery.forEach((oldImg) => {
          const oldKey = extractR2Key(oldImg);
          if (oldKey && !newGallerySet.has(oldKey)) removedKeys.push(oldImg);
        });
      }
      if (removedKeys.length > 0) {
        safeDeleteR2Objects(removedKeys).catch((err) => {
          logger.warn(`[productAdminService] Media cleanup warning: ${err.message}`);
        });
      }
    }
  } else {
    // For new product with variants, initial stock_quantity will be set by variants sync trigger
    if (hasVariants) {
      productPayload.stock_quantity = 0;
      productPayload.stock = 0;
    }
    const { data, error } = await supabase
      .from('products')
      .insert([productPayload])
      .select('*')
      .maybeSingle();

    if (error) throw error;
    savedProduct = data;
  }

  const finalProductId = savedProduct.id;

  // 2. If hasVariants: Synchronize Options, Values, Variants, and Barcode Registry
  if (hasVariants && Array.isArray(incomingOptions) && incomingOptions.length > 0 && Array.isArray(incomingVariants) && incomingVariants.length > 0) {
    // 2a. Sync product_options and product_option_values
    const optionNameToIdMap = new Map(); // normalizedName -> option record
    const valueMap = new Map(); // `${optId}:${normalizedVal}` -> value record
    const summaryOptions = [];

    // Fetch existing options for diffing
    const { data: existingOpts } = await supabase
      .from('product_options')
      .select('id, name, normalized_name, sort_order')
      .eq('product_id', finalProductId)
      .eq('store_id', storeId);

    const existingOptMap = new Map((existingOpts || []).map(o => [o.normalized_name, o]));

    for (let oIdx = 0; oIdx < incomingOptions.length; oIdx++) {
      const opt = incomingOptions[oIdx];
      const optName = String(opt.name || '').trim();
      const normOptName = normalizeArabicToken(optName);
      if (!normOptName) continue;

      let optionId = opt.id || existingOptMap.get(normOptName)?.id || crypto.randomUUID();

      // Upsert option
      const { data: savedOpt, error: optErr } = await supabase
        .from('product_options')
        .upsert({
          id: optionId,
          product_id: finalProductId,
          store_id: storeId,
          name: optName,
          normalized_name: normOptName,
          sort_order: opt.sort_order !== undefined ? opt.sort_order : oIdx
        })
        .select('*')
        .single();

      if (optErr) throw optErr;
      optionId = savedOpt.id;
      optionNameToIdMap.set(normOptName, savedOpt);

      // Fetch existing values for this option
      const { data: existingVals } = await supabase
        .from('product_option_values')
        .select('id, value, normalized_value, sort_order')
        .eq('option_id', optionId)
        .eq('product_id', finalProductId)
        .eq('store_id', storeId);

      const existingValMap = new Map((existingVals || []).map(v => [v.normalized_value, v]));
      const rawValues = Array.isArray(opt.values) ? opt.values : [];
      const summaryVals = [];

      for (let vIdx = 0; vIdx < rawValues.length; vIdx++) {
        const valItem = rawValues[vIdx];
        const valStr = typeof valItem === 'object' ? String(valItem.value || '').trim() : String(valItem).trim();
        const normValStr = normalizeArabicToken(valStr);
        if (!normValStr) continue;

        let valId = (typeof valItem === 'object' && valItem.id) || existingValMap.get(normValStr)?.id || crypto.randomUUID();

        const { data: savedVal, error: valErr } = await supabase
          .from('product_option_values')
          .upsert({
            id: valId,
            option_id: optionId,
            product_id: finalProductId,
            store_id: storeId,
            value: valStr,
            normalized_value: normValStr,
            sort_order: (typeof valItem === 'object' && valItem.sort_order !== undefined) ? valItem.sort_order : vIdx
          })
          .select('*')
          .single();

        if (valErr) throw valErr;
        valId = savedVal.id;
        valueMap.set(`${optionId}:${normValStr}`, savedVal);
        valueMap.set(valId, savedVal);
        summaryVals.push(valStr);
      }

      summaryOptions.push({
        name: optName,
        values: summaryVals
      });
    }

    // 2b. Sync product_variants and enforce EXACT_OPTION_COVERAGE
    const totalOptionsCount = incomingOptions.length;
    const { data: existingVariants } = await supabase
      .from('product_variants')
      .select('id, combination_key, barcode, is_archived')
      .eq('product_id', finalProductId)
      .eq('store_id', storeId);

    const existingVarMap = new Map((existingVariants || []).map(v => [v.combination_key, v]));
    const incomingProcessedVarKeys = new Set();

    for (const vPayload of incomingVariants) {
      // Resolve option_value_ids for this variant
      let resolvedValueIds = [];

      if (Array.isArray(vPayload.option_value_ids) && vPayload.option_value_ids.length > 0) {
        resolvedValueIds = vPayload.option_value_ids.filter(id => valueMap.has(id));
      } else if (vPayload.option_values && typeof vPayload.option_values === 'object') {
        for (const [rawOptName, rawOptVal] of Object.entries(vPayload.option_values)) {
          const normOpt = normalizeArabicToken(rawOptName);
          const normVal = normalizeArabicToken(rawOptVal);
          const optRec = optionNameToIdMap.get(normOpt);
          if (optRec) {
            const valRec = valueMap.get(`${optRec.id}:${normVal}`);
            if (valRec) resolvedValueIds.push(valRec.id);
          }
        }
      }

      // Enforce EXACT_OPTION_COVERAGE: every variant must map to exactly one value per defined option!
      if (resolvedValueIds.length !== totalOptionsCount) {
        throw new Error(`INCOMPLETE_OPTION_COMBINATION: Variant "${vPayload.title || ''}" must have a value for all ${totalOptionsCount} product options.`);
      }

      // Sort deterministically to derive canonical combination_key
      const sortedValues = resolvedValueIds
        .map(id => valueMap.get(id))
        .filter(Boolean)
        .sort((a, b) => {
          const optA = optionNameToIdMap.get(a.normalized_value) || { sort_order: 0, id: a.option_id };
          const optB = optionNameToIdMap.get(b.normalized_value) || { sort_order: 0, id: b.option_id };
          if (optA.sort_order !== optB.sort_order) return optA.sort_order - optB.sort_order;
          if (optA.id !== optB.id) return String(optA.id).localeCompare(String(optB.id));
          if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
          return String(a.id).localeCompare(String(b.id));
        });

      const derivedCombinationKey = sortedValues.map(v => v.id).join(':');
      incomingProcessedVarKeys.add(derivedCombinationKey);

      // Match existing variant by combination_key or ID
      const matchedExisting = existingVarMap.get(derivedCombinationKey) || (vPayload.id && (existingVariants || []).find(v => v.id === vPayload.id));
      const variantId = matchedExisting?.id || vPayload.id || crypto.randomUUID();

      const cleanedBarcode = vPayload.barcode ? String(vPayload.barcode).trim() : null;
      const cleanedSku = vPayload.sku ? String(vPayload.sku).trim() : null;

      const variantUpsertRow = {
        id: variantId,
        product_id: finalProductId,
        store_id: storeId,
        combination_key: derivedCombinationKey,
        title: String(vPayload.title || '').trim() || sortedValues.map(v => v.value).join(' / '),
        sku: cleanedSku || null,
        barcode: cleanedBarcode || null,
        price: (vPayload.price !== undefined && vPayload.price !== null && vPayload.price !== '') ? Number(vPayload.price) : null,
        old_price: (vPayload.old_price !== undefined && vPayload.old_price !== null && vPayload.old_price !== '') ? Number(vPayload.old_price) : null,
        cost_price: (vPayload.cost_price !== undefined && vPayload.cost_price !== null && vPayload.cost_price !== '') ? Number(vPayload.cost_price) : null,
        stock_quantity: Math.max(0, parseInt(vPayload.stock_quantity, 10) || 0),
        image: vPayload.image || '',
        is_active: vPayload.is_active !== false,
        is_archived: false,
        updated_at: new Date().toISOString()
      };

      const { error: upsertErr } = await supabase
        .from('product_variants')
        .upsert(variantUpsertRow);

      if (upsertErr) throw upsertErr;

      // Sync junction records in product_variant_option_values
      for (const valObj of sortedValues) {
        await supabase
          .from('product_variant_option_values')
          .upsert({
            variant_id: variantId,
            option_value_id: valObj.id,
            product_id: finalProductId,
            store_id: storeId
          });
      }

      // Sync store_barcode_registry atomically
      if (cleanedBarcode) {
        const normBarcode = cleanedBarcode.toLowerCase();
        await supabase
          .from('store_barcode_registry')
          .upsert({
            store_id: storeId,
            barcode: cleanedBarcode,
            normalized_barcode: normBarcode,
            entity_type: 'variant',
            entity_id: variantId,
            product_id: finalProductId
          }, { onConflict: 'store_id,normalized_barcode' });
      }
    }

    // 2c. Soft archive variants omitted from incoming payload (if they have order history) or delete if fresh
    for (const [combKey, existingVar] of existingVarMap.entries()) {
      if (!incomingProcessedVarKeys.has(combKey)) {
        // Check if variant has historical orders
        const { count: orderCount } = await supabase
          .from('order_items')
          .select('id', { count: 'exact', head: true })
          .eq('variant_id', existingVar.id);

        if (orderCount && orderCount > 0) {
          // Soft-archive to protect historical reports and invoices
          await supabase
            .from('product_variants')
            .update({ is_archived: true, is_active: false, archived_at: new Date().toISOString() })
            .eq('id', existingVar.id);
        } else {
          // Safe to remove unused variant and junctions
          await supabase
            .from('product_variant_option_values')
            .delete()
            .eq('variant_id', existingVar.id);

          await supabase
            .from('product_variants')
            .delete()
            .eq('id', existingVar.id);
        }

        // Remove from barcode registry
        if (existingVar.barcode) {
          await supabase
            .from('store_barcode_registry')
            .delete()
            .eq('store_id', storeId)
            .eq('entity_id', existingVar.id);
        }
      }
    }

    // 2d. Update cached options_summary on parent product
    await supabase
      .from('products')
      .update({ options_summary: summaryOptions })
      .eq('id', finalProductId)
      .eq('store_id', storeId);
  } else if (!hasVariants) {
    // If product is switched to has_variants = false:
    // Soft-archive any existing variants and remove their barcode reservations
    const { data: oldVariants } = await supabase
      .from('product_variants')
      .select('id, barcode')
      .eq('product_id', finalProductId)
      .eq('store_id', storeId)
      .eq('is_archived', false);

    if (oldVariants && oldVariants.length > 0) {
      await supabase
        .from('product_variants')
        .update({ is_archived: true, is_active: false, archived_at: new Date().toISOString() })
        .eq('product_id', finalProductId)
        .eq('store_id', storeId);

      const varIds = oldVariants.map(v => v.id);
      await supabase
        .from('store_barcode_registry')
        .delete()
        .eq('store_id', storeId)
        .in('entity_id', varIds);
    }

    // Sync product main barcode in registry if part_number exists
    if (savedProduct.part_number) {
      const trimmedBarcode = String(savedProduct.part_number).trim();
      if (trimmedBarcode) {
        await supabase
          .from('store_barcode_registry')
          .upsert({
            store_id: storeId,
            barcode: trimmedBarcode,
            normalized_barcode: trimmedBarcode.toLowerCase(),
            entity_type: 'product',
            entity_id: finalProductId,
            product_id: finalProductId
          }, { onConflict: 'store_id,normalized_barcode' });
      }
    }
  }

  // Refetch the authoritative product row after all triggers have executed
  const { data: refreshedProduct } = await supabase
    .from('products')
    .select('*')
    .eq('id', finalProductId)
    .eq('store_id', storeId)
    .single();

  return refreshedProduct || savedProduct;
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

  // Deactivate all variants
  await supabase
    .from('product_variants')
    .update({ is_active: false })
    .eq('product_id', productId)
    .eq('store_id', storeId);

  return data;
}

async function hardDeleteProduct(storeId, productId) {
  const { data: product, error: fetchErr } = await supabase
    .from('products')
    .select('id, image, gallery')
    .eq('id', productId)
    .eq('store_id', storeId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!product) throw new Error('Product not found or access denied');

  // Hard-Delete Guard: If product has order history, convert to soft-delete
  const { count: orderItemsCount } = await supabase
    .from('order_items')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId);

  if (orderItemsCount && orderItemsCount > 0) {
    logger.info(`[hardDeleteProduct] Product ${productId} has ${orderItemsCount} order history records. Converting to soft-delete.`);
    return await softDeleteProduct(storeId, productId);
  }

  // Delete from barcode registry
  await supabase
    .from('store_barcode_registry')
    .delete()
    .eq('product_id', productId)
    .eq('store_id', storeId);

  // Delete inventory adjustments
  await supabase.from('inventory_adjustments').delete().eq('product_id', productId);

  // Delete product (cascades variants and options)
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId)
    .eq('store_id', storeId);

  if (error) throw error;

  // Collect media keys for cleanup
  const mediaKeys = [];
  if (product?.image) mediaKeys.push(product.image);
  if (Array.isArray(product?.gallery)) {
    product.gallery.forEach((key) => {
      if (key) mediaKeys.push(key);
    });
  }

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

  // Restore non-archived variants active status
  await supabase
    .from('product_variants')
    .update({ is_active: true })
    .eq('product_id', productId)
    .eq('store_id', storeId)
    .eq('is_archived', false);

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
  getProductDetail,
  saveProduct,
  softDeleteProduct,
  hardDeleteProduct,
  restoreProduct,
  bulkUnpriceProducts
};
