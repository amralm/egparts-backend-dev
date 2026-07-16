import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../context/StoreContext';

export default function ManageReviews() {
  const { store } = useStore();
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');

  useEffect(() => {
    if (store?.id) {
      fetchReviews();
    }
  }, [filter, store?.id]);

  async function fetchReviews() {
    if (!store?.id) return;
    setLoading(true);
    let query = supabase
      .from('reviews')
      .select(`
        *,
        products (name)
      `)
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });

    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data } = await query;
    if (data) setReviews(data);
    setLoading(false);
  }

  const updateStatus = async (id, status) => {
    if (!store?.id) return;
    const { error } = await supabase
      .from('reviews')
      .update({ status })
      .eq('id', id)
      .eq('store_id', store.id);
    
    if (!error) {
      setReviews(reviews.filter(r => r.id !== id));
    }
  };

  const deleteReview = async (id) => {
    if (!store?.id) return;
    if (!confirm('هل أنت متأكد من حذف هذا التقييم نهائياً؟')) return;
    const { error } = await supabase
      .from('reviews')
      .delete()
      .eq('id', id)
      .eq('store_id', store.id);
    
    if (!error) {
      setReviews(reviews.filter(r => r.id !== id));
    }
  };

  return (
    <div className="space-y-8" dir="rtl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-white">إدارة التقييمات 🌟</h1>
          <p className="text-on-surface-variant">راجع تعليقات العملاء وقم بالموافقة على نشرها.</p>
        </div>
        <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
          {['pending', 'approved', 'all'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-6 py-2 rounded-lg font-bold text-sm transition-all ${filter === f ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-white'}`}
            >
              {f === 'pending' ? 'بانتظار المراجعة' : f === 'approved' ? 'المنشورة' : 'الكل'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : reviews.length === 0 ? (
        <div className="bg-white/5 border border-dashed border-white/10 rounded-3xl p-20 text-center">
          <p className="text-on-surface-variant">لا توجد تقييمات في هذا القسم.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          <AnimatePresence>
            {reviews.map((review) => (
              <motion.div
                key={review.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-white/[0.03] border border-white/10 rounded-3xl p-6 flex flex-col md:flex-row justify-between gap-6"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="flex text-amber-500">
                      {[...Array(5)].map((_, i) => (
                        <span key={i} className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: i < review.rating ? "'FILL' 1" : "'FILL' 0" }}>star</span>
                      ))}
                    </div>
                    <span className="text-xs text-on-surface-variant font-bold">{new Date(review.created_at).toLocaleDateString('ar-EG')}</span>
                  </div>
                  <h3 className="text-white font-bold text-lg mb-1">{review.user_name}</h3>
                  <p className="text-primary text-xs font-bold mb-4">على منتج: {review.products?.name}</p>
                  <p className="text-on-surface-variant leading-relaxed bg-black/20 p-4 rounded-xl italic">
                    "{review.comment}"
                  </p>
                </div>

                <div className="flex md:flex-col gap-2 justify-end">
                  {review.status === 'pending' && (
                    <button 
                      onClick={() => updateStatus(review.id, 'approved')}
                      className="bg-green-500/20 text-green-500 border border-green-500/30 px-6 py-2.5 rounded-xl font-bold hover:bg-green-500 hover:text-white transition-all flex items-center gap-2"
                    >
                      <span className="material-symbols-outlined text-[18px]">check</span> موافقة
                    </button>
                  )}
                  <button 
                    onClick={() => deleteReview(review.id)}
                    className="bg-red-500/10 text-red-400 border border-red-500/20 px-6 py-2.5 rounded-xl font-bold hover:bg-red-500 hover:text-white transition-all flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span> حذف
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
