import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useSEO } from '../hooks/useSEO';
import { supabase } from '../lib/supabase';
import { useStore } from '../context/StoreContext';

export default function EmailVerified() {
  const navigate = useNavigate();
  const location = useLocation();
  const { store } = useStore();
  const [countdown, setCountdown] = useState(3);
  const [error, setError] = useState(false);

  useSEO({
    title: 'تم التحقق من الحساب | EG-PARTS',
    description: 'تم التحقق من بريدك الإلكتروني بنجاح، جاري تحويلك...'
  });

  useEffect(() => {
    // Check if we have a hash or access_token in URL (Supabase confirms via hash)
    const hasToken = window.location.hash || location.search.includes('code');
    
    if (!hasToken) {
      setError(true);
      return;
    }

    const updateVerificationStatus = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user && store?.id) {
        await supabase
          .from('user_profiles')
          .update({ is_email_verified: true })
          .eq('user_id', session.user.id)
          .eq('store_id', store.id);
      }
    };

    updateVerificationStatus();

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          navigate('/auth');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [navigate, location]);

  if (error) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center px-4" dir="rtl">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-surface-container-high p-10 rounded-[2.5rem] border border-on-surface/5 shadow-2xl max-w-md w-full text-center"
        >
          <div className="w-20 h-20 bg-error/10 text-error rounded-full flex items-center justify-center mx-auto mb-6">
            <span className="material-symbols-outlined text-[48px]">error</span>
          </div>
          <h1 className="text-2xl font-black text-on-surface mb-4">الرابط غير صالح</h1>
          <p className="text-on-surface-variant mb-8">عذراً، هذا الرابط غير صالح أو انتهت صلاحيته. يرجى محاولة التسجيل مرة أخرى أو طلب رابط جديد.</p>
          <button 
            onClick={() => navigate('/auth')}
            className="w-full bg-primary hover:bg-red-700 text-white font-black py-4 rounded-xl transition-all shadow-lg"
          >
            العودة لتسجيل الدخول
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4" dir="rtl">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-surface-container-high p-10 rounded-[3rem] border border-on-surface/5 shadow-2xl max-w-md w-full text-center relative overflow-hidden"
      >
        {/* Glow Effect */}
        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-[60px] rounded-full"></div>
        
        <div className="relative z-10">
          <div className="w-24 h-24 bg-green-500/10 text-green-500 rounded-full flex items-center justify-center mx-auto mb-8 animate-bounce">
            <span className="material-symbols-outlined text-[56px]">verified</span>
          </div>
          
          <h1 className="text-3xl font-black text-on-surface mb-4 tracking-tight">تم التحقق بنجاح!</h1>
          <p className="text-on-surface-variant text-lg font-medium mb-10 leading-relaxed">
            لقد تم تفعيل بريدك الإلكتروني بنجاح. يمكنك الآن الاستمتاع بكافة مميزات المتجر.
          </p>

          <div className="space-y-6">
            <div className="flex flex-col items-center gap-4">
              <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 3, ease: "linear" }}
                  className="h-full bg-primary shadow-[0_0_10px_#dc2626]"
                />
              </div>
              <p className="text-sm text-on-surface-variant font-bold">
                سيتم تحويلك تلقائياً خلال <span className="text-primary">{countdown}</span> ثوانٍ...
              </p>
            </div>

            <button 
              onClick={() => navigate('/auth')}
              className="w-full bg-white/5 hover:bg-white/10 text-white font-bold py-4 rounded-xl border border-white/5 transition-all"
            >
              انتقل الآن
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
