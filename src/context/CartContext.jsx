import { createContext, useContext, useState, useEffect } from 'react';
import { useStore } from './StoreContext';

const CartContext = createContext();

export function CartProvider({ children }) {
  const { store } = useStore();
  const [cart, setCart] = useState(() => {
    try {
      const saved = localStorage.getItem('egparts_cart');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [isCartOpen, setIsCartOpen] = useState(false);
  const [cartBounce, setCartBounce] = useState(0);

  useEffect(() => {
    localStorage.setItem('egparts_cart', JSON.stringify(cart));
  }, [cart]);

  // Validate cart against server on mount/load
  useEffect(() => {
    async function validateCart() {
      if (cart.length === 0 || !store?.id) return;
      
      const ids = cart.map(item => item.id);
      const { data, error } = await import('../lib/supabase').then(m => m.supabase)
        .from('products')
        .select('id, is_active, is_deleted, stock_quantity, price')
        .in('id', ids)
        .eq('store_id', store.id);

      if (error || !data) return;

      setCart(prevCart => {
        let hasChanges = false;
        const newCart = prevCart.map(item => {
          const dbItem = data.find(d => d.id === item.id);
          // Remove if not found, deleted, or inactive
          if (!dbItem || dbItem.is_deleted || !dbItem.is_active) {
            hasChanges = true;
            return null;
          }
          let newQty = item.qty;
          const stock = dbItem.stock_quantity ?? 100;
          if (newQty > stock) {
            newQty = stock;
            hasChanges = true;
          }
          if (newQty <= 0) {
            hasChanges = true;
            return null;
          }
          // Update price in case it changed
          if (parseFloat(dbItem.price) !== parseFloat(item.price)) {
            hasChanges = true;
          }
          return { ...item, qty: newQty, stock_quantity: stock, price: dbItem.price };
        }).filter(Boolean);

        return hasChanges ? newCart : prevCart;
      });
    }

    validateCart();
  }, [store?.id]);

  const addToCart = (product) => {
    setCartBounce(prev => prev + 1); // تشغيل الأنميشن
    setTimeout(() => setCartBounce(prev => prev - 1), 600);
    setCart(prev => {
      const existing = prev.find(item => item.id === product.id);
      const stockLimit = product.stock_quantity !== undefined ? product.stock_quantity : 100;
      if (existing) {
        return prev.map(item => 
          item.id === product.id 
            ? { ...item, qty: Math.min(item.qty + 1, stockLimit) } 
            : item
        );
      }
      return [...prev, { ...product, qty: 1 }];
    });
    // تأثير بصري بسيط بدون فتح السلة
  };

  const updateQuantity = (id, newQty) => {
    if (newQty < 1) return removeFromCart(id);
    setCart(prev => prev.map(item => {
      if (item.id === id) {
        const stockLimit = item.stock_quantity !== undefined ? item.stock_quantity : 100;
        return { ...item, qty: Math.min(newQty, stockLimit) };
      }
      return item;
    }));
  };

  const removeFromCart = (id) => {
    setCart(prev => prev.filter(item => item.id !== id));
  };

  const clearCart = () => setCart([]);

  const getCartTotal = () => {
    return cart.reduce((total, item) => {
      const price = parseFloat(item.price || 0);
      return total + (price * item.qty);
    }, 0);
  };

  const getCartCount = () => {
    return cart.reduce((count, item) => count + item.qty, 0);
  };

  const toggleCart = () => setIsCartOpen(!isCartOpen);

  return (
    <CartContext.Provider value={{
      cart,
      addToCart,
      updateQuantity,
      removeFromCart,
      clearCart,
      getCartTotal,
      getCartCount,
      isCartOpen,
      setIsCartOpen,
      toggleCart,
      cartBounce
    }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  return useContext(CartContext);
}
