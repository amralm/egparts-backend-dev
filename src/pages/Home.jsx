import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useCart } from '../context/CartContext';
import { useWishlist } from '../context/WishlistContext';
import { useSEO } from '../hooks/useSEO';
import ProductSkeleton from '../components/ProductSkeleton';
import { motion, AnimatePresence } from 'framer-motion';

import { useStore } from '../context/StoreContext';

export default function Home() {
  const [latestProducts, setLatestProducts] = useState([]);
  const [trendingProducts, setTrendingProducts] = useState([]);
  const [banners, setBanners] = useState([]);
  const [currentBanner, setCurrentBanner] = useState(0);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const { addToCart, cart } = useCart();
  const { toggleWishlist, isInWishlist } = useWishlist();
  const { store } = useStore();

  function c(path, fallback = '') {
    try {
      const keys = path.split('.');
      let val = settings?.content;
      for (const k of keys) if (val) val = val[k];
      return val || fallback;
    } catch { return fallback; }
  }

  useSEO({
    title: c('seo.title', 'الرئيسية'),
    description: c('seo.description', 'سوق قطع غيار الأجهزة المنزلية الأول في مصر. تصفح أحدث القطع وأفضل العروض.')
  });

  useEffect(() => {
    if (store?.id) {
      fetchHomeData();
    }
  }, [store?.id]);

  async function fetchHomeData() {
    try {
      setLoading(true);
      
      // Fetch Banners
      const { data: bannersData, error: bannersError } = await supabase
        .from('banners')
        .select('*')
        .eq('is_active', true)
        .eq('store_id', store.id)
        .order('order_index', { ascending: true });
      
      if (!bannersError && bannersData && bannersData.length > 0) {
        setBanners(bannersData);
      } else {
        setBanners([]);
      }

      // Fetch Latest 4 Products
      const { data: latest } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .neq('is_deleted', true)
        .eq('store_id', store.id)
        .gt('stock_quantity', 0)
        .order('created_at', { ascending: false })
        .limit(4);
        
      if (latest) setLatestProducts(latest);

      // Fetch Trending
      const { data: trending } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .neq('is_deleted', true)
        .eq('store_id', store.id)
        .gt('stock_quantity', 0)
        .order('stock_quantity', { ascending: true })
        .limit(4);
        
      if (trending) setTrendingProducts(trending);

      // Fetch Settings
      const { data: settingsData } = await supabase.from('site_settings').select('*').eq('store_id', store.id).single();
      if (settingsData) setSettings(settingsData);
    } catch (error) {
      console.error("Home Data Fetch Error:", error);
    } finally {
      setLoading(false);
    }
  }

  // Banner Auto-slide
  useEffect(() => {
    if (banners.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentBanner(prev => (prev + 1) % banners.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [banners]);

  // Countdown timer logic for the flash sale
  const [timeLeft, setTimeLeft] = useState({ hours: 0, minutes: 0, seconds: 0 });
  
  useEffect(() => {
    if (!settings?.flash_sale_end_time) return;
    
    const targetDate = new Date(settings.flash_sale_end_time).getTime();
    
    const timer = setInterval(() => {
      const now = new Date().getTime();
      const distance = targetDate - now;
      
      if (distance < 0) {
        clearInterval(timer);
        setTimeLeft({ hours: 0, minutes: 0, seconds: 0 });
        return;
      }
      
      const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)) + Math.floor(distance / (1000 * 60 * 60 * 24)) * 24;
      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);
      
      setTimeLeft({ hours, minutes, seconds });
    }, 1000);
    
    return () => clearInterval(timer);
  }, [settings?.flash_sale_end_time]);

  const renderProductCard = (product) => {
    const oldPrice = product.old_price ? parseFloat(product.old_price) : 0;
    const currentPrice = parseFloat(product.price);
    const hasDiscount = oldPrice > currentPrice;
    const discountPercent = hasDiscount ? Math.round(((oldPrice - currentPrice) / oldPrice) * 100) : 0;
    const savedAmount = hasDiscount ? (oldPrice - currentPrice) : 0;
    const hd = settings?.hot_deals || {};
    const isHotDeal = hd.active && hd.product_ids?.includes(product.id) && (!hd.end_time || new Date(hd.end_time) > new Date());

    return (
    <div key={product.id} className="group relative bg-surface-container/60 rounded-xl overflow-hidden border border-white/5 backdrop-blur-md transition-all duration-300 hover:-translate-y-2 hover:shadow-[0_15px_40px_rgba(255,153,0,0.15)] flex flex-col h-full" dir="rtl">
      {/* Inner Glow Overlay */}
      <div className="absolute inset-0 rounded-xl pointer-events-none z-20 transition-all duration-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)] group-hover:shadow-[inset_0_0_0_1px_rgba(255,153,0,0.5),inset_0_0_30px_rgba(255,153,0,0.15)]"></div>
      
      <Link to={`/product/${product.id}`} className="relative h-[220px] w-full bg-gradient-to-b from-white/5 to-transparent p-4 flex items-center justify-center overflow-hidden block group-hover:bg-white/10 transition-colors duration-300">
        
        {/* Hot Deal Badge - top left */}
        {isHotDeal && (
          <div className="absolute top-3 left-3 z-20 bg-gradient-to-l from-amber-500 to-orange-600 text-white font-black text-[10px] px-2 py-1 rounded-md shadow-[0_0_15px_rgba(255,153,0,0.5)] flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">local_fire_department</span>
            {hd.badge_text || 'عرض ناري'}
          </div>
        )}

        {/* Wishlist Button */}
        <button 
          onClick={(e) => {
            e.preventDefault();
            toggleWishlist(product.id);
          }}
          className={`absolute top-3 right-3 z-30 p-2 rounded-full backdrop-blur-md border transition-all duration-300 shadow-[0_0_15px_rgba(0,0,0,0.5)] dark:shadow-[0_0_15px_rgba(0,0,0,0.5)] ${
            isInWishlist(product.id) 
              ? 'bg-red-50 text-red-500 border-red-200 dark:bg-red-500/20 dark:border-red-500 dark:text-red-500 hover:bg-red-100 dark:hover:bg-red-500/30' 
              : 'bg-white/80 border-gray-200 text-gray-600 hover:bg-white hover:text-red-500 hover:border-red-500 dark:bg-black/40 dark:border-white/20 dark:text-white dark:hover:bg-black/60 dark:hover:text-red-400 dark:hover:border-red-400'
          }`}
        >
          <span className={`material-symbols-outlined text-[18px] ${isInWishlist(product.id) ? 'fill-current' : ''}`}>favorite</span>
        </button>

        {/* Discount Badge - bottom left corner */}
        {hasDiscount && discountPercent > 0 && (
          <div className="absolute bottom-3 left-3 z-20 bg-gradient-to-r from-error to-red-500 text-white font-black text-[11px] px-2 py-0.5 rounded-full shadow-[0_0_15px_rgba(255,59,48,0.5)]" dir="ltr">
            -{discountPercent}%
          </div>
        )}

        <div className="relative z-0 group-hover:scale-110 transition-transform duration-300 ease-out w-full h-full flex items-center justify-center p-2">
          {product.image ? (
            <img alt={product.name} className="w-full h-full object-cover rounded-xl drop-shadow-2xl" src={product.image}/>
          ) : (
            <span className="material-symbols-outlined text-[48px] text-surface-variant">image</span>
          )}
        </div>
      </Link>
      <div className="p-4 flex-1 flex flex-col relative z-10">
        <div className="flex gap-2 mb-3">
          {product.stock_quantity > 0 ? (() => {
            const enabled = settings?.low_stock_warning_enabled !== false;
            const threshold = settings?.low_stock_threshold ?? 100;
            if (enabled && product.stock_quantity <= threshold) {
              return (
                <span className="px-2 py-1 rounded text-amber-400 bg-amber-500/10 font-bold text-[10px] border border-amber-500/20 animate-pulse">
                  قرب يخلص {product.stock_quantity <= 10 ? `🔥` : ''}
                </span>
              );
            }
            return (
              <span className="px-2 py-1 rounded text-green-400 bg-green-500/10 font-bold text-[10px] border border-green-500/20">
                متوفر في المخزن
              </span>
            );
          })() : (
            <span className="px-2 py-1 rounded text-red-400 bg-red-500/10 font-bold text-[10px] border border-red-500/20">
              نفذت الكمية
            </span>
          )}
          {product.category && (
            <span className="px-2 py-1 rounded text-on-surface-variant bg-white/5 font-bold text-[10px] border border-white/10">
              {product.category}
            </span>
          )}
        </div>
        
        <div className="mb-auto text-right">
          <Link to={`/product/${product.id}`}>
            <h3 className="text-sm font-bold text-on-surface mb-2 line-clamp-2 group-hover:text-primary transition-colors">{product.name}</h3>
          </Link>
        </div>
        <div className="flex flex-col mt-4 pt-4 border-t border-white/5">
          {/* Price Section */}
          <div className="flex items-center justify-between mb-3" dir="ltr">
            <div className="flex flex-col text-left">
              {hasDiscount && (
                <span className="text-[11px] text-on-surface-variant line-through decoration-error/70 decoration-2 font-bold opacity-70 h-4">
                  EGP {oldPrice}
                </span>
              )}
              {!hasDiscount && <span className="h-4"></span>}
              <span className="text-lg font-black text-primary-container drop-shadow-[0_0_10px_rgba(255,153,0,0.2)]">
                EGP {product.price}
              </span>
            </div>
            {hasDiscount && (
              <div className="bg-primary/10 text-primary border border-primary/20 text-[10px] font-black px-2 py-1 rounded-md">
                توفير {savedAmount} ج
              </div>
            )}
          </div>

          {/* Add to cart button */}
          <div className="w-full">
            {cart.some(item => item.id === product.id) ? (
              <button disabled className="w-full bg-surface-variant text-on-surface-variant font-bold py-2 rounded-lg text-xs flex justify-center items-center gap-1">
                <span className="material-symbols-outlined text-[16px]">check_circle</span> في السلة
              </button>
            ) : (
              <button 
                onClick={(e) => { e.preventDefault(); addToCart(product); }}
                disabled={product.stock_quantity <= 0}
                className="w-full bg-gradient-to-r from-[#E53935] to-[#FF5722] hover:from-[#D32F2F] hover:to-[#E64A19] text-white font-bold py-2 rounded-lg text-xs transition-all flex justify-center items-center gap-1 disabled:opacity-50 shadow-[0_4px_15px_rgba(229,57,53,0.3)]"
              >
                <span className="material-symbols-outlined text-[16px]">add_shopping_cart</span> أضف للسلة
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

  return (
    <main className="flex-grow flex flex-col overflow-x-hidden">
      {/* Hero Section / Banner Slider */}
      <section className="relative min-h-[550px] md:min-h-[700px] flex items-center justify-center overflow-hidden bg-surface-dim">
        <AnimatePresence mode='wait'>
          {banners.length > 0 ? (
            <motion.div
              key={currentBanner}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8 }}
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url(${banners[currentBanner].image_url})` }}
            >
              {/* Dynamic Abstract Gradients (Glassy Glow) */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-40 -right-40 w-96 h-96 bg-red-500/20 rounded-full blur-[120px]"></div>
                <div className="absolute top-1/2 -left-20 w-80 h-80 bg-red-600/10 rounded-full blur-[100px]"></div>
                <div className="absolute bottom-0 right-1/4 w-64 h-64 bg-red-500/15 rounded-full blur-[90px]"></div>
              </div>

              {/* ضباب الصورة كامل */}
              <div className="absolute inset-0 bg-white/[0.02] z-[1] pointer-events-none" style={{ backdropFilter: `blur(${banners[currentBanner].blur_px || 6}px)` }}></div>
              {/* تدرج الصورة كامل */}
              <div className="absolute inset-0 z-[2] pointer-events-none" style={{ background: `linear-gradient(to top, rgba(0,0,0,${(banners[currentBanner].overlay_opacity || 40) / 100}) 0%, rgba(0,0,0,${(banners[currentBanner].overlay_opacity || 40) * 0.25 / 100}) 50%, transparent 100%)` }}></div>

              {/* Content */}
              <div className="relative z-[3] h-full flex items-center justify-center px-6 pt-20">
                <motion.div 
                  initial={{ y: 40, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.4, duration: 0.8, type: 'spring' }}
                  className="max-w-4xl w-full text-center space-y-6 md:space-y-8"
                >
                  {banners[currentBanner].title && (
                    <h1 className="text-4xl md:text-7xl font-black text-on-surface leading-[1.1] tracking-tighter">
                      {banners[currentBanner].title.split(' ').map((word, i) => (
                        <span key={i} className={i === 1 ? "text-primary" : ""}>{word} </span>
                      ))}
                    </h1>
                  )}
                  {banners[currentBanner].subtitle && (
                    <p className="text-base md:text-xl text-on-surface-variant max-w-2xl mx-auto font-medium leading-relaxed">
                      {banners[currentBanner].subtitle}
                    </p>
                  )}
                  <div className="pt-6 md:pt-10 flex flex-col sm:flex-row gap-4 justify-center items-center" dir="rtl">
                    <Link to={banners[currentBanner].link_url || '/catalog'} className="group bg-primary text-on-primary px-10 py-4 rounded-full font-black text-lg hover:bg-primary-fixed transition-all hover:scale-105 shadow-[0_15px_35px_rgba(255,153,0,0.3)] flex items-center gap-3">
                      <span className="text-white">تسوق الآن</span>
                      <span className="material-symbols-outlined group-hover:translate-x-1 transition-transform">arrow_back</span>
                    </Link>
                    <a href="https://chat.whatsapp.com/EetOwhJlRH88m0s9jxmzAv" target="_blank" rel="noopener noreferrer" className="px-8 py-4 rounded-full font-bold text-on-surface border border-white/20 bg-surface-container-high/50 hover:bg-surface-container-high transition-all flex items-center gap-3 backdrop-blur-md">
                      <span>انضم لمجتمعنا</span>
                      <span className="material-symbols-outlined text-[#25D366]">group</span>
                    </a>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          ) : !loading && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ duration: 0.8 }}
              className="absolute inset-0"
            >
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-40 -right-40 w-96 h-96 bg-red-500/20 rounded-full blur-[120px]"></div>
                <div className="absolute top-1/2 -left-20 w-80 h-80 bg-red-600/10 rounded-full blur-[100px]"></div>
                <div className="absolute bottom-0 right-1/4 w-64 h-64 bg-red-500/15 rounded-full blur-[90px]"></div>
              </div>
              <motion.div
                initial={{ y: 30, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.3, duration: 0.7, type: 'spring', stiffness: 80, damping: 15 }}
                className="relative z-10 h-full flex items-center justify-center px-6 pt-20"
              >
                <div className="max-w-4xl w-full text-center space-y-6 md:space-y-8">
                  <h1 className="text-4xl md:text-7xl font-black text-on-surface leading-[1.1] tracking-tighter">
                    <span>{c('hero.title1', 'سوق قطع غيار ')}</span><span className="text-primary">{c('hero.title2', 'الأجهزة المنزلية')}</span>
                  </h1>
                  <p className="text-base md:text-xl text-on-surface-variant max-w-2xl mx-auto font-medium leading-relaxed">
                    {c('hero.subtitle', 'نوفر لك جميع قطع الغيار الأصلية بأفضل الأسعار في مصر')}
                  </p>
                  <div className="pt-6 md:pt-10 flex flex-col sm:flex-row gap-4 justify-center items-center" dir="rtl">
                    <Link to="/catalog" className="group bg-primary text-on-primary px-10 py-4 rounded-full font-black text-lg hover:bg-primary-fixed transition-all hover:scale-105 shadow-[0_15px_35px_rgba(255,153,0,0.3)] flex items-center gap-3">
                      <span className="text-white">{c('hero.cta', 'تسوق الآن')}</span>
                      <span className="material-symbols-outlined group-hover:translate-x-1 transition-transform">arrow_back</span>
                    </Link>
                    <a href="https://chat.whatsapp.com/EetOwhJlRH88m0s9jxmzAv" target="_blank" rel="noopener noreferrer" className="px-8 py-4 rounded-full font-bold text-on-surface border border-white/20 bg-surface-container-high/50 hover:bg-surface-container-high transition-all flex items-center gap-3 backdrop-blur-md">
                      <span>{c('hero.community', 'انضم لمجتمعنا')}</span>
                      <span className="material-symbols-outlined text-[#25D366]">group</span>
                    </a>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        
        {/* Navigation Dots */}
        {banners.length > 1 && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 flex gap-3 z-30">
            {banners.map((_, i) => (
              <button 
                key={i} onClick={() => setCurrentBanner(i)}
                className={`h-1.5 transition-all duration-500 rounded-full ${currentBanner === i ? 'bg-primary w-12' : 'bg-white/20 w-4 hover:bg-white/40'}`}
              />
            ))}
          </div>
        )}

      </section>

      {/* Flash Sale Countdown Section */}
      {settings?.flash_sale_active && (
        <section className="px-6 max-w-7xl mx-auto w-full py-12 relative z-20">
          <div className="bg-gradient-to-r from-[#FF3B30]/20 to-background border border-[#FF3B30]/30 rounded-2xl p-6 md:p-8 flex flex-col md:flex-row items-center justify-between gap-6 backdrop-blur-xl shadow-[0_20px_50px_rgba(255,59,48,0.15)]" dir="rtl">
            <div className="flex items-center gap-4">
              <div className="bg-primary text-on-primary p-4 rounded-full flex items-center justify-center animate-bounce">
                <span className="material-symbols-outlined text-[32px]">sell</span>
              </div>
              <div>
                <h3 className="font-headline-md text-2xl font-bold text-on-surface mb-1">{settings?.flash_sale_title || 'عرض اليوم! 🔥'}</h3>
                <p className="text-primary font-bold">{settings?.flash_sale_desc || 'خصم 15% على جميع كمبروسرات LG'}</p>
              </div>
            </div>
            
            <div className="flex items-center gap-3 text-center" dir="ltr">
              <div className="bg-surface-container-highest border border-on-surface/10 rounded-lg p-3 w-16">
                <span className="block font-black text-2xl text-on-surface">{timeLeft.hours.toString().padStart(2, '0')}</span>
                <span className="text-[10px] text-on-surface-variant uppercase">Hours</span>
              </div>
              <div className="inline text-2xl font-bold text-primary animate-pulse">:</div>
              <div className="bg-surface-container-highest border border-on-surface/10 rounded-lg p-3 w-16">
                <span className="block font-black text-2xl text-on-surface">{timeLeft.minutes.toString().padStart(2, '0')}</span>
                <span className="text-[10px] text-on-surface-variant uppercase">Mins</span>
              </div>
              <div className="inline text-2xl font-bold text-primary animate-pulse">:</div>
              <div className="bg-surface-container-highest border border-on-surface/10 rounded-lg p-3 w-16 shadow-[0_0_15px_rgba(255,59,48,0.4)]">
                <div className="block font-black text-2xl text-primary">{timeLeft.seconds.toString().padStart(2, '0')}</div>
                <span className="text-[10px] text-on-surface-variant uppercase">Secs</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Latest Products Section */}
      <section className="py-16 px-6 max-w-7xl mx-auto w-full" dir="rtl">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h2 className="font-headline-lg text-2xl font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">new_releases</span>
              {c('sections.latest.heading', 'وصل حديثاً')}
            </h2>
            <p className="text-on-surface-variant text-sm mt-1">{c('sections.latest.subtitle', 'أحدث القطع المضافة للكتالوج')}</p>
          </div>
          <Link to="/catalog" className="text-primary hover:text-white transition-colors text-sm font-bold flex items-center gap-1">
            {c('product_card.view_all', 'عرض الكل')} <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1,2,3,4].map(i => (
              <ProductSkeleton key={i} />
            ))}
          </div>
        ) : (
          <motion.div 
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={{
              hidden: { opacity: 0 },
              visible: {
                opacity: 1,
                transition: { staggerChildren: 0.15 }
              }
            }}
            className="grid grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {latestProducts.map((p) => (
              <motion.div key={p.id} variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}>
                {renderProductCard(p)}
              </motion.div>
            ))}
          </motion.div>
        )}
      </section>

      {/* Trending Products Section */}
      <section className="py-8 px-6 max-w-7xl mx-auto w-full bg-surface-container/30 border-y border-white/5" dir="rtl">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h2 className="font-headline-lg text-2xl font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-red-600">trending_up</span>
              {c('sections.trending.heading', 'الأكثر مبيعاً هذا الأسبوع')}
            </h2>
            <p className="text-on-surface-variant text-sm mt-1">{c('sections.trending.subtitle', 'القطع التي يطلبها الفنيون بكثرة')}</p>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1,2,3,4].map(i => (
              <ProductSkeleton key={`trend-${i}`} />
            ))}
          </div>
        ) : (
          <motion.div 
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={{
              hidden: { opacity: 0 },
              visible: {
                opacity: 1,
                transition: { staggerChildren: 0.1 }
              }
            }}
            className="grid grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {trendingProducts.map((p) => (
              <motion.div key={p.id} variants={{ hidden: { opacity: 0, scale: 0.9 }, visible: { opacity: 1, scale: 1 } }}>
                {renderProductCard(p)}
              </motion.div>
            ))}
          </motion.div>
        )}
      </section>

      {/* Features & Trust Section */}
      <section className="py-12 px-6 max-w-7xl mx-auto w-full border-t border-gray-200 dark:border-white/5 mt-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          <div className="flex flex-col items-center p-6 bg-white dark:bg-white/5 rounded-2xl border border-gray-200 dark:border-white/5 hover:border-primary/30 dark:hover:border-primary/30 transition-colors shadow-sm dark:shadow-none group">
            <div className="bg-red-500/10 dark:bg-red-500/20 text-red-600 w-16 h-16 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-3xl">verified</span>
            </div>
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">{c('features.0.title', 'قطع أصلية (OEM)')}</h3>
            <p className="text-gray-900 dark:text-white opacity-90 text-sm">{c('features.0.desc', 'جميع القطع لدينا أصلية ومعتمدة لضمان أطول عمر افتراضي للأجهزة.')}</p>
          </div>
          <div className="flex flex-col items-center p-6 bg-white dark:bg-white/5 rounded-2xl border border-gray-200 dark:border-white/5 hover:border-[#25D366]/30 dark:hover:border-[#25D366]/30 transition-colors shadow-sm dark:shadow-none group">
            <div className="bg-[#25D366]/10 dark:bg-[#25D366]/20 text-[#25D366] w-16 h-16 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-3xl">support_agent</span>
            </div>
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">{c('features.1.title', 'دعم فني متواصل')}</h3>
            <p className="text-gray-900 dark:text-white opacity-90 text-sm">{c('features.1.desc', 'فريق كامل لخدمة الفنيين، نساعدك في اختيار القطعة البديلة المناسبة بدقة.')}</p>
          </div>
          <div className="flex flex-col items-center p-6 bg-white dark:bg-white/5 rounded-2xl border border-gray-200 dark:border-white/5 hover:border-blue-500/30 dark:hover:border-blue-500/30 transition-colors shadow-sm dark:shadow-none group">
            <div className="bg-blue-500/10 dark:bg-blue-500/20 text-blue-500 w-16 h-16 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-3xl">local_shipping</span>
            </div>
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">{c('features.2.title', 'شحن سريع ومرن')}</h3>
            <p className="text-gray-900 dark:text-white opacity-90 text-sm">{c('features.2.desc', 'توصيل سريع لجميع المحافظات خلال 24-48 ساعة لضمان استمرار عملك.')}</p>
          </div>
        </div>
      </section>

      {/* Categories Section (Bento Grid) */}
      <section className="py-24 px-6 max-w-7xl mx-auto w-full">
        <div className="text-center mb-16">
          <h2 className="font-headline-lg text-3xl font-bold text-on-surface mb-4">{c('categories.heading', 'تسوق حسب القسم')}</h2>
          <p className="text-on-surface-variant">{c('categories.subtitle', 'اكتشف مجموعتنا الواسعة من قطع الغيار الأصلية')}</p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6 auto-rows-[200px]" dir="rtl">
          {(settings?.content?.categories?.items || [])
            .filter(cat => cat.is_visible !== false)
            .slice(0, 12)
            .map((cat, i) => {
              const isTemplateA = cat.template === 'templateA';
              const isTemplateC = cat.template === 'templateC';
              const linkTarget = cat.category_link ? `/catalog?category=${encodeURIComponent(cat.category_link)}` : '/catalog';
              
              if (isTemplateA) {
                return (
                  <Link key={cat.id || i} to={linkTarget} className="md:col-span-2 md:row-span-2 group relative rounded-3xl overflow-hidden bg-surface-container-low hover:border-primary/50 transition-all duration-500 shadow-xl hover:shadow-2xl hover:-translate-y-2 border border-white/5">
                    {cat.image ? (
                      <img alt={cat.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-80 group-hover:scale-105 transition-all duration-700 mix-blend-luminosity" src={cat.image}/>
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-background opacity-80 group-hover:scale-105 transition-all duration-700"></div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent"></div>
                    <div className="absolute bottom-0 right-0 p-8 w-full flex justify-between items-end z-10">
                      <div>
                        <h3 className="font-headline-md text-3xl font-black text-white mb-2 drop-shadow-lg">{cat.name}</h3>
                        <p className="text-white/80 font-bold">{cat.desc}</p>
                      </div>
                      <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl group-hover:bg-primary group-hover:text-white transition-colors duration-300 border border-white/10">
                        {cat.icon ? (
                          <span className="material-symbols-outlined text-3xl">{cat.icon}</span>
                        ) : (
                          <span className="material-symbols-outlined text-3xl">arrow_back</span>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              }
              
              if (isTemplateC) {
                return (
                  <Link key={cat.id || i} to={linkTarget} className="md:col-span-2 group relative rounded-3xl overflow-hidden bg-surface-container-low hover:border-primary/50 transition-all duration-500 shadow-xl hover:shadow-2xl hover:-translate-y-2 border border-white/5">
                    <div className="absolute inset-0 bg-gradient-to-l from-black/80 to-background opacity-90"></div>
                    <div className="relative h-full p-8 flex flex-row items-center justify-between z-10">
                      <div>
                        <div className="bg-white/5 backdrop-blur-md p-3 rounded-xl w-fit mb-4 group-hover:scale-110 transition-transform shadow-md border border-white/10">
                          <span className="material-symbols-outlined text-primary text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>{cat.icon || 'category'}</span>
                        </div>
                        <h3 className="font-bold text-2xl text-white mb-2 drop-shadow-md">{cat.name}</h3>
                        <p className="text-white/60 text-sm max-w-[200px]">{cat.desc}</p>
                      </div>
                      {cat.image ? (
                        <img alt={cat.name} loading="lazy" className="w-32 h-32 md:w-40 md:h-40 object-cover rounded-2xl opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500 shadow-2xl border border-white/10" src={cat.image}/>
                      ) : (
                        <div className="w-32 h-32 bg-primary/10 rounded-2xl flex items-center justify-center">
                          <span className="material-symbols-outlined text-6xl text-primary/40">image</span>
                        </div>
                      )}
                    </div>
                  </Link>
                );
              }
              
              // Template B (Standard)
              return (
                <Link key={cat.id || i} to={linkTarget} className="group relative rounded-3xl overflow-hidden bg-surface-container-low hover:border-secondary/50 transition-all duration-500 shadow-xl hover:shadow-2xl hover:-translate-y-2 border border-white/5">
                  {cat.image ? (
                    <img alt={cat.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover opacity-40 group-hover:opacity-60 group-hover:scale-105 transition-all duration-700" src={cat.image}/>
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-bl from-secondary/20 to-background opacity-80 group-hover:scale-105 transition-all duration-700"></div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 to-black/20"></div>
                  <div className="relative h-full p-6 flex flex-col justify-between z-10">
                    <div className="bg-white/5 backdrop-blur-md p-3 rounded-xl w-fit group-hover:scale-110 transition-transform shadow-md border border-white/10">
                      <span className="material-symbols-outlined text-secondary text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>{cat.icon || 'category'}</span>
                    </div>
                    <div>
                      <h3 className="font-bold text-xl text-white drop-shadow-md">{cat.name}</h3>
                      <p className="text-white/60 mt-1 text-sm line-clamp-2">{cat.desc}</p>
                    </div>
                  </div>
                </Link>
              );
          })}
        </div>
      </section>
    </main>
  );
}
