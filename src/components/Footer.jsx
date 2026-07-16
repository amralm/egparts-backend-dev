import { Link } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext';

export default function Footer() {
  const { settings } = useSettings();

  const brandName = settings?.brand_name || 'EG-PARTS';
  const description = settings?.store_description || 'متجرك الأول لقطع غيار الأجهزة المنزلية بأسعار تنافسية وضمان حقيقي.';
  const copyright = settings?.copyright_text || `© ${new Date().getFullYear()} ${brandName}. جميع الحقوق محفوظة.`;
  const supportHours = settings?.support_hours || 'يومياً من 9 صباحاً حتى 10 مساءً';
  
  const hasSocials = settings?.facebook_url || settings?.instagram_url || settings?.tiktok_url;

  return (
    <footer className="bg-surface-container border-t border-white/5 pt-12 pb-24 md:pb-12 mt-auto" dir="rtl">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
          
          {/* Column 1: Brand & About */}
          <div className="space-y-4">
            <Link to="/" className="inline-flex items-center gap-2 text-2xl font-black text-transparent bg-clip-text bg-gradient-to-l from-primary via-red-600 to-red-400 font-['Space_Grotesk'] tracking-tight drop-shadow-[0_0_15px_rgba(220,38,38,0.4)]">
              {settings?.logo_url && <img src={settings.logo_url} alt="Logo" className="w-8 h-8 object-contain rounded-md" />}
              {(!settings?.logo_url || settings?.brand_name) && <span>{brandName}</span>}
            </Link>
            <p className="text-sm text-on-surface-variant leading-relaxed">
              {description}
            </p>
          </div>

          {/* Column 2: Quick Links */}
          <div className="space-y-4">
            <h3 className="text-lg font-bold text-on-surface relative inline-block">
              روابط سريعة
              <span className="absolute bottom-0 right-0 w-1/2 h-0.5 bg-primary mt-2 translate-y-2 rounded-full"></span>
            </h3>
            <ul className="space-y-3 mt-4">
              <li><Link to="/catalog" className="text-sm text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2"><span className="material-symbols-outlined text-[16px]">chevron_left</span>الكتالوج</Link></li>
              <li><Link to="/orders" className="text-sm text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2"><span className="material-symbols-outlined text-[16px]">chevron_left</span>تتبع طلباتي</Link></li>
              <li><Link to="/favorites" className="text-sm text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2"><span className="material-symbols-outlined text-[16px]">chevron_left</span>المفضلة</Link></li>
              <li><Link to="/auth" className="text-sm text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2"><span className="material-symbols-outlined text-[16px]">chevron_left</span>حسابي</Link></li>
            </ul>
          </div>

          {/* Column 3: Contact Info */}
          <div className="space-y-4">
            <h3 className="text-lg font-bold text-on-surface relative inline-block">
              تواصل معنا
              <span className="absolute bottom-0 right-0 w-1/2 h-0.5 bg-primary mt-2 translate-y-2 rounded-full"></span>
            </h3>
            <ul className="space-y-4 mt-4 text-sm text-on-surface-variant">
              {settings?.whatsapp_number && (
                <li className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-green-500">chat</span>
                  <div dir="ltr" className="text-right flex-1">{settings.whatsapp_number}</div>
                </li>
              )}
              {settings?.support_email && (
                <li className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-blue-400">email</span>
                  <div className="flex-1 break-all">{settings.support_email}</div>
                </li>
              )}
              {settings?.store_address && (
                <li className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-primary">location_on</span>
                  <div className="flex-1">{settings.store_address}</div>
                </li>
              )}
              <li className="flex items-start gap-3">
                <span className="material-symbols-outlined text-amber-500">schedule</span>
                <div className="flex-1">{supportHours}</div>
              </li>
            </ul>
          </div>

          {/* Column 4: Socials */}
          {hasSocials && (
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-on-surface relative inline-block">
                تابعنا
                <span className="absolute bottom-0 right-0 w-1/2 h-0.5 bg-primary mt-2 translate-y-2 rounded-full"></span>
              </h3>
              <div className="flex gap-3 mt-4">
                {settings?.facebook_url && (
                  <a href={settings.facebook_url} target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-surface-container-high border border-white/5 flex items-center justify-center text-on-surface-variant hover:text-blue-500 hover:bg-blue-500/10 hover:border-blue-500/30 transition-all">
                    <span className="material-symbols-outlined font-['Space_Grotesk'] font-bold">F</span>
                  </a>
                )}
                {settings?.instagram_url && (
                  <a href={settings.instagram_url} target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-surface-container-high border border-white/5 flex items-center justify-center text-on-surface-variant hover:text-pink-500 hover:bg-pink-500/10 hover:border-pink-500/30 transition-all">
                    <span className="material-symbols-outlined font-['Space_Grotesk'] font-bold">In</span>
                  </a>
                )}
                {settings?.tiktok_url && (
                  <a href={settings.tiktok_url} target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-surface-container-high border border-white/5 flex items-center justify-center text-on-surface-variant hover:text-white hover:bg-white/10 hover:border-white/30 transition-all">
                    <span className="material-symbols-outlined font-['Space_Grotesk'] font-bold">Tk</span>
                  </a>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Bottom Bar */}
        <div className="pt-6 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-on-surface-variant">
          <div className="flex flex-col md:flex-row items-center gap-2">
            <p>{copyright}</p>
            <span className="hidden md:inline opacity-30">•</span>
            <a href={window.location.hostname.includes('egparts.gt.tc') ? 'https://egparts.gt.tc' : 'https://egparts.store'} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-bold opacity-60 hover:opacity-100 transition-opacity">تكنولوجيا المتجر بواسطة EG-PARTS</a>
          </div>
          <div className="flex items-center gap-4">
            <span>دفع آمن وموثوق</span>
            <div className="flex gap-2 opacity-50">
              <span className="material-symbols-outlined text-[20px]">credit_card</span>
              <span className="material-symbols-outlined text-[20px]">account_balance</span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
