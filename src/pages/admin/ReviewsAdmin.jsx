import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useStore } from '../../context/StoreContext';

export default function ReviewsAdmin() {
  const { store } = useStore();
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState('');

  useEffect(() => {
    if (store?.id) {
      fetchReviews();
    }
  }, [store?.id]);

  async function fetchReviews() {
    if (!store?.id) return;
    setLoading(true);
    // Fetch all reviews with product info
    const { data, error } = await supabase
      .from('reviews')
      .select(`
        *,
        products ( name, image )
      `)
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });

    if (data) {
      setReviews(data);
    } else if (error) {
      showToast('خطأ في جلب التقييمات');
    }
    setLoading(false);
  }

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(''), 3000);
  };

  const updateStatus = async (id, status) => {
    if (!store?.id) return;
    const { error } = await supabase
      .from('reviews')
      .update({ status })
      .eq('id', id)
      .eq('store_id', store.id);

    if (!error) {
      setReviews(prev => prev.map(r => r.id === id ? { ...r, status } : r));
      showToast(`تم ${status === 'approved' ? 'قبول' : 'رفض'} التقييم بنجاح`);
    } else {
      showToast('حدث خطأ');
    }
  };

  const deleteReview = async (id) => {
    if (!store?.id) return;
    if (!confirm('هل أنت متأكد من حذف هذا التقييم نهائياً؟')) return;
    const { error } = await supabase.from('reviews').delete().eq('id', id).eq('store_id', store.id);
    if (!error) {
      setReviews(prev => prev.filter(r => r.id !== id));
      showToast('تم الحذف بنجاح');
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-green-500 text-white px-6 py-3 rounded-lg shadow-[0_0_20px_rgba(34,197,94,0.5)] animate-fade-in flex items-center gap-2">
          <span className="material-symbols-outlined">check_circle</span>
          {toastMessage}
        </div>
      )}

      <div>
        <h2 className="font-headline-lg text-2xl font-bold text-white">إدارة التقييمات</h2>
        <p className="text-on-surface-variant mt-1 text-sm">راجع تقييمات العملاء ووافق عليها لتظهر في الموقع.</p>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <span className="material-symbols-outlined animate-spin text-4xl text-primary">progress_activity</span>
        </div>
      ) : (
        <div className="grid gap-4">
          {reviews.length === 0 ? (
            <div className="text-center py-12 bg-surface-container/30 border border-white/5 rounded-xl text-on-surface-variant">
              <span className="material-symbols-outlined text-5xl mb-2 opacity-50 block">rate_review</span>
              لا توجد تقييمات حتى الآن
            </div>
          ) : (
            reviews.map(rev => (
              <div key={rev.id} className={`glass-panel p-6 rounded-xl border flex flex-col md:flex-row gap-6 justify-between items-start transition-colors ${rev.status === 'pending' ? 'border-yellow-500/50 bg-yellow-500/5' : rev.status === 'approved' ? 'border-green-500/30' : 'border-error/30'}`}>
                
                {/* Product Info & Rating */}
                <div className="flex gap-4 items-center w-full md:w-1/3">
                  <div className="w-16 h-16 rounded-lg bg-surface-container overflow-hidden shrink-0">
                    {rev.products?.image ? (
                      <img src={rev.products.image} alt={rev.products.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-white/5">
                        <span className="material-symbols-outlined text-surface-variant text-2xl">image</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <h4 className="font-bold text-white text-sm line-clamp-1">{rev.products?.name}</h4>
                    <div className="flex text-primary mt-1 text-sm">
                      {[...Array(5)].map((_, i) => (
                        <span key={i} className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: i < rev.rating ? "'FILL' 1" : "'FILL' 0" }}>star</span>
                      ))}
                    </div>
                    <span className="text-[10px] text-on-surface-variant mt-1 block">{new Date(rev.created_at).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Review Content */}
                <div className="flex-1 bg-black/20 p-4 rounded-lg w-full border border-white/5">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-bold text-primary flex items-center gap-1 text-sm">
                      <span className="material-symbols-outlined text-[16px]">person</span>
                      {rev.user_name}
                    </span>
                    {rev.status === 'pending' && <span className="bg-yellow-500/20 text-yellow-400 text-[10px] px-2 py-0.5 rounded font-bold">بانتظار المراجعة</span>}
                    {rev.status === 'approved' && <span className="bg-green-500/20 text-green-400 text-[10px] px-2 py-0.5 rounded font-bold">مقبول</span>}
                    {rev.status === 'rejected' && <span className="bg-error/20 text-error text-[10px] px-2 py-0.5 rounded font-bold">مرفوض</span>}
                  </div>
                  <p className="text-sm text-on-surface leading-relaxed">{rev.comment}</p>
                </div>

                {/* Actions */}
                <div className="flex md:flex-col gap-2 w-full md:w-auto">
                  {rev.status !== 'approved' && (
                    <button onClick={() => updateStatus(rev.id, 'approved')} className="flex-1 bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 px-4 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-1 transition-colors">
                      <span className="material-symbols-outlined text-[18px]">check_circle</span> قبول
                    </button>
                  )}
                  {rev.status !== 'rejected' && (
                    <button onClick={() => updateStatus(rev.id, 'rejected')} className="flex-1 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/20 px-4 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-1 transition-colors">
                      <span className="material-symbols-outlined text-[18px]">cancel</span> رفض
                    </button>
                  )}
                  <button onClick={() => deleteReview(rev.id)} className="flex-1 bg-error/10 hover:bg-error/20 text-error border border-error/20 px-4 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-1 transition-colors">
                    <span className="material-symbols-outlined text-[18px]">delete</span> حذف
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
