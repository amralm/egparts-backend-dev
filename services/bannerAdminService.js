const { z } = require('zod');
const { supabase } = require('./supabase');

const bannerSchema = z.object({
  title: z.string().trim().max(160).optional().default(''),
  subtitle: z.string().trim().max(300).optional().default(''),
  image_url: z.string().trim().max(1000).optional().default(''),
  link_url: z.string().trim().max(500).optional().default('/catalog'),
  is_active: z.boolean().default(true),
  order_index: z.coerce.number().int().min(0).max(10000).default(0),
  overlay_opacity: z.coerce.number().int().min(0).max(100).default(40),
  blur_px: z.coerce.number().int().min(0).max(48).default(6)
});

function parseBanner(payload) {
  return bannerSchema.parse(payload || {});
}

async function listBanners(storeId) {
  const { data, error } = await supabase
    .from('banners')
    .select('*')
    .eq('store_id', storeId)
    .order('order_index', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function createBanner(storeId, payload) {
  const parsed = parseBanner(payload);
  const { data, error } = await supabase
    .from('banners')
    .insert([{ ...parsed, store_id: storeId }])
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateBanner(storeId, bannerId, payload) {
  const parsed = parseBanner(payload);
  const { data, error } = await supabase
    .from('banners')
    .update(parsed)
    .eq('id', bannerId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Banner not found');
    err.statusCode = 404;
    err.code = 'BANNER_NOT_FOUND';
    throw err;
  }
  return data;
}

async function setBannerStatus(storeId, bannerId, isActive) {
  const { data, error } = await supabase
    .from('banners')
    .update({ is_active: Boolean(isActive) })
    .eq('id', bannerId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Banner not found');
    err.statusCode = 404;
    err.code = 'BANNER_NOT_FOUND';
    throw err;
  }
  return data;
}

async function deleteBanner(storeId, bannerId) {
  const { data: banner, error: fetchError } = await supabase
    .from('banners')
    .select('id, image_url')
    .eq('id', bannerId)
    .eq('store_id', storeId)
    .maybeSingle();

  if (fetchError) throw fetchError;

  const { error } = await supabase
    .from('banners')
    .delete()
    .eq('id', bannerId)
    .eq('store_id', storeId);

  if (error) throw error;
  return { deleted: true, image_url: banner?.image_url || null };
}

module.exports = {
  listBanners,
  createBanner,
  updateBanner,
  setBannerStatus,
  deleteBanner
};
