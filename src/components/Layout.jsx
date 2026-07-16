import { useState, useEffect, useRef } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';
import CartDrawer from './CartDrawer';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import LiveSearch from './LiveSearch';
import SocialProofToast from './SocialProofToast';
import { useSettings } from '../context/SettingsContext';
import { motion, AnimatePresence } from 'framer-motion';
import Footer from './Footer';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [language, setLanguage] = useState('ar');
  const [notifications, setNotifications] = useState([]);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [missingPhone, setMissingPhone] = useState(false);
  const [phoneBannerDismissed, setPhoneBannerDismissed] = useState(false);
  const [freeShipping, setFreeShipping] = useState({ enabled: false, threshold: 500 });
  const [announceDismissed, setAnnounceDismissed] = useState(false);
  const session = useAuth();
  const { getCartCount, toggleCart, cartBounce } = useCart();
  const { showToast } = useToast();
  const { settings } = useSettings();
  const hasShownPhoneToast = useRef(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (session?.user?.id) {
      fetchNotifications();

      // Check if user has a phone number
      const hasPhoneMetadata = session.user?.user_metadata?.phone;
      if (!hasPhoneMetadata) {
        supabase.from('user_profiles').select('phone').eq('user_id', session.user.id).single().then(({ data }) => {
          if (data?.phone) {
            setMissingPhone(false);
          } else {
            setMissingPhone(true);
            if (!hasShownPhoneToast.current) {
              showToast('warning', 'قم بتأكيد رقم هاتفك من الاعدادات لتوثيق حسابك');
              hasShownPhoneToast.current = true;
            }
          }
        });
      } else {
        setMissingPhone(false);
      }

      // Real-time subscription for notifications
      const channel = supabase
        .channel('schema-db-changes')
        .on('postgres_changes', 
          { event: 'INSERT', schema: 'public', table: 'user_notifications', filter: `user_id=eq.${session.user.id}` }, 
          payload => {
            setNotifications(prev => [payload.new, ...prev]);
          }
        )
        .subscribe();
      return () => supabase.removeChannel(channel);
    } else {
      setMissingPhone(false);
    }
  }, [location.pathname, session?.user?.id]);

  async function fetchNotifications() {
    const { data } = await supabase
      .from('user_notifications')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (data) setNotifications(data);
  }

  const markAsRead = async () => {
    if (!session?.user?.id) return;
    await supabase
      .from('user_notifications')
      .update({ is_read: true })
      .eq('user_id', session.user.id);
    setNotifications(notifications.map(n => ({ ...n, is_read: true })));
  };

  useEffect(() => {
    const root = document.documentElement;
    if (isDarkMode) {
      root.classList.add('dark');
      if (settings?.theme_colors) {
         if (settings.theme_colors.background) root.style.setProperty('--background', settings.theme_colors.background);
         if (settings.theme_colors.surface) root.style.setProperty('--surface', settings.theme_colors.surface);
         if (settings.theme_colors.surface_2) root.style.setProperty('--surface-container', settings.theme_colors.surface_2);
         if (settings.theme_colors.text) root.style.setProperty('--on-surface', settings.theme_colors.text);
         if (settings.theme_colors.text_muted) root.style.setProperty('--on-surface-variant', settings.theme_colors.text_muted);
         if (settings.theme_colors.border) root.style.setProperty('--outline', settings.theme_colors.border);
      }
    } else {
      root.classList.remove('dark');
      root.style.removeProperty('--background');
      root.style.removeProperty('--surface');
      root.style.removeProperty('--surface-container');
      root.style.removeProperty('--on-surface');
      root.style.removeProperty('--on-surface-variant');
      root.style.removeProperty('--outline');
    }
  }, [isDarkMode, settings]);

  useEffect(() => {
    supabase.from('site_settings').select('free_shipping_enabled, free_shipping_threshold').eq('id', 1).single().then(({ data }) => {
      if (data) setFreeShipping({ enabled: data.free_shipping_enabled !== false, threshold: data.free_shipping_threshold || 500 });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // Keep dir="rtl" to prevent layout jumping, only update lang
    document.documentElement.lang = language === 'ar' ? 'ar' : 'en';
  }, [language]);

  const navItems = [
    { name: language === 'ar' ? 'الرئيسية' : 'Home', path: '/', icon: 'home' },
    { name: language === 'ar' ? 'الكتالوج' : 'Catalog', path: '/catalog', icon: 'settings_input_component' },
    { name: language === 'ar' ? 'الطلبات' : 'Orders', path: '/orders', icon: 'receipt_long' },
    { name: language === 'ar' ? 'المفضلة' : 'Favorites', path: '/favorites', icon: 'favorite' },
    { name: language === 'ar' ? 'الدعم' : 'Support', path: '/support', icon: 'chat' },
  ];

  const toggleMenu = () => setIsMenuOpen(!isMenuOpen);
  const toggleTheme = () => setIsDarkMode(!isDarkMode);
  const toggleLanguage = () => setLanguage(language === 'ar' ? 'en' : 'ar');

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/');
  };

  const userName = session?.user?.user_metadata?.name || session?.user?.email?.split('@')[0];

  return (
    <div className="min-h-screen flex flex-col bg-surface overflow-x-hidden" dir={language === 'ar' ? 'rtl' : 'ltr'}>
      {/* Ultra-Premium Glassmorphic Header */}
      <header className="fixed top-0 w-full h-16 z-[100] bg-[#131921]/70 backdrop-blur-2xl border-b border-white/[0.02] shadow-[0_4px_30px_rgba(0,0,0,0.5)] backdrop-saturate-[1.5] transition-all duration-300">
        <div className="h-full flex justify-between items-center px-4 md:px-6 relative gap-2 md:gap-6">
          
          {/* Logo & Menu (Right side in RTL) */}
          <div className="flex items-center gap-4">
            {/* Mobile Menu Toggle */}
            <button onClick={toggleMenu} aria-label="Menu" className="text-gray-900 dark:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-all duration-300 rounded-full p-2 hover:scale-105">
              <span className="material-symbols-outlined text-[28px]">{isMenuOpen ? 'close' : 'menu'}</span>
            </button>
            <Link to="/" className="text-xl md:text-2xl font-black text-transparent bg-clip-text bg-gradient-to-l from-primary via-red-600 to-red-400 font-['Space_Grotesk'] tracking-tight drop-shadow-[0_0_15px_rgba(220,38,38,0.4)] shrink-0 flex items-center gap-2">
              {settings?.logo_url && <img src={settings.logo_url} alt="Logo" className="w-8 h-8 md:w-10 md:h-10 object-contain rounded-md" />}
              {(!settings?.logo_url || settings?.brand_name) && <span>{settings?.brand_name || 'EG-PARTS'}</span>}
            </Link>

            {/* Desktop Navigation Links */}
            <nav className="hidden md:flex items-center gap-6 mr-4 border-r border-white/5 pr-6">
              {navItems.map((item) => {
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.name}
                    to={item.path}
                    className={cn(
                      "flex items-center gap-2 transition-all text-sm font-bold",
                      isActive
                        ? "text-primary"
                        : "text-gray-900 dark:text-white hover:text-primary"
                    )}
                  >
                    <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
                    {item.name}
                  </Link>
                );
              })}
            </nav>

            {/* Dropdown Menu */}
            {isMenuOpen && (
              <div className="absolute top-16 start-6 mt-2 w-56 rounded-xl bg-surface-container border border-white/[0.03] shadow-[0_8px_30px_rgba(0,0,0,0.6)] py-2 flex flex-col z-[100] backdrop-blur-md overflow-hidden">
                <button onClick={() => { navigate('/account'); setIsMenuOpen(false); }} className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 text-on-surface transition-colors w-full text-start">
                  <span className="material-symbols-outlined text-primary">settings</span>
                  <span className="font-body-md">{language === 'ar' ? 'الإعدادات' : 'Settings'}</span>
                </button>
                <button onClick={toggleTheme} className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 text-on-surface transition-colors w-full text-start">
                  <span className="material-symbols-outlined text-primary">{isDarkMode ? 'light_mode' : 'dark_mode'}</span>
                  <span className="font-body-md">{isDarkMode ? (language === 'ar' ? 'الوضع النهاري' : 'Light Mode') : (language === 'ar' ? 'الوضع الليلي' : 'Dark Mode')}</span>
                </button>
                {session && (
                  <button onClick={handleLogout} className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 text-error transition-colors w-full text-start border-t border-white/10 mt-1">
                    <span className="material-symbols-outlined">logout</span>
                    <span className="font-body-md">{language === 'ar' ? 'تسجيل الخروج' : 'Logout'}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Center: Live Search (Desktop) */}
          <div className="flex-1 max-w-2xl hidden lg:block">
            <LiveSearch />
          </div>

          {/* Actions (Left side in RTL) */}
          <div className="flex items-center gap-1 md:gap-3 shrink-0">
            {/* Desktop-only search icon for medium screens where LiveSearch is hidden */}
            <div className="lg:hidden hidden md:block">
               <button onClick={() => setIsMobileSearchOpen(!isMobileSearchOpen)} className="text-gray-900 dark:text-white p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5">
                 <span className="material-symbols-outlined text-[24px]">search</span>
               </button>
            </div>
            {!session && session !== undefined && (
              <Link to="/auth" className="hidden sm:flex items-center gap-2 bg-gradient-to-r from-primary to-red-700 hover:from-red-500 hover:to-red-800 text-white px-5 py-2.5 rounded-full transition-all text-sm font-bold shadow-[0_0_20px_rgba(220,38,38,0.3)] hover:shadow-[0_0_25px_rgba(220,38,38,0.5)] hover:-translate-y-0.5">
                <span className="material-symbols-outlined text-[18px]">person</span>
                {language === 'ar' ? 'دخول' : 'Login'}
              </Link>
            )}
            {session && (
              <div className="flex items-center gap-1 md:gap-2">
                <Link to="/account" className="hidden sm:flex items-center gap-2 text-gray-900 dark:text-white bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 border border-black/10 dark:border-white/[0.03] hover:border-primary/40 px-4 py-2 rounded-full text-sm font-bold transition-all hover:-translate-y-0.5">
                  <span className="material-symbols-outlined text-[18px] text-primary">account_circle</span>
                  <span className="truncate max-w-[100px]">{userName}</span>
                </Link>

                {/* Notifications Bell */}
                <div className="relative">
                  <button 
                    onClick={() => { setIsNotifOpen(!isNotifOpen); if(!isNotifOpen) markAsRead(); }}
                    className={`p-2 rounded-full transition-all hover:bg-black/5 dark:hover:bg-white/5 ${isNotifOpen ? 'text-primary bg-primary/10' : 'text-gray-900 dark:text-white'}`}
                  >
                    <span className="material-symbols-outlined text-[24px]">notifications</span>
                    {notifications.filter(n => !n.is_read).length > 0 && (
                      <span className="absolute top-2 right-2 bg-primary w-2 h-2 rounded-full animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.8)]"></span>
                    )}
                  </button>

                  <AnimatePresence>
                    {isNotifOpen && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10, scale: 0.95, x: language === 'ar' ? 20 : -20 }}
                        animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        className="absolute top-14 left-0 w-80 glass-panel border border-white/10 rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] z-[200] overflow-hidden"
                      >
                        <div className="p-5 border-b border-gray-200 dark:border-white/5 flex justify-between items-center bg-gray-50/50 dark:bg-white/[0.02]">
                          <span className="font-black text-sm text-gray-900 dark:text-white">التنبيهات</span>
                          <span className="text-[9px] text-gray-500 dark:text-on-surface-variant font-black uppercase tracking-widest opacity-60">أحدث الإشعارات</span>
                        </div>
                        <div className="max-h-[380px] overflow-y-auto custom-scrollbar">
                          {notifications.length === 0 ? (
                            <div className="p-12 text-center text-gray-400 dark:text-on-surface-variant opacity-40">
                              <span className="material-symbols-outlined text-[48px] mb-3">notifications_off</span>
                              <p className="text-xs font-bold">لا توجد تنبيهات حالياً</p>
                            </div>
                          ) : (
                            notifications.map((n) => (
                              <div key={n.id} className={`p-5 border-b border-gray-100 dark:border-white/5 last:border-0 hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors ${!n.is_read ? 'bg-primary/5' : ''}`}>
                                <div className="flex gap-4">
                                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${n.type === 'order_update' ? 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-500 dark:text-blue-400' : 'bg-primary/10 dark:bg-primary/20 text-primary'}`}>
                                    <span className="material-symbols-outlined text-[20px]">
                                      {n.type === 'order_update' ? 'local_shipping' : 'notifications'}
                                    </span>
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-black text-gray-900 dark:text-white mb-1 leading-tight">{n.title}</p>
                                    <p className="text-[11px] text-gray-600 dark:text-on-surface-variant leading-relaxed line-clamp-2 opacity-80">{n.message}</p>
                                    <p className="text-[9px] text-primary font-bold mt-2 opacity-60">{new Date(n.created_at).toLocaleString('ar-EG')}</p>
                                  </div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                        <Link to="/account?tab=notifications" onClick={() => setIsNotifOpen(false)} className="block p-4 text-center text-[11px] font-black text-primary hover:bg-primary/10 border-t border-gray-200 dark:border-white/5 transition-all">
                          عرض كافة الإشعارات في حسابي
                        </Link>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* Mobile Search Toggle */}
            <button 
              onClick={() => setIsMobileSearchOpen(!isMobileSearchOpen)}
              aria-label="Search" 
              className={`md:hidden transition-all duration-300 rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/5 ${isMobileSearchOpen ? 'text-primary bg-primary/10' : 'text-gray-900 dark:text-white'}`}
            >
              <span className="material-symbols-outlined">{isMobileSearchOpen ? 'close' : 'search'}</span>
            </button>

            {/* Cart Button */}
            <button 
              onClick={toggleCart} 
              aria-label="Cart" 
              className={`relative text-gray-900 dark:text-white hover:text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-all duration-300 rounded-full p-2 hover:scale-105 ${cartBounce > 0 ? 'cart-bounce' : ''}`}
            >
              <span className="material-symbols-outlined">shopping_cart</span>
              {getCartCount() > 0 && (
                <span className="absolute top-0 right-0 bg-error text-white text-[10px] font-bold w-4 h-4 flex items-center justify-center rounded-full border border-[#131921]">
                  {getCartCount()}
                </span>
              )}
            </button>

            {/* Mobile login/account icon */}
            {!session && session !== undefined ? (
              <Link to="/auth" aria-label="Login" className="sm:hidden text-gray-900 dark:text-white hover:text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-all duration-300 rounded-full p-2">
                <span className="material-symbols-outlined">person</span>
              </Link>
            ) : session ? (
              <Link to="/account" aria-label="Account" className="sm:hidden text-primary hover:bg-white/5 transition-all duration-300 rounded-full p-2">
                <span className="material-symbols-outlined">account_circle</span>
              </Link>
            ) : null}
          </div>
        </div>
        
        {/* Mobile Search Bar (Expands down) */}
        <div className={`md:hidden overflow-hidden transition-all duration-300 ease-in-out ${isMobileSearchOpen ? 'max-h-24 opacity-100 border-t border-white/5' : 'max-h-0 opacity-0'}`}>
          <div className="p-3 bg-surface-container/50 backdrop-blur-xl">
            <LiveSearch isMobile={true} />
          </div>
        </div>
      </header>

      <div className={`${(missingPhone && !phoneBannerDismissed) || (freeShipping.enabled && !announceDismissed) ? 'mt-16' : ''}`}>
        {missingPhone && !phoneBannerDismissed && (
          <div className="relative z-50 bg-gradient-to-l from-amber-600/90 to-amber-700/90 backdrop-blur-xl border-b border-amber-400/20">
            <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-amber-200 text-[22px]">verified_user</span>
                <p className="text-sm font-bold text-white">
                  قم بتأكيد رقم هاتفك من{' '}
                  <Link to="/account" className="text-amber-200 underline hover:text-white transition-colors">الإعدادات</Link>
                  {' '}لتوثيق حسابك
                </p>
              </div>
              <button onClick={() => setPhoneBannerDismissed(true)} className="text-white/60 hover:text-white transition-colors p-1">
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
          </div>
        )}

        {freeShipping.enabled && !announceDismissed && (
          <div className="relative z-40 border-b border-on-surface/5 overflow-hidden">
            <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 mx-auto">
                <span className="material-symbols-outlined text-primary/70 text-[20px] animate-bounce" style={{ animationDuration: '2s' }}>local_shipping</span>
                <p className="text-xs md:text-sm font-bold text-on-surface-variant">
                  توصيل مجاني للطلبات فوق <span className="text-primary">EGP {freeShipping.threshold?.toLocaleString()}</span>
                </p>
                <span className="material-symbols-outlined text-primary/50 text-[16px] hidden sm:inline">verified</span>
              </div>
              <button onClick={() => setAnnounceDismissed(true)} className="text-on-surface-variant/40 hover:text-on-surface transition-colors p-0.5 shrink-0">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <main className="pt-16 pb-28 md:pb-0">
        <Outlet />
      </main>

      <Footer />

      <nav className="fixed bottom-0 left-0 w-full z-50 flex md:hidden justify-around items-center px-2 pt-3 pb-safe bg-white/95 dark:bg-[#131921]/90 backdrop-blur-3xl border-t border-white/[0.03] shadow-[0_-4px_20px_rgba(0,0,0,0.08)] dark:shadow-[0_-10px_40px_rgba(0,0,0,0.8)]" style={{paddingBottom: 'max(16px, env(safe-area-inset-bottom))'}}>
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.name}
              to={item.path}
              className={cn(
                "flex flex-col items-center justify-center transition-all text-[10px] tracking-wide font-bold min-w-[56px] py-1",
                isActive
                  ? "text-primary dark:text-primary"
                  : "text-gray-600 dark:text-gray-400 hover:text-primary"
              )}
            >
              <span className={cn(
                "material-symbols-outlined mb-0.5 text-[24px] transition-all",
                isActive
                  ? "text-primary dark:text-primary [font-variation-settings:'FILL'_1] scale-110"
                  : "text-gray-600 dark:text-gray-400"
              )}>{item.icon}</span>
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Social Proof Toast */}
      <SocialProofToast />

      {/* Floating WhatsApp Button */}
      {location.pathname !== '/support' && (
        <a 
          href={settings?.whatsapp_number ? `https://wa.me/${settings.whatsapp_number}` : "https://chat.whatsapp.com/EetOwhJlRH88m0s9jxmzAv"}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-24 md:bottom-8 end-6 z-[90] bg-green-500 text-white p-4 rounded-full shadow-[0_0_30px_rgba(34,197,94,0.5)] hover:scale-110 hover:shadow-[0_0_40px_rgba(34,197,94,0.7)] transition-all duration-300 flex items-center justify-center group"
        >
          <span className="material-symbols-outlined text-3xl group-hover:animate-bounce" style={{ fontVariationSettings: "'FILL' 1" }}>chat</span>
        </a>
      )}
      
      <CartDrawer />
    </div>
  );
}
