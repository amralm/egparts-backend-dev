import { Link, useSearchParams } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useCart } from '../context/CartContext';
import { useWishlist } from '../context/WishlistContext';
import { useSEO } from '../hooks/useSEO';
import { useDebounce } from '../hooks/useDebounce';
import ProductSkeleton from '../components/ProductSkeleton';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../context/StoreContext';
import { useSettings } from '../context/SettingsContext';

const PAGE_SIZE = 20;

export default function Catalog() {
  const [searchParams, setSearchParams] = useSearchParams();

  // URL Sync State Extraction
  const initialQ = searchParams.get('q') || '';
  const initialCat = searchParams.get('category') || 'All';
  const initialBrand = searchParams.get('brand') || 'All';
  const initialMin = parseInt(searchParams.get('min')) || 0;
  const initialMax = parseInt(searchParams.get('max')) || 100000;
  const initialSort = searchParams.get('sort') || 'newest';
  const initialPage = parseInt(searchParams.get('page')) || 0;

  // State
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [hasMore, setHasMore] = useState(false);

  // Filters State (Local inputs + debounce)
  const [localSearch, setLocalSearch] = useState(initialQ);
  const debouncedSearchQuery = useDebounce(localSearch, 400);
  
  const [priceRange, setPriceRange] = useState([initialMin, initialMax]);
  const debouncedPriceRange = useDebounce(priceRange, 500);

  const [showFilters, setShowFilters] = useState(false);
  const { store } = useStore();
  const { settings } = useSettings();

  // Metadata Cache (Categories & Brands)
  const [categories, setCategories] = useState(['All']);
  const [brands, setBrands] = useState(['All']);

  const abortControllerRef = useRef(null);
  const prevFiltersRef = useRef(null);

  const { addToCart, cart } = useCart();
  const { toggleWishlist, isInWishlist } = useWishlist();

  useSEO({
    title: 'الكتالوج (جميع القطع)',
    description: 'تصفح أضخم كتالوج لقطع غيار التبريد والتكييف الأصلية في مصر مع إيجي بارتس. أسعار منافسة وتوافر فوري.'
  });

  // 1. Fetch Metadata (Once)
  useEffect(() => {
    async function fetchMetadata() {
      if (!store?.id) return;
      const { data: catData } = await supabase.from('products').select('category').eq('store_id', store.id).eq('is_active', true);
      const { data: brandData } = await supabase.from('products').select('brand').eq('store_id', store.id).eq('is_active', true);
      
      if (catData) {
        const cats = new Set(catData.map(d => d.category).filter(Boolean));
        setCategories(['All', ...Array.from(cats)]);
      }
      if (brandData) {
        const bds = new Set(brandData.map(d => d.brand).filter(Boolean));
        setBrands(['All', ...Array.from(bds)]);
      }
    }
    fetchMetadata();
  }, [store?.id]);

  // 2. Sync Local State changes to URL
  useEffect(() => {
    const newParams = new URLSearchParams(searchParams);
    
    if (debouncedSearchQuery) newParams.set('q', debouncedSearchQuery);
    else newParams.delete('q');

    if (debouncedPriceRange[0] > 0) newParams.set('min', debouncedPriceRange[0]);
    else newParams.delete('min');
    
    if (debouncedPriceRange[1] < 100000) newParams.set('max', debouncedPriceRange[1]);
    else newParams.delete('max');

    if (page > 0) newParams.set('page', page);
    else newParams.delete('page');

    setSearchParams(newParams, { replace: true });
  }, [debouncedSearchQuery, debouncedPriceRange, page]);

  const updateUrlParam = (key, value, defaultValue) => {
    const newParams = new URLSearchParams(searchParams);
    if (value === defaultValue || !value) {
      newParams.delete(key);
    } else {
      newParams.set(key, value);
    }
    setSearchParams(newParams);
  };

  // 3. Fetch Products (Server-Side Pagination & Filtering)
  useEffect(() => {
    if (!store?.id) return;
    const q = searchParams.get('q') || '';
    const cat = searchParams.get('category') || 'All';
    const brand = searchParams.get('brand') || 'All';
    const min = parseInt(searchParams.get('min')) || 0;
    const max = parseInt(searchParams.get('max')) || 100000;
    const sort = searchParams.get('sort') || 'newest';

    const currentFilters = { q, cat, brand, min, max, sort };
    const filtersChanged = JSON.stringify(prevFiltersRef.current) !== JSON.stringify(currentFilters);

    let targetPage = page;
    if (filtersChanged) {
      targetPage = 0;
      setPage(0);
      setProducts([]); // Clear items immediately for better UX
      prevFiltersRef.current = currentFilters;
    }

    async function fetchProductsData() {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      if (filtersChanged || targetPage === 0) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        let query;
        // Only run count on the first page or if filters changed to avoid heavy DB load on "Load More"
        if (targetPage === 0 || filtersChanged) {
          query = supabase.from('products').select('*', { count: 'exact' });
        } else {
          query = supabase.from('products').select('*');
        }

        query = query.eq('store_id', store.id).eq('is_active', true).neq('is_deleted', true);

        // Apply Server-Side Filters
        if (q) {
          query = query.or(`name.ilike.%${q}%,part_number.ilike.%${q}%,category.ilike.%${q}%`);
        }
        if (cat !== 'All') query = query.eq('category', cat);
        if (brand !== 'All') query = query.eq('brand', brand);
        
        // Use the native numeric price field directly
        query = query.gte('price', min).lte('price', max);

        // Sorting
        if (sort === 'price-asc') query = query.order('price', { ascending: true, nullsFirst: false });
        else if (sort === 'price-desc') query = query.order('price', { ascending: false, nullsFirst: false });
        else if (sort === 'popular') query = query.order('stock_quantity', { ascending: false }); // approximation for popular
        else query = query.order('created_at', { ascending: false }); // newest

        // Pagination & Browser Back Support
        const isFirstLoadWithPage = targetPage > 0 && products.length === 0;
        const from = isFirstLoadWithPage ? 0 : targetPage * PAGE_SIZE;
        const to = targetPage * PAGE_SIZE + PAGE_SIZE - 1;
        query = query.range(from, to).abortSignal(signal);

        const { data, count, error: fetchError } = await query;

        if (fetchError && fetchError.name !== 'AbortError') {
          throw fetchError;
        }

        if (data && !signal.aborted) {
          if (targetPage === 0 || isFirstLoadWithPage) {
            setProducts(data);
          } else {
            setProducts(prev => {
              // Prevent duplicates if React strict mode double-fires
              const existingIds = new Set(prev.map(p => p.id));
              const newItems = data.filter(p => !existingIds.has(p.id));
              return [...prev, ...newItems];
            });
          }
          if (count !== null) setTotalCount(count);
          setHasMore(data.length === (to - from + 1) && from + data.length < (count !== null ? count : totalCount));
        }
      } catch (err) {
        if (err.name !== 'AbortError' && err.message?.indexOf('AbortError') === -1) {
          console.error('Error fetching products:', err);
          setError('حدث خطأ أثناء الاتصال بقاعدة البيانات. يرجى المحاولة مرة أخرى.');
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    }

    fetchProductsData();

    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, [searchParams, page, store?.id]);

  return (
    <main className="pb-[100px] md:pb-8 px-6 md:px-margin max-w-[1200px] mx-auto min-h-screen">
      {/* Search Section */}
      <section className="mb-lg mt-8">
        <div className="relative group">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <span className="material-symbols-outlined text-secondary">search</span>
          </div>
          <input 
            className="w-full bg-surface-container/70 border border-white/10 rounded-xl py-4 pl-12 pr-4 text-on-surface focus:outline-none focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all duration-300 placeholder:text-secondary-fixed-dim/50 shadow-[0_4px_20px_rgba(0,0,0,0.3)] backdrop-blur-md" 
            placeholder="البحث برقم الموديل أو اسم القطعة..." 
            type="text"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            dir="rtl"
          />
        </div>
      </section>

      {/* Filters & Sorting */}
      <section className="mb-lg" dir="rtl">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
          {/* Categories Horizontal Scroll */}
          <div className="overflow-x-auto hide-scrollbar w-full md:w-auto border-r-2 border-primary/50 pr-4">
            <div className="flex space-x-sm space-x-reverse pb-2 w-max" style={{ gap: '12px' }}>
              {categories.map((cat, idx) => {
                const isActive = (searchParams.get('category') || 'All') === cat;
                return (
                  <button 
                    key={idx}
                    onClick={() => updateUrlParam('category', cat, 'All')}
                    className={`px-6 py-2 rounded-full font-label-sm whitespace-nowrap transition-all duration-300 ${
                      isActive 
                        ? 'bg-red-600/10 border border-red-600/50 text-red-600 shadow-[0_0_15px_rgba(220,38,38,0.2)]' 
                        : 'bg-surface-container border border-white/10 text-on-surface-variant hover:border-red-500/30 hover:text-red-600'
                    }`}
                  >
                    {cat === 'All' ? 'الكل' : cat}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Advanced Filters Toggle */}
          <button 
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${showFilters ? 'bg-primary text-on-primary shadow-[0_0_15px_rgba(220,38,38,0.4)]' : 'bg-surface-container border border-white/10 text-on-surface-variant hover:text-red-600'}`}
          >
            <span className="material-symbols-outlined text-[20px]">tune</span>
            تخصيص البحث
          </button>
        </div>

        {/* Expandable Advanced Filters */}
        <div className={`overflow-hidden transition-all duration-300 ${showFilters ? 'max-h-[500px] opacity-100 mb-8' : 'max-h-0 opacity-0'}`}>
          <div className="bg-surface-container-high/40 border border-white/5 rounded-[2rem] p-8 grid grid-cols-1 md:grid-cols-3 gap-10 backdrop-blur-xl">
            {/* Sorting */}
            <div className="space-y-4">
              <label className="text-on-surface-variant/60 text-xs font-black uppercase tracking-widest flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">sort</span>
                ترتيب العرض
              </label>
              <select 
                value={searchParams.get('sort') || 'newest'}
                onChange={(e) => updateUrlParam('sort', e.target.value, 'newest')}
                className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-3 text-on-surface outline-none focus:border-primary transition-all font-bold"
              >
                <option value="newest">المضاف حديثاً</option>
                <option value="price-asc">الأقل سعراً</option>
                <option value="price-desc">الأعلى سعراً</option>
                <option value="popular">الأكثر توفراً (شائع)</option>
              </select>
            </div>

            {/* Brands */}
            <div className="space-y-4">
              <label className="text-on-surface-variant/60 text-xs font-black uppercase tracking-widest flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">branding_watermark</span>
                العلامة التجارية
              </label>
              <div className="flex flex-wrap gap-2">
                {brands.map((brand, idx) => {
                  const isActive = (searchParams.get('brand') || 'All') === brand;
                  return (
                    <button 
                      key={idx}
                      onClick={() => updateUrlParam('brand', brand, 'All')}
                      className={`px-4 py-2 rounded-xl text-[11px] font-black transition-all ${
                        isActive 
                          ? 'bg-primary text-on-primary shadow-lg shadow-primary/20' 
                          : 'bg-white/5 text-on-surface-variant hover:bg-white/10 border border-white/5'
                      }`}
                    >
                      {brand === 'All' ? 'الكل' : brand}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Price Range */}
            <div className="space-y-4">
              <label className="text-on-surface-variant/60 text-xs font-black uppercase tracking-widest flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">payments</span>
                نطاق السعر
              </label>
              <div className="flex items-center gap-3">
                <input 
                  type="number" placeholder="من" value={priceRange[0] || ''}
                  onChange={e => setPriceRange([parseInt(e.target.value) || 0, priceRange[1]])}
                  className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-on-surface text-sm outline-none focus:border-primary font-mono"
                />
                <span className="text-on-surface-variant/30">-</span>
                <input 
                  type="number" placeholder="إلى" value={priceRange[1] || ''}
                  onChange={e => setPriceRange([priceRange[0], parseInt(e.target.value) || 100000])}
                  className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-on-surface text-sm outline-none focus:border-primary font-mono"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Results Header */}
      {!loading && !error && (
        <div className="mb-6 flex justify-between items-center text-on-surface-variant text-sm font-bold" dir="rtl">
          <span>تم العثور على <span className="text-primary mx-1">{totalCount}</span> منتج</span>
        </div>
      )}

      <motion.section 
        layout
        initial="hidden"
        animate="visible"
        variants={{
          hidden: { opacity: 0 },
          visible: {
            opacity: 1,
            transition: {
              staggerChildren: 0.1
            }
          }
        }}
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md" 
        dir="rtl"
      >
        {loading ? (
          /* Loading Skeletons */
          Array(6).fill(0).map((_, i) => (
            <ProductSkeleton key={`catalog-skel-${i}`} />
          ))
        ) : products.length > 0 ? (
          products.map((product) => {
            const oldPrice = product.old_price ? parseFloat((product.old_price.toString()).replace(/,/g, '')) : 0;
            // Support both old price and new price_numeric formatting
            const currentPrice = parseFloat((product.price || '0').toString().replace(/,/g, ''));
            const hasDiscount = oldPrice > currentPrice;
            const discountPercent = hasDiscount ? Math.round(((oldPrice - currentPrice) / oldPrice) * 100) : 0;
            const savedAmount = hasDiscount ? (oldPrice - currentPrice) : 0;
            const hd = settings?.hot_deals || {};
            const isHotDeal = hd.active && hd.product_ids?.includes(product.id) && (!hd.end_time || new Date(hd.end_time) > new Date());

            return (
            <motion.div 
              key={product.id} 
              variants={{
                hidden: { y: 20, opacity: 0 },
                visible: { y: 0, opacity: 1 }
              }}
              className="group relative bg-surface-container/30 rounded-2xl overflow-hidden border border-white/5 backdrop-blur-xl transition-all duration-500 hover:shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col h-full"
            >
              {/* Inner Glow Overlay */}
              <div className="absolute inset-0 rounded-2xl pointer-events-none z-20 transition-all duration-500 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.1)] group-hover:shadow-[inset_0_0_0_1px_rgba(220,38,38,0.3),inset_0_0_40px_rgba(220,38,38,0.1)]"></div>
              
              <Link to={`/product/${product.id}`} className="relative h-[260px] w-full bg-gradient-to-b from-white/5 to-transparent p-6 flex items-center justify-center overflow-hidden block group-hover:bg-white/[0.08] transition-colors duration-500">

                {/* Hot Deal Badge */}
                {isHotDeal && (
                  <div className="absolute bottom-4 left-4 z-20 bg-gradient-to-l from-amber-500 to-orange-600 text-white font-black text-[11px] px-2 py-1 rounded-md shadow-[0_0_15px_rgba(255,153,0,0.5)] flex items-center gap-1">
                    <span className="material-symbols-outlined text-[13px]">local_fire_department</span>
                    {hd.badge_text || 'عرض ناري'}
                  </div>
                )}
                
                {/* Wishlist Button */}
                <button 
                  onClick={(e) => {
                    e.preventDefault();
                    toggleWishlist(product.id);
                  }}
                  className={`absolute top-4 right-4 z-30 p-2.5 rounded-full backdrop-blur-xl border transition-all duration-300 ${
                    isInWishlist(product.id) 
                      ? 'bg-red-500/20 border-red-500 text-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)]' 
                      : 'bg-black/40 border-white/10 text-on-surface-variant/70 hover:bg-black/60 hover:text-red-400 hover:border-red-400'
                  }`}
                >
                  <span className={`material-symbols-outlined text-[22px] ${isInWishlist(product.id) ? 'fill-current' : ''}`}>favorite</span>
                </button>

                {/* Discount Badge */}
                {hasDiscount && discountPercent > 0 && (
                  <div className="absolute top-4 left-4 z-20 bg-gradient-to-r from-red-600 to-red-500 text-white font-black text-[12px] px-3 py-1 rounded-lg shadow-[0_4px_15px_rgba(239,68,68,0.4)]" dir="ltr">
                    -{discountPercent}%
                  </div>
                )}

                <motion.div 
                  whileHover={{ scale: 1.08 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  className="relative z-0 w-full h-full flex items-center justify-center p-2"
                >
                  {product.image ? (
                    <img alt={product.name} className="w-full h-full object-cover rounded-xl drop-shadow-[0_20px_30px_rgba(0,0,0,0.6)]" src={product.image}/>
                  ) : (
                    <span className="material-symbols-outlined text-[80px] text-surface-variant/30">image</span>
                  )}
                </motion.div>
              </Link>

              <div className="p-6 flex-1 flex flex-col relative z-10">
                <div className="flex gap-2 mb-3">
                  {product.stock_quantity > 0 ? (() => {
                    const enabled = settings?.low_stock_warning_enabled !== false;
                    const threshold = settings?.low_stock_threshold ?? 100;
                    if (enabled && product.stock_quantity <= threshold) {
                      return (
                        <span className="px-2 py-0.5 rounded-md text-amber-400 bg-amber-400/10 font-bold text-[10px] border border-amber-400/20 animate-pulse">
                          قرب يخلص {product.stock_quantity <= 10 ? `🔥` : ''}
                        </span>
                      );
                    }
                    return (
                      <span className="px-2 py-0.5 rounded-md text-green-400 bg-green-400/10 font-bold text-[10px] border border-green-400/20">
                        متوفر في المخزن
                      </span>
                    );
                  })() : (
                    <span className="px-2 py-0.5 rounded-md text-red-400 bg-red-400/10 font-bold text-[10px] border border-red-400/20">
                      غير متوفر
                    </span>
                  )}
                  {product.category && (
                    <span className="px-2 py-0.5 rounded-md text-on-surface-variant bg-white/5 font-bold text-[10px] border border-white/10">
                      {product.category}
                    </span>
                  )}
                </div>
                
                <div className="mb-auto text-right">
                  <Link to={`/product/${product.id}`}>
                    <h3 className="text-lg font-bold text-on-surface mb-2 line-clamp-2 hover:text-primary transition-colors leading-tight">{product.name}</h3>
                  </Link>
                  {product.part_number && (
                    <p className="text-xs text-on-surface-variant/60 font-mono mb-4" dir="ltr">#{product.part_number}</p>
                  )}
                </div>

                <div className="mt-4 pt-4 border-t border-white/5">
                  <div className="flex items-center justify-between mb-5">
                    <div className="flex flex-col">
                      <span className="text-2xl font-black text-primary" dir="ltr">
                        EGP {currentPrice.toLocaleString()}
                      </span>
                      {hasDiscount && (
                        <span className="text-xs text-on-surface-variant line-through opacity-50 font-bold" dir="ltr">
                          EGP {oldPrice.toLocaleString()}
                        </span>
                      )}
                    </div>
                    {hasDiscount && (
                      <div className="bg-primary/10 text-primary border border-primary/20 text-xs font-black px-2 py-1 rounded-md">
                        توفير {savedAmount} ج
                      </div>
                    )}
                  </div>

                  {/* Add to cart button */}
                  <div className="w-full">
                    {cart.some(item => item.id === product.id) ? (
                      <button 
                        disabled
                        className="w-full bg-surface-variant text-on-surface-variant font-bold py-3 rounded-lg cursor-not-allowed flex items-center justify-center gap-2 text-sm"
                        dir="rtl"
                      >
                        <span className="material-symbols-outlined text-[18px]">check_circle</span>
                        موجود في السلة
                      </button>
                    ) : (
                      <button 
                        onClick={(e) => {
                          e.preventDefault();
                          addToCart(product);
                        }}
                        disabled={product.stock_quantity <= 0}
                        className="w-full bg-primary hover:bg-red-700 text-white font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-sm shadow-[0_4px_15px_rgba(220,38,38,0.3)]"
                        dir="rtl"
                      >
                        <span className="material-symbols-outlined text-[20px] !text-white">add_shopping_cart</span>
                        <span className="text-sm">أضف للسلة</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
            );
          })
        ) : null}

        {/* Error State */}
        {error && !loading && (
          <div className="col-span-full flex flex-col items-center justify-center py-20 text-center">
            <span className="material-symbols-outlined text-[80px] text-error mb-4">cloud_off</span>
            <h3 className="font-headline-md text-2xl font-bold text-on-surface mb-2">عذراً، فشل التحميل</h3>
            <p className="text-on-surface-variant max-w-md">{error}</p>
            <button onClick={() => setPage(0)} className="mt-6 bg-primary text-on-primary px-8 py-3 rounded-full font-bold hover:bg-primary-fixed transition-all">
              إعادة المحاولة
            </button>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && products.length === 0 && (
          <div className="col-span-full flex flex-col items-center justify-center py-20 text-center opacity-70">
            <span className="material-symbols-outlined text-[80px] text-secondary mb-4 animate-float">search_off</span>
            <h3 className="font-headline-md text-2xl font-bold text-on-surface mb-2">لا يوجد نتائج</h3>
            <p className="text-on-surface-variant">لم نتمكن من العثور على قطع تطابق بحثك. جرب كلمات مفتاحية أخرى أو مسح الفلاتر.</p>
          </div>
        )}
      </motion.section>

      {/* Load More Button */}
      {hasMore && !loading && !error && (
        <div className="mt-12 flex justify-center">
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={loadingMore}
            className="group relative overflow-hidden bg-surface-container border border-white/10 text-on-surface hover:text-white px-8 py-4 rounded-full font-bold transition-all shadow-lg disabled:opacity-50 flex items-center gap-3"
          >
            <div className="absolute inset-0 w-0 bg-primary transition-all duration-300 ease-out group-hover:w-full -z-10"></div>
            {loadingMore ? (
              <>
                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                جاري التحميل...
              </>
            ) : (
              <>
                عرض المزيد
                <span className="material-symbols-outlined transition-transform group-hover:translate-y-1">expand_more</span>
              </>
            )}
          </button>
        </div>
      )}
    </main>
  );
}
