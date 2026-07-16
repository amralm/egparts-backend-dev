import { motion } from 'framer-motion';
import { supabase } from '../lib/supabase';
import { useSettings } from '../context/SettingsContext';

export default function BannedScreen({ reason }) {
  const { settings } = useSettings();
  const supportNumber = (settings?.whatsapp_number || '201122551272').replace(/[^\d]/g, '');

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-[#0A0E13] flex items-center justify-center p-6 text-center" dir="rtl">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-error/10 rounded-full blur-[120px]"></div>
      </div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-xl w-full bg-surface-container-low border border-error/20 rounded-[3rem] p-12 shadow-3xl relative z-10 backdrop-blur-xl"
      >
        <div className="w-24 h-24 bg-error/20 text-error rounded-full flex items-center justify-center mx-auto mb-8 animate-bounce">
          <span className="material-symbols-outlined text-[48px]">gpp_maybe</span>
        </div>

        <h1 className="text-4xl font-black text-on-surface mb-4">عذراً، حسابك موقوف 🛑</h1>
        <p className="text-on-surface-variant text-lg mb-8 leading-relaxed">
          لقد تمت مراجعة نشاط حسابك وتبين وجود مخالفات لشروط ومعايير متجرنا. نتيجة لذلك، تم تعليق وصولك للخدمات.
        </p>

        <div className="bg-error/5 border border-error/10 rounded-2xl p-6 mb-10 text-right">
          <p className="text-xs font-black text-error uppercase tracking-widest mb-2">سبب الإيقاف الإداري:</p>
          <p className="text-white font-medium italic">"{reason || 'مخالفة شروط وسياسة المتجر العامة.'}"</p>
        </div>

        <div className="space-y-4">
          <a
            href={`https://wa.me/${supportNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-white text-black py-5 rounded-2xl font-black text-lg hover:bg-white/90 transition-all shadow-xl"
          >
            تقديم التماس عبر واتساب
          </a>
          <button 
            onClick={handleLogout}
            className="w-full bg-white/5 text-white py-5 rounded-2xl font-bold hover:bg-white/10 transition-all border border-white/10"
          >
            تسجيل الخروج
          </button>
        </div>

        <p className="mt-8 text-xs text-on-surface-variant opacity-50">
          إذا كنت تعتقد أن هذا الإجراء تم عن طريق الخطأ، يرجى التواصل مع الدعم الفني.
        </p>
      </motion.div>
    </div>
  );
}
