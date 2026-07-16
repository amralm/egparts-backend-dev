import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';

export default function OrderModal({ isOpen, onClose, onSubmit, item }) {
  const session = useAuth();
  
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session && isOpen) {
      const userPhone = session.user?.user_metadata?.phone || '';
      if (userPhone && !phone) {
        setPhone(userPhone);
      }
    }
  }, [session, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!phone) return;
    
    setLoading(true);
    try {
      await onSubmit({ phone, note, item });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" dir="rtl">
      <div className="bg-surface-container border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xl font-bold text-on-surface font-['Space_Grotesk']">إكمال الطلب السريع</h3>
          <button onClick={onClose} disabled={loading} className="text-on-surface-variant hover:text-error transition-colors p-1 disabled:opacity-50">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        
        {item && (
          <div className="mb-6 p-4 rounded-xl bg-black/20 border border-white/5 flex gap-4 items-center">
            <div className="w-12 h-12 rounded-lg bg-surface-container-high flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-primary">inventory_2</span>
            </div>
            <div>
              <p className="font-bold text-on-surface text-sm line-clamp-1">{item.title}</p>
              <p className="text-primary text-sm font-bold mt-1">{item.price}</p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-on-surface-variant mb-2">رقم الهاتف (للتواصل السريع) <span className="text-error">*</span></label>
            <input 
              type="tel" 
              required
              disabled={loading}
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className="w-full bg-black/20 border border-white/10 rounded-lg px-4 py-3 text-on-surface focus:border-primary focus:outline-none transition-colors text-left font-body-md disabled:opacity-50"
              placeholder="01xxxxxxxxx"
              dir="ltr"
            />
            {!session && (
               <p className="text-xs text-primary/70 mt-2">تسجيل الدخول يتيح لك حفظ بياناتك تلقائياً للطلبات القادمة</p>
            )}
          </div>
          
          <div>
            <label className="block text-sm font-bold text-on-surface-variant mb-2">ملاحظة (اختياري)</label>
            <textarea 
              value={note}
              disabled={loading}
              onChange={e => setNote(e.target.value)}
              className="w-full bg-black/20 border border-white/10 rounded-lg px-4 py-3 text-on-surface focus:border-primary focus:outline-none transition-colors min-h-[80px] resize-none font-body-md disabled:opacity-50"
              placeholder="أي تفاصيل إضافية..."
            />
          </div>

          <button disabled={loading} type="submit" className="w-full bg-[#25D366] text-white font-bold py-3 rounded-xl hover:bg-[#1da851] transition-all flex items-center justify-center gap-2 mt-4 shadow-[0_0_20px_rgba(37,211,102,0.3)] disabled:opacity-70">
            {loading ? (
              <span className="animate-pulse">جاري التحويل للواتساب...</span>
            ) : (
              <>
                <span className="material-symbols-outlined text-[20px]">forum</span>
                إرسال الطلب
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
