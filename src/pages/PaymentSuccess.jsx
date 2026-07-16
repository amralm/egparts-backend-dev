import { useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useSEO } from '../hooks/useSEO';
import { useEffect, useState } from 'react';

import { useSettings } from '../context/SettingsContext';

export default function PaymentSuccess() {
  const [searchParams] = useSearchParams();
  const [countdown, setCountdown] = useState(3);
  const { settings } = useSettings();
  const method = searchParams.get('method');
  const orderId = searchParams.get('orderId');
  const isCOD = method === 'cod';
  const isManual = method === 'manual';

  useSEO({ title: `تم الطلب بنجاح | ${settings?.brand_name || 'EG-PARTS'}`, description: 'تم استلام طلبك بنجاح.' });

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          window.location.href = getWhatsAppLink();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [orderId]);

  const getWhatsAppLink = () => {
    // Order confirmation number (admin-configurable); falls back to the
    // generic whatsapp_number, then to a sane default.
    const adminPhone = (settings?.order_confirmation_number || settings?.whatsapp_number || '201122551272').replace(/[^\d]/g, '');
    const msg = `طلب تأكيد شراء جديد
رقم الطلب: #${orderId || 'غير معروف'}
الحالة: مسجل (قيد الانتظار)
طريقة الدفع: ${isCOD ? 'الدفع عند الاستلام' : 'تحويل بنكي/محفظة'}

برجاء تأكيد استلام ومراجعة هذا الطلب للبدء في التجهيز.`;
    return `https://wa.me/${adminPhone}?text=${encodeURIComponent(msg)}`;
  };

  // Admin-configurable numbers for the manual (transfer) payment flow
  const vodafoneCashNumber = settings?.vodafone_cash_number || '01011192994';
  const screenshotNumber = (settings?.payment_screenshot_number || settings?.order_confirmation_number || settings?.whatsapp_number || '201122551272').replace(/[^\d]/g, '');

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12" dir="rtl">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', damping: 20, stiffness: 200 }}
        className="glass-panel rounded-3xl p-8 md:p-12 max-w-xl w-full text-center"
      >
        {/* Icon */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2, type: 'spring', damping: 15 }}
          className="w-24 h-24 rounded-full bg-green-500/20 border-2 border-green-500 flex items-center justify-center mx-auto mb-6"
        >
          <span className="material-symbols-outlined text-green-500 text-[50px]">check_circle</span>
        </motion.div>

        <h1 className="text-3xl font-black text-on-surface mb-4">
          تم استلام طلبك بنجاح! 🎉
        </h1>

        <p className="text-on-surface-variant text-lg mb-6">
          رقم الطلب الخاص بك هو <span className="text-primary font-bold">#{orderId || '------'}</span>
        </p>

        {/* Action Required Alert */}
        <div className="bg-orange-500/10 border border-orange-500/30 rounded-2xl p-6 mb-8 text-right">
          <p className="text-orange-400 font-bold flex items-center gap-2 mb-2">
            <span className="material-symbols-outlined">warning</span>
            تنبيه هام جداً:
          </p>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              لقد تم تسجيل طلبك في وضع "الانتظار". <span className="text-orange-600 dark:text-white font-bold">سيتم حذف الطلب تلقائياً خلال 24 ساعة</span> إذا لم تقم بالضغط على الزر أدناه وتأكيد الطلب عبر رسالة واتساب.
            </p>
          
          <div className="mt-4 text-center">
            <p className="text-xs text-on-surface-variant mb-2">جاري تحويلك تلقائياً خلال {countdown} ثانية...</p>
            <a
              href={getWhatsAppLink()}
              className="w-full bg-[#25D366] text-white font-bold py-4 rounded-xl flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-green-500/20"
            >
              <span className="material-symbols-outlined">chat</span>
              تأكيد عبر واتساب الآن
            </a>
          </div>
        </div>

        {isManual && (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-5 mb-8 text-right">
            <p className="text-blue-400 font-bold mb-2">💳 تعليمات التحويل:</p>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              يرجى تحويل المبلغ إلى رقم فودافون كاش الموضح أدناه، ثم التقط لقطة (Screenshot) لتأكيد التحويل وأرسلها إلى الرقم التالي:
            </p>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-white/5 dark:bg-black/20 border border-white/10 rounded-xl p-3 flex items-center gap-3">
                <span className="material-symbols-outlined text-blue-400">account_balance_wallet</span>
                <div>
                  <p className="text-[11px] text-on-surface-variant">رقم فودافون كاش</p>
                  <p className="text-orange-600 dark:text-white font-black font-mono" dir="ltr">{vodafoneCashNumber}</p>
                </div>
              </div>
              <a
                href={`https://wa.me/${screenshotNumber}?text=${encodeURIComponent(`مرحباً، هذه صورة تأكيد التحويل للطلب رقم #${orderId || 'غير معروف'}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-[#25D366]/10 hover:bg-[#25D366]/20 border border-[#25D366]/30 rounded-xl p-3 flex items-center gap-3 transition-all"
              >
                <span className="material-symbols-outlined text-[#25D366]">photo_camera</span>
                <div>
                  <p className="text-[11px] text-on-surface-variant">إرسال صورة التحويل إلى</p>
                  <p className="text-[#25D366] font-black font-mono" dir="ltr">{screenshotNumber}</p>
                </div>
              </a>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link
            to="/account"
            className="bg-white/5 text-on-surface font-bold py-4 rounded-2xl flex items-center justify-center gap-2 hover:bg-white/10 transition-all border border-white/5"
          >
            <span className="material-symbols-outlined">receipt_long</span>
            عرض طلباتي
          </Link>
          <Link
            to="/catalog"
            className="border border-primary/30 text-primary font-bold py-4 rounded-2xl flex items-center justify-center gap-2 hover:bg-primary/5 transition-all"
          >
            <span className="material-symbols-outlined">store</span>
            متابعة التسوق
          </Link>
        </div>
      </motion.div>
    </main>
  );
}

