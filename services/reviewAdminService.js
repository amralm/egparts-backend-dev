const { z } = require('zod');
const { supabase } = require('./supabase');

const statusSchema = z.enum(['pending', 'approved', 'rejected']);

async function listReviews(storeId, status = 'all') {
  let query = supabase
    .from('reviews')
    .select(`
      *,
      products ( name, image )
    `)
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });

  if (status && status !== 'all') {
    query = query.eq('status', statusSchema.parse(status));
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function updateReviewStatus(storeId, reviewId, status) {
  const parsedStatus = statusSchema.parse(status);
  const { data, error } = await supabase
    .from('reviews')
    .update({ status: parsedStatus })
    .eq('id', reviewId)
    .eq('store_id', storeId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Review not found');
    err.statusCode = 404;
    err.code = 'REVIEW_NOT_FOUND';
    throw err;
  }
  return data;
}

async function deleteReview(storeId, reviewId) {
  const { error } = await supabase
    .from('reviews')
    .delete()
    .eq('id', reviewId)
    .eq('store_id', storeId);

  if (error) throw error;
  return { deleted: true };
}

module.exports = {
  listReviews,
  updateReviewStatus,
  deleteReview
};
