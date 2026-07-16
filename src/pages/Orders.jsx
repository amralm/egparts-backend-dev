import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useStore } from '../context/StoreContext';

export default function Orders() {
  const { store } = useStore();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [authDone, setAuthDone] = useState(false);
  const session = useAuth();

  useEffect(() => {
    if (session === undefined || !store?.id) return;
    setAuthDone(true);
    if (session?.user) {
      fetchRequests(session.user.id);
    } else {
      setLoading(false);
    }
  }, [session, store?.id]);

  const fetchRequests = async (userId) => {
    if (!store?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });
    
    if (data) setRequests(data);
    setLoading(false);
  };

  if (!session?.user && authDone) {
    return (
    <main className="pb-[100px] px-6 max-w-[1200px] mx-auto min-h-screen text-center">
        <div className="mt-20">
          <span className="material-symbols-outlined text-[60px] text-primary mb-4 block">lock</span>
          <h2 className="font-headline-lg text-on-surface mb-4">يرجى تسجيل الدخول أولاً</h2>
          <Link to="/auth" className="bg-primary text-white px-8 py-3 rounded-xl font-bold hover:bg-red-700 inline-block shadow-lg shadow-primary/20">
            تسجيل الدخول
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="pb-[100px] px-6 max-w-[1200px] mx-auto min-h-screen" dir="rtl">
      <h1 className="font-headline-lg text-headline-lg text-on-surface mb-8">سجل طلباتي</h1>
      
      {loading ? (
        <div className="text-center text-primary mt-20">جاري تحميل الطلبات...</div>
      ) : requests.length === 0 ? (
        <div className="text-center text-on-surface-variant mt-20 font-body-lg">
          <span className="material-symbols-outlined text-[60px] text-surface-dim mb-4 block">receipt_long</span>
          لا توجد طلبات سابقة.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {requests.map((req) => (
            <div key={req.id} className="bg-surface border border-on-surface/5 p-6 rounded-2xl flex flex-col gap-4 shadow-sm hover:border-primary/20 transition-all">
               <div className="flex justify-between items-center border-b border-white/5 pb-4">
                 <div>
                   <span className="text-xs text-on-surface-variant font-mono bg-black/40 px-2 py-1 rounded">{req.order_number ? `EG-${req.order_number}` : `#${req.id.split('-')[0]}`}</span>
                   <p className="text-sm text-secondary-fixed-dim mt-2">
                     <span className="material-symbols-outlined text-[16px] align-middle me-1">calendar_today</span>
                     {new Date(req.created_at).toLocaleString('ar-EG')}
                   </p>
                 </div>
                 <div className="flex items-center gap-2 flex-wrap justify-end">
                   {/* Payment Method Badge */}
                   <span className="px-2 py-1 rounded bg-surface-variant text-on-surface-variant text-[10px] font-bold flex items-center gap-1">
                     <span className="material-symbols-outlined text-[12px]">{req.payment_method === 'card' ? 'credit_card' : 'payments'}</span>
                     {req.payment_method === 'card' ? 'دفع إلكتروني' : 'عند الاستلام'}
                   </span>
                    {/* Payment Status Badge */}
                    {req.payment_method === 'card' && (
                      <span className={`px-2 py-1 rounded text-[10px] font-bold ${
                        req.payment_status === 'paid' ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'
                      }`}>
                        {req.payment_status === 'paid' ? 'تم الدفع' : 'بانتظار الدفع'}
                      </span>
                    )}
                    {/* Order Status Badge */}
                    <span className={`px-3 py-1 rounded-full text-xs font-bold border ${
                      req.status === 'delivered' ? 'bg-green-500/10 text-green-600 border-green-500/20' : 
                      req.status === 'confirmed' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' :
                      req.status === 'processing' ? 'bg-blue-500/10 text-blue-600 border-blue-500/20' :
                      req.status === 'shipped' ? 'bg-purple-500/10 text-purple-600 border-purple-500/20' :
                      req.status === 'cancelled' ? 'bg-error/10 text-error border-error/20' :
                      'bg-yellow-500/10 text-yellow-600 border-yellow-500/20'
                    }`}>
                      {req.status === 'delivered' ? 'تم التسليم' : 
                       req.status === 'confirmed' ? 'تم التأكيد' :
                       req.status === 'processing' ? 'جاري التجهيز' :
                       req.status === 'shipped' ? 'تم الشحن' :
                       req.status === 'cancelled' ? 'ملغي' : 'قيد المراجعة'}
                    </span>
                 </div>
               </div>
               
               <div className="grid md:grid-cols-2 gap-6">
                 <div>
                    <h4 className="text-sm font-bold text-on-surface-variant mb-3">المنتجات:</h4>
                    <ul className="space-y-2">
                      {(req.items || []).map((item, i) => (
                        <li key={i} className="flex justify-between items-center text-sm bg-surface-container p-2 rounded">
                           <Link to={`/product/${item.id || item.productId || '#'}`} className="text-primary hover:underline transition-colors line-clamp-1 flex-1 text-right">
                             {item.title || item.name || 'منتج'}
                           </Link> 
                           <span className="font-bold ms-4 text-on-surface">x{item.qty || 1}</span>
                        </li>
                      ))}
                      {(!req.items || req.items.length === 0) && (
                        <li className="text-on-surface-variant text-sm">لم يتم تسجيل المنتجات</li>
                      )}
                    </ul>
                 </div>
                 
                 <div className="bg-surface-container/50 p-4 rounded-lg border border-outline-variant space-y-2 text-sm">
                    <div className="flex justify-between text-on-surface-variant">
                      <span>المجموع الفرعي:</span>
                      <span dir="ltr">EGP {req.subtotal ?? (req.items || []).reduce((acc, i) => acc + (i.price * (i.qty || 1)), 0)}</span>
                    </div>
                   {req.discount > 0 && (
                     <div className="flex justify-between text-[#25D366] font-bold">
                       <span>الخصم:</span>
                       <span dir="ltr">- EGP {req.discount}</span>
                     </div>
                   )}
                   {req.shipping_fee > 0 && (
                     <div className="flex justify-between text-on-surface-variant">
                       <span>مصاريف الشحن:</span>
                       <span dir="ltr">EGP {req.shipping_fee}</span>
                     </div>
                   )}
                    <div className="flex justify-between font-bold text-on-surface pt-2 border-t border-on-surface/10 mt-2">
                      <span>الإجمالي:</span>
                       <span className="text-primary" dir="ltr">
                          EGP {req.total ?? (
                            (req.items || []).reduce((acc, i) => acc + (i.price * (i.qty || 1)), 0) - (req.discount || 0) + (req.shipping_fee || 0)
                          )}
                        </span>
                    </div>
                 </div>
               </div>

                <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-4 pt-4 border-t border-outline-variant">
                  <Link 
                    to={`/track-order/${req.id}`}
                    className="flex items-center gap-2 text-primary font-bold hover:underline text-sm"
                  >
                    <span className="material-symbols-outlined text-[18px]">timeline</span>
                    تتبع حالة الطلب بالتفصيل
                  </Link>

                  {req.status === 'awaiting_confirmation' && (
                    <p className="text-xs text-red-600 bg-red-500/10 px-3 py-2 rounded flex items-center gap-2 font-bold">
                       <span className="material-symbols-outlined text-[16px]">warning</span>
                       بانتظار تأكيدك عبر واتساب
                    </p>
                  )}
                </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
