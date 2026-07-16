import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useWishlist } from '../context/WishlistContext';
import { useCart } from '../context/CartContext';
import { useAuth } from '../hooks/useAuth';
import ProductSkeleton from '../components/ProductSkeleton';
import { useStore } from '../context/StoreContext';
import { useSettings } from '../context/SettingsContext';

export default function Favorites() {
  const { store } = useStore();
  const { settings } = useSettings();
  const [favoriteProducts, setFavoriteProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const { wishlist, toggleWishlist } = useWishlist();
  const { addToCart, cart } = useCart();
  const session = useAuth();

  useEffect(() => {
    if (session?.user && store?.id) {
      fetchFavoriteProducts();
    } else if (session === null) {
      setLoading(false);
    }
  }, [session, wishlist, store?.id]); // Refetch if wishlist or store changes

  const fetchFavoriteProducts = async () => {
    if (!store?.id) return;
    if (!wishlist || wishlist.length === 0) {
      setFavoriteProducts([]);
      setLoading(false);
      return;
    }
    
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .in('id', wishlist)
      .eq('store_id', store.id)
      .eq('is_active', true)
      .neq('is_deleted', true);
      
    if (data) setFavoriteProducts(data);

    setLoading(false);
  };

  if (!session?.user && !loading) {
    return (
    <main className="pb-[100px] px-6 max-w-[1200px] mx-auto min-h-screen text-center">
        <div className="mt-20">
          <span className="material-symbols-outlined text-[60px] text-red-500 mb-4 block">favorite_border</span>
          <h2 className="font-headline-lg text-on-surface mb-4">يرجى تسجيل الدخول لمشاهدة المفضلة</h2>
          <Link to="/auth" className="bg-primary text-on-primary px-8 py-3 rounded-xl font-bold hover:bg-primary-fixed inline-block">
            تسجيل الدخول
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="pb-[100px] px-6 max-w-[1200px] mx-auto min-h-screen" dir="rtl">
      <div className="flex items-center gap-3 mb-8">
        <span className="material-symbols-outlined text-[32px] text-red-500">favorite</span>
        <h1 className="font-headline-lg text-headline-lg text-on-surface">قائمة رغباتي</h1>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          Array(3).fill(0).map((_, i) => <ProductSkeleton key={`fav-skel-${i}`} />)
        ) : favoriteProducts.length > 0 ? (
          favoriteProducts.map((product) => {
            const oldPrice = product.old_price ? parseFloat(product.old_price) : 0;
            const currentPrice = parseFloat(product.price);
            const hasDiscount = oldPrice > currentPrice;
            const hd = settings?.hot_deals || {};
            const isHotDeal = hd.active && hd.product_ids?.includes(product.id) && (!hd.end_time || new Date(hd.end_time) > new Date());

            return (
              <div key={product.id} className="group relative bg-[#131921]/60 rounded-xl overflow-hidden border border-white/5 backdrop-blur-md transition-all duration-300 hover:-translate-y-2 hover:shadow-[0_15px_40px_rgba(255,153,0,0.15)] flex flex-col h-full">
                <Link to={`/product/${product.id}`} className="relative h-[240px] w-full bg-gradient-to-b from-white/5 to-transparent p-6 flex items-center justify-center overflow-hidden block">

                  {/* Hot Deal Badge */}
                  {isHotDeal && (
                    <div className="absolute top-4 left-4 z-20 bg-gradient-to-l from-amber-500 to-orange-600 text-white font-black text-[10px] px-2 py-1 rounded-md shadow-[0_0_15px_rgba(255,153,0,0.5)] flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">local_fire_department</span>
                      {hd.badge_text || 'عرض ناري'}
                    </div>
                  )}
                  
                  <button 
                    onClick={(e) => {
                      e.preventDefault();
                      toggleWishlist(product.id);
                    }}
                    className="absolute top-4 right-4 z-30 p-2 rounded-full backdrop-blur-md border border-red-500 text-red-500 bg-red-500/20 hover:bg-red-500/30 transition-all duration-300 shadow-[0_0_15px_rgba(0,0,0,0.5)]"
                  >
                    <span className="material-symbols-outlined text-[20px] fill-current">favorite</span>
                  </button>

                  <div className="relative z-0 group-hover:scale-110 transition-transform duration-300 ease-out w-full h-full flex items-center justify-center p-2">
                    {product.image ? (
                      <img alt={product.name} className="w-full h-full object-cover rounded-xl drop-shadow-[0_20px_20px_rgba(0,0,0,0.8)] filter brightness-110 contrast-125" src={product.image}/>
                    ) : (
                      <span className="material-symbols-outlined text-[64px] text-surface-variant">image</span>
                    )}
                  </div>
                </Link>
                
                <div className="p-6 flex-1 flex flex-col relative z-10">
                  <div className="mb-auto text-right">
                    <Link to={`/product/${product.id}`}>
                      <h3 className="text-base font-bold text-on-surface mb-2 line-clamp-2 hover:text-primary transition-colors">{product.name}</h3>
                    </Link>
                  </div>
                  <div className="flex flex-col mt-4 pt-4 border-t border-white/5">
                    <div className="flex items-center justify-between mb-4" dir="ltr">
                      <div className="flex flex-col text-left">
                        {hasDiscount && (
                          <span className="text-xs text-on-surface-variant line-through decoration-error/70 decoration-2 font-bold opacity-70 h-4">
                            EGP {oldPrice}
                          </span>
                        )}
                        {!hasDiscount && <span className="h-4"></span>}
                        <span className="text-xl font-black text-primary-container drop-shadow-[0_0_10px_rgba(255,153,0,0.2)]">
                          EGP {product.price}
                        </span>
                      </div>
                    </div>

                    <div className="w-full">
                      {cart.some(item => item.id === product.id) ? (
                        <button disabled className="w-full bg-surface-variant text-on-surface-variant font-bold py-3 rounded-lg cursor-not-allowed flex items-center justify-center gap-2 text-sm" dir="rtl">
                          <span className="material-symbols-outlined text-[18px]">check_circle</span>
                          موجود في السلة
                        </button>
                      ) : (
                        <button 
                          onClick={(e) => {
                            e.preventDefault();
                            addToCart(product);
                          }}
                          disabled={product.stock <= 0}
                          className="w-full bg-gradient-to-r from-[#E53935] to-[#FF5722] hover:from-[#D32F2F] hover:to-[#E64A19] text-white font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-sm shadow-[0_4px_15px_rgba(229,57,53,0.3)]"
                          dir="rtl"
                        >
                          <span className="material-symbols-outlined text-[20px]">add_shopping_cart</span>
                          <span className="text-sm">أضف للسلة</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="col-span-1 md:col-span-2 lg:col-span-3 py-20 text-center">
            <span className="material-symbols-outlined text-6xl text-surface-variant mb-4">heart_broken</span>
            <h3 className="text-xl text-on-surface-variant font-bold">لم تقم بإضافة أي منتجات للمفضلة بعد</h3>
            <Link to="/catalog" className="inline-block mt-4 text-primary hover:underline font-bold">تصفح المنتجات الآن</Link>
          </div>
        )}
      </section>
    </main>
  );
}
