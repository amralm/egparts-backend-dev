import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useStore } from '../context/StoreContext';

export default function LiveSearch({ isMobile = false }) {
  const { store } = useStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);
  const navigate = useNavigate();

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!query.trim() || !store?.id) {
        setResults([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const { data, error } = await supabase
        .from('products')
        .select('id, name, image, price')
        .eq('store_id', store.id)
        .eq('is_active', true)
        .neq('is_deleted', true)
        .ilike('name', `%${query}%`)
        .limit(5);

      if (!error && data) {
        setResults(data);
        setIsOpen(true);
      }
      setIsLoading(false);
    }, 300); // 300ms delay

    return () => clearTimeout(timer);
  }, [query, store?.id]);

  const handleSelect = (productId) => {
    setIsOpen(false);
    setQuery('');
    navigate(`/product/${productId}`);
  };

  return (
    <div ref={wrapperRef} className={`relative ${isMobile ? 'w-full' : 'w-full max-w-md hidden md:block'}`}>
      <div className="relative flex items-center">
        <span className="material-symbols-outlined absolute right-4 text-on-surface-variant">search</span>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => { if (query.trim()) setIsOpen(true); }}
          placeholder="ابحث عن قطعة غيار (كمبروسر، فريون...)"
          className="w-full bg-white dark:bg-surface-container-high/50 backdrop-blur-md border border-gray-300 dark:border-white/10 text-gray-900 dark:text-white rounded-full py-2.5 pr-12 pl-4 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:focus:bg-surface-container-high transition-all shadow-sm dark:shadow-inner placeholder:text-gray-500 dark:placeholder:text-on-surface-variant/70 text-sm"
          dir="rtl"
        />
        {isLoading && (
          <div className="absolute left-4 w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
        )}
      </div>

      {/* Dropdown Results */}
      {isOpen && query.trim() && (
        <div className="absolute top-full right-0 mt-2 w-full bg-white/98 dark:bg-surface-container-high/95 backdrop-blur-2xl border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl dark:shadow-[0_10px_40px_rgba(0,0,0,0.6)] overflow-hidden z-[110] animate-fade-in" dir="rtl">
          {results.length > 0 ? (
            <div className="max-h-80 overflow-y-auto">
              {results.map((product) => (
                <div 
                  key={product.id}
                  onClick={() => handleSelect(product.id)}
                  className="flex items-center gap-3 p-3 hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer border-b border-gray-100 dark:border-white/5 transition-colors group"
                >
                  <div className="w-12 h-12 bg-white rounded-lg flex-shrink-0 flex items-center justify-center p-1 overflow-hidden border border-gray-200 dark:border-none shadow-sm dark:shadow-inner group-hover:scale-105 transition-transform">
                    {product.image ? (
                      <img src={product.image} alt={product.name} className="w-full h-full object-cover rounded-md" />
                    ) : (
                      <span className="material-symbols-outlined text-gray-400">image</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-bold text-gray-900 dark:text-white truncate group-hover:text-primary transition-colors">{product.name}</h4>
                    <p className="text-primary text-xs font-bold mt-1" dir="ltr">{product.price}</p>
                  </div>
                </div>
              ))}
              <div 
                onClick={() => { setIsOpen(false); navigate('/catalog'); }}
                className="p-3 text-center text-primary text-xs font-bold hover:bg-primary/10 cursor-pointer transition-colors"
              >
                عرض كل النتائج &rarr;
              </div>
            </div>
          ) : !isLoading ? (
            <div className="p-6 text-center text-gray-500 dark:text-on-surface-variant">
              <span className="material-symbols-outlined text-[48px] mb-2 opacity-50">search_off</span>
              <p className="text-sm font-bold text-gray-800 dark:text-white">لم نجد نتائج مطابقة لبحثك</p>
              <p className="text-xs mt-1">حاول البحث بكلمات مختلفة أو تصفح الكتالوج.</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
