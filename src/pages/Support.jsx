import { useState } from 'react';
import { useSettings } from '../context/SettingsContext';

export default function Support() {
  const { settings } = useSettings();
  const supportNumber = (settings?.whatsapp_number || '201122551272').replace(/[^\d]/g, '');

  const [formData, setFormData] = useState({
    type: '',
    model: '',
    description: ''
  });

  const handleWhatsAppSubmit = () => {
    const text = `معلومات الطلب:%0Aالجهاز: ${formData.type}%0Aالموديل: ${formData.model}%0Aالوصف: ${formData.description}`;
    window.open(`https://wa.me/${supportNumber}?text=${text}`, '_blank');
  };

  return (
    <main className="flex-grow container mx-auto px-6 md:px-gutter max-w-[1200px] flex flex-col gap-lg py-md pb-[100px] md:pb-[80px] min-h-screen">
      {/* WhatsApp Join Section */}
      <section className="glass-panel rounded-xl p-margin flex flex-col md:flex-row items-center gap-margin relative overflow-hidden" style={{ boxShadow: '0 0 30px rgba(34, 197, 94, 0.3)' }}>
        <div className="absolute inset-0 bg-gradient-to-br from-green-500/10 to-transparent pointer-events-none"></div>
        <div className="flex-1 z-10 flex flex-col gap-md">
          <h2 className="font-headline-lg text-headline-lg text-on-background">انضم لمجتمع المحترفين</h2>
          <p className="font-body-lg text-body-lg text-on-surface-variant">وصلك دعم فني فوري، عروض حصرية، وتنبيهات بأحدث قطع الغيار اللي بتنزل عندنا.</p>
          <ul className="flex flex-col gap-sm">
            <li className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-green-400">check_circle</span>
              <span className="font-body-md text-body-md">دعم فني أسبقيه</span>
            </li>
            <li className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-green-400">check_circle</span>
              <span className="font-body-md text-body-md">تخفيضات وعروض حصرية</span>
            </li>
            <li className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-green-400">check_circle</span>
              <span className="font-body-md text-body-md">تواصل مباشر مع خبراء التوريد</span>
            </li>
          </ul>
          <a 
            href="https://chat.whatsapp.com/EetOwhJlRH88m0s9jxmzAv"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-sm bg-[#25D366] hover:bg-[#1DA851] text-white font-headline-md text-headline-md px-lg py-md rounded-lg flex items-center justify-center gap-sm transition-all duration-300 shadow-[0_0_30px_rgba(37,211,102,0.4)] w-full md:w-auto"
          >
            <span className="material-symbols-outlined">forum</span>
            اشترك في جروب الواتساب
          </a>
        </div>
        <div className="w-full md:w-1/3 z-10 flex justify-center">
          <div className="w-[200px] h-[200px] bg-surface-container rounded-full flex items-center justify-center border-2 border-green-500/30 relative" style={{ boxShadow: '0 0 30px rgba(34, 197, 94, 0.3)' }}>
            <div className="absolute inset-0 bg-[#25D366] opacity-10 rounded-full animate-pulse"></div>
            <span className="material-symbols-outlined text-[80px] text-[#25D366]">group</span>
          </div>
        </div>
      </section>

      {/* Bento Grid: Contact & FAQ */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-md">
        {/* Contact Form */}
        <div className="glass-panel rounded-xl p-md flex flex-col gap-md border border-white/5 shadow-lg">
          <h3 className="font-headline-md text-headline-md text-on-background flex items-center gap-sm">
            <span className="material-symbols-outlined text-primary">send</span>
            استفسار مباشر
          </h3>
          <p className="font-body-md text-body-md text-on-surface-variant">محترف قطعة معينة؟ ابعت التفاصيل لفريق التوريد عالواتساب واحنا نخدمك.</p>
          <form className="flex flex-col gap-sm">
            <div className="flex flex-col gap-xs">
              <label className="font-label-sm text-label-sm text-on-surface-variant">نوع الجهاز والماركة</label>
              <input 
                className="bg-surface-dim border border-outline-variant rounded-md px-sm py-sm text-on-background focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-colors" 
                placeholder="مثال: ثلاجة سامسونج" 
                type="text"
                value={formData.type}
                onChange={e => setFormData({...formData, type: e.target.value})}
              />
            </div>
            <div className="flex flex-col gap-xs">
              <label className="font-label-sm text-label-sm text-on-surface-variant">رقم الموديل</label>
              <input 
                className="bg-surface-dim border border-outline-variant rounded-md px-sm py-sm text-on-background focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-colors" 
                placeholder="اكتب رقم الموديل" 
                type="text"
                value={formData.model}
                onChange={e => setFormData({...formData, model: e.target.value})}
              />
            </div>
            <div className="flex flex-col gap-xs">
              <label className="font-label-sm text-label-sm text-on-surface-variant">وصف القطعة</label>
              <textarea 
                className="bg-surface-dim border border-outline-variant rounded-md px-sm py-sm text-on-background focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-colors resize-none" 
                placeholder="اشرح القطعة اللي محتاجها..." 
                rows="3"
                value={formData.description}
                onChange={e => setFormData({...formData, description: e.target.value})}
              ></textarea>
            </div>
            <button 
              className="mt-sm bg-primary-container text-on-primary-container font-headline-md text-headline-md px-md py-sm rounded-md flex items-center justify-center gap-sm hover:bg-primary transition-colors neon-glow-primary" 
              type="button"
              onClick={handleWhatsAppSubmit}
            >
              أرسل عالواتساب
              <span className="material-symbols-outlined">arrow_forward</span>
            </button>
          </form>
        </div>

        {/* FAQ */}
        <div className="glass-panel rounded-xl p-md flex flex-col gap-md border border-white/5 shadow-lg">
          <h3 className="font-headline-md text-headline-md text-on-background flex items-center gap-sm">
            <span className="material-symbols-outlined text-tertiary">help</span>
            أسئلة شائعة
          </h3>
          <div className="flex flex-col gap-sm divide-y divide-white/5">
            <div className="py-sm">
              <h4 className="font-headline-md text-headline-md text-on-surface text-[18px] mb-xs">القطع بتاعتك أصلية؟</h4>
              <p className="font-body-md text-body-md text-on-surface-variant text-sm">بنوفر قطع أصلية OEM و aftermarket عالية الجودة، ومكتوب عليها بوضوح عشان الشفافية.</p>
            </div>
            <div className="py-sm">
              <h4 className="font-headline-md text-headline-md text-on-surface text-[18px] mb-xs">الشحن بياخد قد إيه؟</h4>
              <p className="font-body-md text-body-md text-on-surface-variant text-sm">اللي موجود عندنا بيشحن خلال 24 ساعة. القطع اللي بنجيبها بالطلب بتاخد 3-5 أيام عمل.</p>
            </div>
            <div className="py-sm">
              <h4 className="font-headline-md text-headline-md text-on-surface text-[18px] mb-xs">فيه ضمان على القطع؟</h4>
              <p className="font-body-md text-body-md text-on-surface-variant text-sm">أيوه، كل البوردات الإلكترونية والكمبروسرات عليها ضمان 6 شهور ضد عيوب الصناعة.</p>
            </div>
          </div>
        </div>
      </section>

    </main>
  );
}
