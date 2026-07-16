import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { motion } from 'framer-motion';
import { useSEO } from '../hooks/useSEO';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../context/SettingsContext';
import { useStore } from '../context/StoreContext';

export default function TrackOrder() {
  const { orderId } = useParams();
  const session = useAuth();
  const { store } = useStore();
  const [order, setOrder] = useState(null);
  const [tracking, setTracking] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { settings } = useSettings();

  useSEO({
    title: `تتبع الطلب #${orderId?.split('-')[0] || ''} | ${settings?.brand_name || 'EG-PARTS'}`,
    description: 'تابع حالة طلبك خطوة بخطوة مع نظام التتبع الذكي.'
  });

  useEffect(() => {
    if (session !== undefined && orderId && store?.id) {
      if (session?.user?.id) {
        fetchTrackingData();
      } else {
        window.location.href = `/auth?redirect=${encodeURIComponent(window.location.pathname)}`;
      }
    }
  }, [session, orderId, store?.id]);

  const fetchTrackingData = async () => {
    if (!store?.id) return;
    setLoading(true);
    setError(null);
    try {
      // Authenticated users read directly from the table (allowed by RLS)
      const { data: orderData, error: orderErr } = await supabase
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .eq('store_id', store.id)
        .eq('user_id', session.user.id)
        .single();

      if (orderErr || !orderData) {
        setError('عذراً، لم نتمكن من العثور على هذا الطلب. يرجى التأكد من الرقم الصحيح.');
        setLoading(false);
        return;
      }

      setOrder(orderData);

      // Fetch tracking history
      const { data: trackingData, error: trackErr } = await supabase
        .from('order_tracking')
        .select('*')
        .eq('order_id', orderId)
        .order('created_at', { ascending: true });

      if (!trackErr) {
        setTracking(trackingData);
      }
    } catch (err) {
      setError('حدث خطأ أثناء تحميل البيانات.');
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'awaiting_confirmation': return 'pending_actions';
      case 'pending': return 'hourglass_empty';
      case 'confirmed': return 'check_circle';
      case 'processing': return 'inventory_2';
      case 'shipped': return 'local_shipping';
      case 'delivered': return 'verified';
      case 'cancelled': return 'cancel';
      default: return 'radio_button_checked';
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'awaiting_confirmation': return 'بانتظار التأكيد';
      case 'pending': return 'قيد المراجعة';
      case 'confirmed': return 'تم التأكيد ✅';
      case 'processing': return 'جاري التجهيز';
      case 'shipped': return 'تم الشحن';
      case 'delivered': return 'تم التسليم';
      case 'cancelled': return 'ملغي';
      default: return status;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" dir="rtl">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          <p className="text-on-surface-variant font-bold">جاري تتبع طلبك...</p>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6" dir="rtl">
        <div className="glass-panel p-8 rounded-3xl text-center max-w-md w-full border border-error/20">
          <span className="material-symbols-outlined text-[60px] text-error mb-4">error_outline</span>
          <h2 className="text-2xl font-bold text-on-surface mb-4">{error || 'حدث خطأ في تحميل الطلب.'}</h2>
          <Link to="/orders" className="bg-primary text-on-primary px-8 py-3 rounded-xl font-bold hover:bg-primary-fixed inline-block transition-all">
            الذهاب لطلباتي
          </Link>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen pb-20 px-6 max-w-4xl mx-auto pt-10" dir="rtl">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-8"
      >
        {/* Header Card */}
        <div className="glass-panel p-8 rounded-3xl border border-white/10 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-[60px] rounded-full"></div>
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10">
            <div>
              <p className="text-on-surface-variant text-sm font-bold mb-2">رقم الطلب:</p>
              <h1 className="text-3xl font-black text-on-surface font-mono uppercase tracking-tighter">
                {order.order_number ? `EG-${order.order_number}` : `#${order.id.split('-')[0]}`}
              </h1>
              <p className="text-on-surface-variant text-xs mt-2">تاريخ الطلب: {new Date(order.created_at).toLocaleDateString('ar-EG')}</p>
            </div>
            <div className="bg-surface-container-highest px-6 py-3 rounded-2xl border border-white/10">
              <p className="text-on-surface-variant text-xs mb-1">الحالة الحالية:</p>
              <p className="text-primary font-black text-lg flex items-center gap-2">
                <span className="material-symbols-outlined">{getStatusIcon(order.status)}</span>
                {getStatusLabel(order.status)}
              </p>
            </div>
          </div>
        </div>

        {/* Timeline Section */}
        <div className="glass-panel p-8 rounded-3xl border border-white/10">
          <h2 className="text-xl font-bold text-on-surface mb-10 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">timeline</span>
            تطورات حالة الطلب
          </h2>

          <div className="relative">
            {/* Vertical Line */}
            <div className="absolute top-0 bottom-0 right-4 w-0.5 bg-white/10 md:right-8"></div>

            <div className="space-y-12 relative">
              {tracking.length === 0 ? (
                <div className="flex gap-6 items-start relative pr-12 md:pr-16">
                  <div className="absolute right-2 md:right-6 w-5 h-5 bg-primary rounded-full border-4 border-background z-10"></div>
                  <div>
                    <h3 className="text-on-surface font-bold text-lg">تم تسجيل الطلب</h3>
                    <p className="text-on-surface-variant text-sm mt-1">طلبك الآن في مرحلة المراجعة وسنقوم بتحديث الحالة قريباً.</p>
                    <p className="text-primary text-[10px] mt-2 font-bold">{new Date(order.created_at).toLocaleString('ar-EG')}</p>
                  </div>
                </div>
              ) : (
                tracking.map((step, idx) => (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.1 }}
                    className="flex gap-6 items-start relative pr-12 md:pr-16"
                  >
                    {/* Step Node */}
                    <div className={`absolute right-2 md:right-6 w-5 h-5 rounded-full border-4 border-background z-10 ${
                      idx === tracking.length - 1 ? 'bg-primary shadow-[0_0_15px_rgba(255,153,0,0.5)]' : 'bg-surface-container-high'
                    }`}></div>
                    
                    <div>
                      <h3 className={`font-bold text-lg ${idx === tracking.length - 1 ? 'text-primary' : 'text-on-surface-variant'}`}>
                        {getStatusLabel(step.status)}
                      </h3>
                      {step.note && (
                        <p className="text-on-surface-variant text-sm mt-1 bg-white/5 p-3 rounded-xl border border-white/5 italic">
                          "{step.note}"
                        </p>
                      )}
                      <p className="text-on-surface-variant text-[10px] mt-2 font-bold flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">schedule</span>
                        {new Date(step.created_at).toLocaleString('ar-EG')}
                      </p>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Help / Footer */}
        <div className="text-center space-y-4">
          <p className="text-on-surface-variant text-sm">
            هل لديك استفسار بخصوص هذا الطلب؟ 
          </p>
          <div className="flex justify-center gap-4">
            <a 
              href={`https://wa.me/${settings?.whatsapp_number || '201122551272'}?text=${encodeURIComponent(`استفسار عن طلب رقم #${order.id}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-[#25D366] font-bold hover:underline"
            >
              <span className="material-symbols-outlined">chat</span>
              تواصل معنا عبر واتساب
            </a>
            <Link to="/orders" className="text-on-surface-variant hover:text-white transition-all flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">receipt_long</span>
              سجل الطلبات
            </Link>
          </div>
        </div>
      </motion.div>
    </main>
  );
}
