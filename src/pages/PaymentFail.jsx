import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useSEO } from '../hooks/useSEO';

export default function PaymentFail() {
  const navigate = useNavigate();

  useSEO({ title: 'فشل الدفع | EG-PARTS', description: 'حدث خطأ أثناء عملية الدفع.' });

  return (
    <main className="min-h-screen flex items-center justify-center px-6" dir="rtl">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', damping: 20, stiffness: 200 }}
        className="glass-panel rounded-3xl p-12 max-w-md w-full text-center"
      >
        {/* Icon */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2, type: 'spring', damping: 15 }}
          className="w-28 h-28 rounded-full bg-red-500/20 border-2 border-red-500 flex items-center justify-center mx-auto mb-8"
        >
          <span className="material-symbols-outlined text-red-500 text-[60px]">cancel</span>
        </motion.div>

        <h1 className="text-3xl font-black text-on-surface mb-4">لم يتم الدفع ❌</h1>

        <p className="text-on-surface-variant text-lg mb-8">
          حدث خطأ أثناء عملية الدفع. لا توجد رسوم على حسابك. يرجى المحاولة مرة أخرى.
        </p>

        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 mb-8 text-right">
          <p className="text-red-400 font-bold text-sm">💡 أسباب شائعة للفشل:</p>
          <ul className="text-on-surface-variant text-sm mt-2 space-y-1">
            <li>• رصيد غير كافٍ في البطاقة</li>
            <li>• بيانات البطاقة غير صحيحة</li>
            <li>• انتهت صلاحية الجلسة (حاول مجدداً)</li>
          </ul>
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={() => navigate(-1)}
            className="w-full bg-gradient-to-r from-red-600 to-rose-600 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 hover:-translate-y-1 transition-all shadow-[0_10px_30px_rgba(239,68,68,0.3)]"
          >
            <span className="material-symbols-outlined">refresh</span>
            إعادة المحاولة
          </button>
          <button
            onClick={() => navigate('/account')}
            className="w-full border border-white/10 text-on-surface-variant font-bold py-3 rounded-2xl flex items-center justify-center gap-2 hover:border-primary/50 transition-all"
          >
            <span className="material-symbols-outlined">receipt_long</span>
            عرض طلباتي
          </button>
          <button
            onClick={() => navigate('/support')}
            className="text-on-surface-variant/60 text-sm hover:text-primary transition-colors mt-2"
          >
            تحتاج مساعدة؟ تواصل مع الدعم
          </button>
        </div>
      </motion.div>
    </main>
  );
}
