import { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useStore } from './StoreContext';

const WishlistContext = createContext();

export function WishlistProvider({ children }) {
  const { store } = useStore();
  const [wishlist, setWishlist] = useState([]);
  const session = useAuth();

  useEffect(() => {
    if (session?.user && store?.id) {
      fetchWishlist(session.user.id);
    } else {
      setWishlist([]);
    }
  }, [session, store?.id]);

  const fetchWishlist = async (userId) => {
    if (!store?.id) return;
    const { data, error } = await supabase
      .from('wishlists')
      .select('product_id')
      .eq('user_id', userId)
      .eq('store_id', store.id);
      
    if (data && !error) {
      setWishlist(data.map(item => item.product_id));
    }
  };

  const toggleWishlist = async (productId) => {
    if (!session?.user || !store?.id) {
      alert("يرجى تسجيل الدخول أولاً لإضافة منتجات للمفضلة.");
      return;
    }

    const userId = session.user.id;
    const isWished = wishlist.includes(productId);

    if (isWished) {
      // Remove from DB
      await supabase.from('wishlists').delete().eq('user_id', userId).eq('product_id', productId).eq('store_id', store.id);
      setWishlist(prev => prev.filter(id => id !== productId));
    } else {
      // Add to DB
      await supabase.from('wishlists').insert([{ user_id: userId, product_id: productId, store_id: store.id }]);
      setWishlist(prev => [...prev, productId]);
    }
  };

  const isInWishlist = (productId) => {
    return wishlist.includes(productId);
  };

  return (
    <WishlistContext.Provider value={{ wishlist, toggleWishlist, isInWishlist }}>
      {children}
    </WishlistContext.Provider>
  );
}

export function useWishlist() {
  return useContext(WishlistContext);
}
