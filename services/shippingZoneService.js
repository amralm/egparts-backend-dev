const { z } = require('zod');
const { supabase } = require('./supabase');

const zoneSchema = z.object({
  city_name: z.string().trim().min(2).max(120),
  shipping_fee: z.coerce.number().min(0).max(100000)
});

function parseZone(payload) {
  return zoneSchema.parse(payload || {});
}

async function listZones(storeId) {
  const { data, error } = await supabase
    .from('shipping_zones')
    .select('*')
    .eq('store_id', storeId)
    .order('city_name', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function createZone(storeId, payload) {
  const parsed = parseZone(payload);
  const { data, error } = await supabase
    .from('shipping_zones')
    .insert([{ ...parsed, store_id: storeId }])
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateZone(storeId, zoneId, payload) {
  const parsed = parseZone(payload);
  const { data, error } = await supabase
    .from('shipping_zones')
    .update(parsed)
    .eq('id', zoneId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Shipping zone not found');
    err.statusCode = 404;
    err.code = 'SHIPPING_ZONE_NOT_FOUND';
    throw err;
  }
  return data;
}

async function deleteZone(storeId, zoneId) {
  const { error } = await supabase
    .from('shipping_zones')
    .delete()
    .eq('id', zoneId)
    .eq('store_id', storeId);

  if (error) throw error;
  return { deleted: true };
}

module.exports = {
  listZones,
  createZone,
  updateZone,
  deleteZone
};
