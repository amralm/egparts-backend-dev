import { Link, useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useCart } from '../context/CartContext';
import { useSEO } from '../hooks/useSEO';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../context/SettingsContext';
import { useStore } from '../context/StoreContext';

export default function Product() {
  const session = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const { store } = useStore();
  const [product, setProduct] = useState(null);
  const [similarProducts, setSimilarProducts] = useState([]);
  const [crossSellProducts, setCrossSellProducts] = useState([]);
  const { settings } = useSettings();
  const [loading, setLoading] = useState(true);
  const [activeImage, setActiveImage] = useState('');
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  // Reviews state
  const [reviews, setReviews] = useState([]);
  const [reviewName, setReviewName] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewMessage, setReviewMessage] = useState('');

  const { addToCart, cart } = useCart();

  const [realSalesToday, setRealSalesToday] = useState(0);
  const [liveViewers, setLiveViewers] = useState(1);
  const [fetchingStats, setFetchingStats] = useState(true);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  useEffect(() => {
    if (store?.id) {
      fetchProduct();
    }
  }, [id, store?.id]);

  async function fetchProduct() {
    if (!store?.id) return;
    setLoading(true);
    // Fetch current product
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .eq('store_id', store.id)
      .single();

    if (error || !data || data.is_deleted || data.is_active === false) {
      console.error('Error fetching product or inactive:', error);
      navigate('/catalog'); // Redirect to catalog if not found or hidden
      return;
    }

    setProduct(data);
    setActiveImage(data.image || '');

    // Fetch similar products (same category, different ID)
    if (data.category) {
      const { data: similar } = await supabase
        .from('products')
        .select('*')
        .eq('store_id', store.id)
        .eq('category', data.category)
        .eq('is_active', true)
        .neq('id', data.id)
        .limit(4);
      if (similar) setSimilarProducts(similar);
    }

    // Settings are now provided by SettingsContext, we use it directly

    if (settings && settings.cross_sell_active === false) {
      setCrossSellProducts([]);
    } else {
      const isDemo = settings?.cross_sell_demo !== false;
      // Fetch same-category products (most relevant)
      let query = supabase.from('products').select('*').eq('store_id', store.id).eq('is_active', true).neq('id', data.id).limit(12);
      if (!isDemo && data.category) {
        query = query.eq('category', data.category);
      }
      const { data: crossProducts } = await query;

      if (crossProducts) {
        const shuffled = crossProducts.sort(() => 0.5 - Math.random());
        setCrossSellProducts(shuffled.slice(0, 4));
      }
    }

    // Fetch approved reviews
    const { data: reviewsData } = await supabase
      .from('reviews')
      .select('*')
      .eq('store_id', store.id)
      .eq('product_id', id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false });

    if (reviewsData) setReviews(reviewsData);

    // Fetch Real Sales Today for this product securely via RPC
    const { data: salesCount } = await supabase.rpc('get_product_sales_today', {
      p_product_id: data.id
    });
    
    setRealSalesToday(salesCount || 0);
    setFetchingStats(false);

    setLoading(false);
  }

  useEffect(() => {
    if (!product || !product.id) return;

    // Realtime Presence for Live Viewers
    const channel = supabase.channel(`product-viewers-${product.id}`, {
      config: {
        presence: {
          key: session?.user?.id || `guest-${Math.floor(Math.random() * 1000000)}`,
        },
      },
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const count = Object.keys(state).length;
      // Minimum 1 viewer (the current user)
      setLiveViewers(Math.max(1, count));
    }).subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ active: true, viewedAt: new Date().toISOString() });
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [product?.id, session?.user?.id]);

  const submitReview = async (e) => {
    e.preventDefault();

    // Client-side validation (DB also enforces these)
    const sanitizedName    = reviewName.trim().slice(0, 100);
    const sanitizedComment = reviewComment.trim().slice(0, 2000);

    if (sanitizedName.length < 2)    { setReviewMessage('الاسم يجب أن يكون حرفين على الأقل'); return; }
    if (sanitizedComment.length < 5) { setReviewMessage('التعليق يجب أن يكون 5 أحرف على الأقل'); return; }
    if (reviewRating < 1 || reviewRating > 5) { setReviewMessage('التقييم يجب أن يكون بين 1 و 5'); return; }

    setSubmittingReview(true);
    const { error } = await supabase.from('reviews').insert({
      store_id:   store.id,
      product_id: product.id,
      user_name:  sanitizedName,
      rating:     reviewRating,
      comment:    sanitizedComment,
      status:     'pending' // DB RLS also enforces this — cannot be overridden
    });

    setSubmittingReview(false);

    if (error) {
      console.error('Review Insert Error:', error);
      setReviewMessage('حدث خطأ: ' + (error.message || 'أثناء إرسال التقييم'));
    } else {
      setReviewMessage('شكراً لك! تم إرسال تقييمك بنجاح وهو في انتظار الموافقة.');
      if (session?.user?.id) {
        localStorage.setItem(`reviewed_${id}_${session.user.id}`, 'true');
      }
      setReviewName('');
      setReviewComment('');
      setReviewRating(5);
    }
  };

  const hasReviewed = session?.user?.id ? localStorage.getItem(`reviewed_${id}_${session.user.id}`) === 'true' : false;

  const navigateImage = (e, direction) => {
    e.stopPropagation();
    const currentIndex = allImages.indexOf(activeImage);
    if (currentIndex === -1) return;

    let nextIndex;
    if (direction === 'next') {
      nextIndex = (currentIndex + 1) % allImages.length;
    } else {
      nextIndex = (currentIndex - 1 + allImages.length) % allImages.length;
    }
    setActiveImage(allImages[nextIndex]);
  };

  const getOrderData = () => ({
    id: product?.id,
    productId: product?.id,
    title: product?.name,
    qty: 1,
    price: `EGP ${product?.price}`
  });

  const isOriginal = product?.is_original !== false;
  const hd = settings?.hot_deals || {};
  const isHotDeal = hd.active && hd.product_ids?.includes(product?.id) && (!hd.end_time || new Date(hd.end_time) > new Date());

  // Apply dynamic SEO when product is loaded (must be above conditional returns)
  useSEO({
    title: product ? `${product.name} | EGP ${product.price}` : '',
    description: product ? `اشترِ ${product.name} الأصلي بسعر ${product.price} جنيه مصري. ${isOriginal ? 'قطعة أصلية معتمدة (OEM).' : ''} متوفر الشحن الفوري مع ${settings?.brand_name || 'EG-PARTS'}.` : '',
    image: product?.image
  });

  if (loading) {
    return (
      <main className="pb-[100px] md:pb-[80px] max-w-[1400px] mx-auto px-6 grid grid-cols-1 md:grid-cols-12 gap-gutter min-h-screen" dir="rtl">
        <section className="order-2 md:col-span-6 space-y-md mt-margin">
          <div className="skeleton h-6 w-32 rounded-md"></div>
          <div className="skeleton h-12 w-3/4 rounded-md"></div>
          <div className="skeleton h-6 w-1/2 rounded-md"></div>
          <div className="skeleton h-16 w-48 rounded-2xl mt-6"></div>
          <div className="skeleton h-48 w-full rounded-2xl mt-8"></div>
          <div className="skeleton h-14 w-full rounded-xl mt-8"></div>
        </section>
        <section className="order-1 md:col-span-6 mt-margin">
          <div className="skeleton w-full aspect-square rounded-2xl"></div>
          <div className="grid grid-cols-4 gap-sm mt-4">
            <div className="skeleton w-full aspect-square rounded-xl"></div>
            <div className="skeleton w-full aspect-square rounded-xl"></div>
            <div className="skeleton w-full aspect-square rounded-xl"></div>
            <div className="skeleton w-full aspect-square rounded-xl"></div>
          </div>
        </section>
      </main>
    );
  }

  // Fallbacks for data that might not exist yet if admin hasn't updated the DB schema
  const gallery = product.gallery || [];
  const allImages = [product.image, ...gallery].filter(Boolean);
  const oldPriceNum = product.old_price ? parseFloat(product.old_price) : 0;
  const currentPriceNum = parseFloat(product.price);
  const hasDiscount = oldPriceNum > currentPriceNum;
  const discountPercent = hasDiscount ? Math.round(((oldPriceNum - currentPriceNum) / oldPriceNum) * 100) : 0;
  const savedAmount = hasDiscount ? (oldPriceNum - currentPriceNum) : 0;

  const partNumber = product.part_number || 'N/A';
  const specs = product.specs || {};
  const compatibility = product.compatibility || [];

  return (
    <main className="pb-[180px] md:pb-[80px] max-w-[1400px] mx-auto px-6 grid grid-cols-1 md:grid-cols-12 gap-gutter min-h-screen" dir="rtl">
      {/* Product Details Area */}
      <section className="order-2 md:col-span-6 space-y-md mt-margin">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {isHotDeal && (
              <span className="inline-flex items-center gap-1 bg-gradient-to-l from-amber-500 to-orange-600 text-white text-[10px] font-black px-3 py-1 rounded-full shadow-[0_0_15px_rgba(255,153,0,0.5)]">
                <span className="material-symbols-outlined text-[14px]">local_fire_department</span>
                {hd.badge_text || 'عرض ناري'}
              </span>
            )}
            {isOriginal && (
              <span className="inline-flex items-center gap-1 bg-green-500/10 text-green-400 text-[10px] font-black px-3 py-1 rounded-full border border-green-500/20 uppercase tracking-tighter">
                <span className="material-symbols-outlined text-[14px]">verified</span>
                Original Piece
              </span>
            )}
            {settings?.guarantee_badge_enabled !== false && product.guarantee_badge !== false && (
              <span className="inline-flex items-center gap-1 bg-amber-500/10 text-amber-400 text-[10px] font-black px-3 py-1 rounded-full border border-amber-500/20">
                <span className="material-symbols-outlined text-[14px]">verified</span>
                {settings?.guarantee_text || 'ضمان سنتين على جميع المنتجات'}
              </span>
            )}
            {product.stock_quantity > 0 && product.stock_quantity < 5 && (
              <span className="inline-flex items-center gap-1 bg-red-500/10 text-red-400 text-[10px] font-black px-3 py-1 rounded-full border border-red-500/20 animate-pulse">
                <span className="material-symbols-outlined text-[14px]">priority_high</span>
                كمية محدودة جداً!
              </span>
            )}
          </div>
          <h2 className="font-headline-lg text-headline-lg text-on-surface leading-tight">{product.name}</h2>
          <p className="font-body-md text-body-md text-on-surface-variant flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">tag</span>
            رقم القطعة: <span dir="ltr" className="font-bold bg-surface-container px-2 py-0.5 rounded text-sm border border-white/5">{partNumber}</span>
          </p>
        </div>

        <div className="flex flex-col gap-2 bg-surface-container/30 p-4 rounded-2xl border border-white/5 w-fit">
          <div className="flex items-end gap-4">
            <span className="text-4xl font-black text-primary-container drop-shadow-[0_0_15px_rgba(255,153,0,0.2)]" dir="ltr">EGP {product.price}</span>
            {hasDiscount && (
              <span className="text-xl text-on-surface-variant line-through decoration-error/70 decoration-[3px] font-bold opacity-70 mb-1" dir="ltr">EGP {oldPriceNum}</span>
            )}
          </div>
          {hasDiscount && (
            <div className="flex items-center gap-3 mt-1">
              <span className="bg-gradient-to-r from-error to-red-600 text-white font-black text-sm px-3 py-1 rounded-md shadow-[0_0_15px_rgba(255,59,48,0.4)]" dir="ltr">
                خصم {discountPercent}%
              </span>
              <span className="bg-primary/10 text-primary border border-primary/20 text-sm font-black px-3 py-1 rounded-md">
                وفرت {savedAmount} ج.م
              </span>
            </div>
          )}
        </div>

        {/* Social Proof Counters (Realtime) */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          {/* Live View Counter */}
          <div className="flex flex-col justify-center items-center gap-1 bg-gradient-to-br from-surface-container-high/50 to-surface-container/30 backdrop-blur-md rounded-xl p-3 border border-emerald-500/10 hover:border-emerald-500/30 transition-all shadow-sm">
            <div className="flex items-center gap-2 text-emerald-400">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              <span className="text-2xl font-black">{liveViewers}</span>
            </div>
            <span className="text-[10px] sm:text-xs font-bold text-on-surface-variant text-center leading-tight">
              فني يشاهد القطعة الآن
            </span>
          </div>

          {/* Today's Sales Counter */}
          <div className="flex flex-col justify-center items-center gap-1 bg-gradient-to-br from-surface-container-high/50 to-surface-container/30 backdrop-blur-md rounded-xl p-3 border border-rose-500/10 hover:border-rose-500/30 transition-all shadow-sm">
            <div className="flex items-center gap-2 text-rose-400">
              <span className="material-symbols-outlined text-[20px]">trending_up</span>
              <span className="text-2xl font-black">{fetchingStats ? '-' : realSalesToday}</span>
            </div>
            <span className="text-[10px] sm:text-xs font-bold text-on-surface-variant text-center leading-tight">
              قطعة مباعة هذا اليوم
            </span>
          </div>
        </div>

        {compatibility.length > 0 && (
          <div className="bg-surface-container/70 rounded-xl border border-white/10 backdrop-blur-md p-md space-y-4">
            <h3 className="font-headline-md text-headline-md text-on-surface text-lg">التوافق (الموديلات)</h3>
            <ul className="space-y-2 font-body-md text-body-md text-on-surface-variant" dir="ltr">
              {compatibility.map((model, idx) => (
                <li key={idx} className="flex items-center gap-2 justify-end">
                  {model} <span className="material-symbols-outlined text-primary text-[18px]">check_circle</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {Object.keys(specs).length > 0 && (
          <div className="bg-surface-container/70 rounded-xl border border-white/10 backdrop-blur-md p-md space-y-4">
            <h3 className="font-headline-md text-headline-md text-on-surface text-lg">المواصفات الفنية</h3>
            <div className="grid grid-cols-2 gap-4">
              {Object.entries(specs).map(([key, value], idx) => (
                <div key={idx}>
                  <span className="font-label-sm text-label-sm text-on-surface-variant block">{key}</span>
                  <span className="font-body-md text-body-md text-on-surface" dir="ltr">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}


        {/* Stock Status Indicator */}
        {product.stock_quantity !== undefined && (
          <div className={`flex items-center gap-2 p-3 rounded-xl border ${
            product.stock_quantity <= 0 
              ? 'bg-error/10 border-error/30 text-error'
              : product.stock_quantity <= (product.low_stock_threshold || 5)
              ? 'bg-orange-500/10 border-orange-500/30 text-orange-500'
              : 'bg-green-500/10 border-green-500/30 text-green-500'
          }`}>
            <span className="material-symbols-outlined">
              {product.stock_quantity <= 0 ? 'block' : product.stock_quantity <= (product.low_stock_threshold || 5) ? 'warning' : 'inventory_2'}
            </span>
            <span className="font-bold">
              {product.stock_quantity <= 0 
                ? 'نفذت الكمية (غير متوفر حالياً)' 
                : product.stock_quantity <= (product.low_stock_threshold || 5)
                ? `كمية محدودة! أسرع قبل النفاذ`
                : 'متوفر في المخزن (جاهز للشحن)'}
            </span>
          </div>
        )}

        {/* Sticky CTA for Mobile / Normal for Desktop */}
        <div className="fixed bottom-[90px] md:static left-0 w-full md:w-auto p-4 md:p-0 bg-surface-container md:bg-transparent backdrop-blur-xl md:backdrop-blur-none border-t border-white/10 md:border-none z-40 shadow-[0_-10px_30px_rgba(0,0,0,0.05)] md:shadow-none">
          {product.stock_quantity <= 0 ? (
            <button
              disabled
              className="w-full bg-surface-variant text-on-surface-variant font-headline-md text-headline-md text-lg py-4 rounded-2xl cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[24px]">production_quantity_limits</span>
              نفذت الكمية
            </button>
          ) : cart.some(item => item.id === product.id) ? (
            <button
              disabled
              className="w-full bg-green-500/10 text-green-500 border border-green-500/20 font-headline-md text-headline-md text-lg py-4 rounded-2xl cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[24px]">check_circle</span>
              القطعة في سلتك بالفعل
            </button>
          ) : (
            <button
              onClick={(e) => {
                e.preventDefault();
                addToCart(product);
              }}
              className="w-full bg-primary hover:bg-[#b91c1c] text-white font-headline-md text-headline-md text-xl py-4 rounded-2xl shadow-[0_10px_25px_rgba(220,38,38,0.3)] hover:shadow-[0_15px_35px_rgba(220,38,38,0.4)] transition-all duration-300 flex items-center justify-center gap-3 cursor-pointer group active:scale-95"
            >
              <span className="material-symbols-outlined text-[28px] group-hover:rotate-12 transition-transform">add_shopping_cart</span>
              <span className="font-black">أضف للسلة الآن 🛒</span>
            </button>
          )}
        </div>
      </section>

      {/* Image Gallery Area */}
      <section className="order-1 md:col-span-6 space-y-md mt-margin">
        {/* Main Product Image */}
        <div
          onClick={() => allImages.length > 0 && setIsLightboxOpen(true)}
          className="relative bg-surface-container/70 rounded-2xl border border-white/10 backdrop-blur-md p-lg flex justify-center items-center aspect-square shadow-[0_0_40px_rgba(255,153,0,0.1)] overflow-hidden group cursor-zoom-in"
        >
          {activeImage ? (
            <img alt={product.name} className="w-full h-full object-cover rounded-xl drop-shadow-2xl transition-transform duration-500 group-hover:scale-110" src={activeImage} />
          ) : (
            <span className="material-symbols-outlined text-[100px] text-surface-variant">image</span>
          )}

          {product.stock_quantity <= 5 && product.stock_quantity > 0 && (
            <div className="absolute top-4 left-4 bg-error/20 border border-error/50 text-error px-3 py-1 rounded-full font-label-sm text-label-sm flex items-center gap-xs backdrop-blur-sm shadow-[0_0_15px_rgba(255,180,171,0.3)]">
              <span className="material-symbols-outlined text-[16px]">warning</span>
              كمية محدودة جداً
            </div>
          )}
          {product.stock_quantity <= 0 && (
            <div className="absolute top-4 left-4 bg-error border border-error/50 text-white px-3 py-1 rounded-full font-label-sm text-label-sm flex items-center gap-xs shadow-lg">
              <span className="material-symbols-outlined text-[16px]">block</span>
              نفذت الكمية
            </div>
          )}
        </div>

        {/* Thumbnail Gallery */}
        {allImages.length > 1 && (
          <div className="grid grid-cols-4 gap-sm" dir="ltr">
            {allImages.map((img, idx) => (
              <div
                key={idx}
                onClick={() => setActiveImage(img)}
                className={`rounded-lg border p-2 aspect-square flex items-center justify-center cursor-pointer transition-all ${activeImage === img
                    ? 'bg-surface-container/70 border-primary bg-gradient-to-br from-primary/10 to-transparent scale-95'
                    : 'bg-surface-container/40 border-white/5 hover:bg-surface-container/70 hover:border-white/20'
                  }`}
              >
                <img alt={`Thumbnail ${idx}`} className={`w-full h-full object-cover rounded-md ${activeImage !== img && 'opacity-70 hover:opacity-100 transition-opacity'}`} src={img} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Cross Selling Section (Frequently Bought Together) */}
      {(settings?.cross_sell_active !== false) && crossSellProducts.length > 0 && (
        <section className="col-span-1 md:col-span-12 mt-8 space-y-md border-t border-white/10 pt-10">
          <div className="flex items-center gap-3 text-[#25D366] mb-2">
            <span className="material-symbols-outlined text-[28px]">add_shopping_cart</span>
            <h2 className="font-headline-lg text-2xl font-bold">عملاء آخرون اشتروا أيضاً</h2>
          </div>
          <p className="text-on-surface-variant mb-6">منتجات تكمل عملية التركيب والصيانة (مثل الفريون ومواسير النحاس).</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {crossSellProducts.map((crossProduct) => (
              <div key={crossProduct.id} className="bg-surface-container/30 rounded-xl border border-white/5 p-4 flex flex-col justify-between hover:border-[#25D366]/50 transition-colors group">
                <div className="flex gap-4 items-center">
                  <div className="w-20 h-20 bg-white rounded-lg flex items-center justify-center p-1 shrink-0">
                    {crossProduct.image ? (
                      <img alt={crossProduct.name} className="w-full h-full object-cover rounded group-hover:scale-105 transition-transform" src={crossProduct.image} />
                    ) : (
                      <span className="material-symbols-outlined text-gray-400">image</span>
                    )}
                  </div>
                  <div>
                    <h4 className="font-bold text-sm text-on-surface line-clamp-2 mb-1 cursor-pointer hover:text-primary" onClick={() => navigate(`/product/${crossProduct.id}`)}>
                      {crossProduct.name}
                    </h4>
                    <p className="font-bold text-primary text-sm" dir="ltr">EGP {crossProduct.price}</p>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    addToCart(crossProduct);
                  }}
                  disabled={crossProduct.stock_quantity <= 0}
                  className="mt-4 w-full bg-surface-container-high hover:bg-[#25D366]/20 text-on-surface hover:text-[#25D366] border border-white/5 hover:border-[#25D366]/30 font-bold py-2 rounded-lg transition-colors flex items-center justify-center gap-2 text-sm disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">add</span>
                  إضافة للسلة
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recommendations Section */}
      {similarProducts.length > 0 && (
        <section className="col-span-1 md:col-span-12 mt-10 space-y-md border-t border-white/10 pt-10">
          <h2 className="font-headline-md text-headline-md text-on-surface">قطع مشابهة قد تهمك</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-gutter">
            {similarProducts.map((simProduct) => (
              <Link key={simProduct.id} to={`/product/${simProduct.id}`} className="bg-surface-container/70 rounded-xl border border-white/10 backdrop-blur-md p-4 flex flex-col gap-4 hover:border-primary/50 hover:shadow-[0_0_25px_rgba(255,153,0,0.15)] transition-all group">
                <div className="aspect-square bg-surface-container-highest/30 rounded-lg flex items-center justify-center p-4">
                  {simProduct.image ? (
                    <img alt={simProduct.name} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" src={simProduct.image} />
                  ) : (
                    <span className="material-symbols-outlined text-[40px] text-surface-variant">image</span>
                  )}
                </div>
                <div>
                  <h4 className="font-body-md text-body-md text-on-surface truncate group-hover:text-primary transition-colors">{simProduct.name}</h4>
                  <p className="font-label-sm text-label-sm text-on-surface-variant mt-1" dir="ltr">EGP {simProduct.price}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Reviews Section */}

      <section className="col-span-1 md:col-span-12 mt-xl space-y-md border-t border-white/10 pt-10">
        <div className="flex flex-col md:flex-row gap-10">

          {/* Reviews List */}
          <div className="flex-1 space-y-6">
            <h2 className="font-headline-lg text-2xl text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">reviews</span>
              تقييمات الفنيين والعملاء
            </h2>

            {reviews.length === 0 ? (
              <div className="bg-surface-container/50 border border-white/5 rounded-xl p-8 text-center">
                <span className="material-symbols-outlined text-4xl text-surface-variant mb-2 block">rate_review</span>
                <p className="text-on-surface-variant">لا توجد تقييمات حتى الآن. كن أول من يقيّم هذه القطعة!</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {reviews.map((rev) => (
                  <div key={rev.id} className="bg-surface-container-high/50 border border-white/10 p-5 rounded-xl backdrop-blur-sm">
                    <div className="flex justify-between items-start mb-3">
                      <h4 className="font-bold text-on-surface text-lg">{rev.user_name}</h4>
                      <div className="flex text-primary">
                        {[...Array(5)].map((_, i) => (
                          <span key={i} className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: i < rev.rating ? "'FILL' 1" : "'FILL' 0" }}>star</span>
                        ))}
                      </div>
                    </div>
                    <p className="text-on-surface-variant text-sm leading-relaxed">{rev.comment}</p>
                    <span className="text-[10px] text-secondary-fixed-dim mt-4 block">{new Date(rev.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add Review Form */}
          <div className="w-full md:w-[400px] bg-surface-container/70 border border-white/10 rounded-2xl p-6 h-fit backdrop-blur-md">
            <h3 className="font-bold text-lg text-on-surface mb-4">أضف تقييمك</h3>
            {!session ? (
              <div className="text-center p-6 bg-surface-container/50 rounded-xl border border-white/5">
                <span className="material-symbols-outlined text-4xl text-primary mb-2">lock</span>
                <p className="text-on-surface-variant font-bold mb-4">يجب تسجيل الدخول أولاً لتتمكن من إضافة تقييم</p>
                <button
                  onClick={() => navigate('/auth')}
                  className="bg-primary hover:bg-primary/90 text-on-primary font-bold py-2 px-6 rounded-lg transition-colors"
                >
                  تسجيل الدخول
                </button>
              </div>
            ) : hasReviewed ? (
              <div className="text-center p-6 bg-surface-container/50 rounded-xl border border-white/5">
                <span className="material-symbols-outlined text-4xl text-green-500 mb-2">check_circle</span>
                <p className="text-on-surface-variant font-bold">لقد قمت بتقييم هذه القطعة مسبقاً. شكراً لمشاركتك!</p>
              </div>
            ) : (
              <form onSubmit={submitReview} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1">الاسم</label>
                  <input
                    type="text"
                    required
                    value={reviewName}
                    onChange={e => setReviewName(e.target.value)}
                    className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-on-surface focus:border-primary focus:outline-none transition-colors"
                    placeholder="اسمك أو اسم ورشتك"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1">التقييم</label>
                  <div className="flex gap-1 text-primary cursor-pointer text-xl" dir="ltr">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <span
                        key={star}
                        onClick={() => setReviewRating(star)}
                        className="material-symbols-outlined hover:scale-110 transition-transform"
                        style={{ fontVariationSettings: star <= reviewRating ? "'FILL' 1" : "'FILL' 0" }}
                      >
                        star
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1">تعليقك على جودة القطعة</label>
                  <textarea
                    required
                    value={reviewComment}
                    onChange={e => setReviewComment(e.target.value)}
                    className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-on-surface focus:border-primary focus:outline-none transition-colors min-h-[100px] resize-none"
                    placeholder="رأيك يهم باقي الفنيين..."
                  />
                </div>

                {reviewMessage && (
                  <div className={`p-3 rounded-lg text-sm font-bold ${reviewMessage.includes('بنجاح') ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-error/20 text-error border border-error/30'}`}>
                    {reviewMessage}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submittingReview}
                  className="w-full bg-primary text-on-primary font-bold py-3 rounded-xl hover:bg-primary-fixed transition-colors disabled:opacity-50"
                >
                  {submittingReview ? 'جاري الإرسال...' : 'إرسال التقييم'}
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      {/* Lightbox / Zoom View */}
      {isLightboxOpen && (
        <div className="fixed inset-0 z-[200] bg-black/95 backdrop-blur-3xl flex items-center justify-center animate-in fade-in duration-300" onClick={() => setIsLightboxOpen(false)}>

          <button
            onClick={(e) => { e.stopPropagation(); setIsLightboxOpen(false); }}
            className="absolute top-6 right-6 md:top-10 md:right-10 bg-gray-800/70 hover:bg-gray-700 text-white w-12 h-12 rounded-full flex items-center justify-center transition-all z-50 hover:rotate-90 shadow-lg dark:bg-white/10 dark:hover:bg-white/20"
          >
            <span className="material-symbols-outlined text-2xl">close</span>
          </button>

          {allImages.length > 1 && (
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-between px-4 md:px-10 z-40 pointer-events-none">
              <button
                onClick={(e) => navigateImage(e, 'prev')}
                className="bg-white/10 hover:bg-white/20 backdrop-blur-md text-white w-14 h-14 rounded-full flex items-center justify-center transition-all pointer-events-auto shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:scale-110 border border-white/10"
              >
                <span className="material-symbols-outlined text-3xl mr-2">arrow_back_ios</span>
              </button>
              <button
                onClick={(e) => navigateImage(e, 'next')}
                className="bg-white/10 hover:bg-white/20 backdrop-blur-md text-white w-14 h-14 rounded-full flex items-center justify-center transition-all pointer-events-auto shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:scale-110 border border-white/10"
              >
                <span className="material-symbols-outlined text-3xl ml-1">arrow_forward_ios</span>
              </button>
            </div>
          )}

          <div className="w-full h-full p-4 md:p-12 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <img
              src={activeImage}
              alt="Zoomed product view"
              className="max-w-full max-h-full object-contain rounded-xl drop-shadow-[0_0_50px_rgba(255,255,255,0.1)] select-none"
            />
          </div>

          {/* Lightbox Thumbnails */}
          {allImages.length > 1 && (
            <div className="absolute bottom-6 inset-x-0 flex justify-center gap-3 px-4 z-40" onClick={(e) => e.stopPropagation()}>
              {allImages.map((img, idx) => (
                <div
                  key={idx}
                  onClick={() => setActiveImage(img)}
                  className={`w-16 h-16 rounded-lg border-2 cursor-pointer transition-all overflow-hidden ${activeImage === img ? 'border-primary scale-110 shadow-[0_0_15px_rgba(255,153,0,0.5)]' : 'border-white/20 opacity-50 hover:opacity-100'
                    }`}
                >
                  <img src={img} alt={`thumb-${idx}`} className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </main>
  );
}
