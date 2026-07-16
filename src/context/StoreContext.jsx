import { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const StoreContext = createContext();

export function StoreProvider({ children }) {
  const [store, setStore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isSuspended, setIsSuspended] = useState(false);

  // Impersonation state for Super Admins
  const [impersonatedStoreId, setImpersonatedStoreId] = useState(() => {
    return localStorage.getItem('impersonated_store_id') || null;
  });

  const changeImpersonatedStore = async (storeId) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user?.id) {
        if (storeId) {
          const { data: logId, error } = await supabase.rpc('start_impersonation', {
            p_store_id: storeId,
            p_ip_address: 'unknown',
            p_user_agent: navigator.userAgent
          });
          if (error) throw error;
          
          if (logId) {
            localStorage.setItem('impersonation_log_id', logId);
          }
          localStorage.setItem('impersonated_store_id', storeId);
          setImpersonatedStoreId(storeId);
        } else {
          const logId = localStorage.getItem('impersonation_log_id');
          if (logId) {
            await supabase.rpc('stop_impersonation', { p_log_id: logId });
            localStorage.removeItem('impersonation_log_id');
          }
          localStorage.removeItem('impersonated_store_id');
          setImpersonatedStoreId(null);
        }
      }
    } catch (err) {
      console.error('Impersonation logging failed:', err);
    }
    window.location.reload();
  };

  useEffect(() => {
    async function resolveStore() {
      setLoading(true);
      try {
        // 1. Resolve subdomain & clean hostname
        const hostname = window.location.hostname.toLowerCase().trim();
        let cleanHostname = hostname;
        if (cleanHostname.startsWith('www.')) {
          cleanHostname = cleanHostname.substring(4);
        }

        let subdomain = 'egparts';

        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
          const parts = hostname.split('.');
          if (parts.length > 2) {
            subdomain = parts[0];
          } else {
            subdomain = 'egparts';
          }
        } else {
          const urlParams = new URLSearchParams(window.location.search);
          const qSub = urlParams.get('store');
          if (qSub) {
            localStorage.setItem('dev_store_subdomain', qSub);
            subdomain = qSub;
          } else {
            subdomain = localStorage.getItem('dev_store_subdomain') || 'egparts';
          }
        }

        subdomain = subdomain.toLowerCase().trim();
        // Redirect Vercel or Cloudflare Workers staging subdomains to the main store
        if (subdomain === 'egparts-frontend' || subdomain === 'egparts-backend' || subdomain === 'egparts-router') {
          subdomain = 'egparts';
        }

        // 2. Fetch Store Details
        let storeData = null;

        // If impersonating and user is admin/superadmin, load the impersonated store instead
        if (impersonatedStoreId) {
          const { data: impStore, error: impErr } = await supabase
            .from('stores')
            .select('*')
            .eq('id', impersonatedStoreId)
            .single();
          if (!impErr && impStore) {
            storeData = impStore;
          }
        }

        if (!storeData) {
          let orQuery = `subdomain.eq.${subdomain}`;
          if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            orQuery += `,custom_domain.eq.${hostname},custom_domain.eq.${cleanHostname}`;
          }

          const { data, error: fetchError } = await supabase
            .from('stores')
            .select('*')
            .or(orQuery)
            .single();

          if (fetchError || !data) {
            throw new Error('المتجر غير موجود');
          }
          storeData = data;
        }

        setStore(storeData);

        // 3. Check Subscription Status
        const expiresAt = new Date(storeData.subscription_expires_at);
        const now = new Date();
        const expired = expiresAt < now;

        if (!storeData.is_active || expired) {
          setIsSuspended(true);
        } else {
          setIsSuspended(false);
        }

      } catch (err) {
        console.error('Error resolving store:', err);
        setError(err.message || 'خطأ في التعرف على المتجر');
      } finally {
        setLoading(false);
      }
    }

    resolveStore();
  }, [impersonatedStoreId]);

  // If loading store details
  if (loading) {
    return (
      <div className="min-h-screen bg-[#060608] flex items-center justify-center text-white" dir="rtl">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-red-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="font-bold text-sm tracking-wider opacity-80">جاري تحميل المتجر...</p>
        </div>
      </div>
    );
  }

  // If store does not exist
  if (error || !store) {
    return (
      <div className="min-h-screen bg-[#060608] flex items-center justify-center p-6 text-white text-center" dir="rtl">
        <div className="max-w-md w-full bg-[#121218] border border-white/5 p-8 rounded-3xl space-y-6 shadow-2xl">
          <span className="material-symbols-outlined text-[64px] text-red-600">error</span>
          <h2 className="text-2xl font-black">المتجر غير موجود</h2>
          <p className="text-sm text-gray-400">عذراً، لم نتمكن من العثور على المتجر المطلوب. يرجى التأكد من الرابط والمحاولة مرة أخرى.</p>
          <a href={window.location.hostname.includes('egparts.gt.tc') ? 'https://egparts.gt.tc' : 'https://egparts.store'} className="block w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3.5 rounded-xl transition-all">
            الذهاب للرئيسية
          </a>
        </div>
      </div>
    );
  }

  // If store is suspended & not in admin panel
  const isAdminRoute = window.location.pathname.startsWith('/admin') || window.location.pathname.startsWith('/auth');
  if (isSuspended && !isAdminRoute) {
    return (
      <div className="min-h-screen bg-[#060608] flex items-center justify-center p-6 text-white text-center" dir="rtl">
        <div className="max-w-md w-full bg-[#121218] border border-white/5 p-8 rounded-3xl space-y-6 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-1/4 right-1/4 h-[2px] bg-gradient-to-r from-transparent via-red-600 to-transparent"></div>
          <span className="material-symbols-outlined text-[64px] text-amber-500 animate-pulse">lock</span>
          <h2 className="text-2xl font-black">المتجر متوقف مؤقتاً</h2>
          <p className="text-sm text-gray-400 leading-relaxed">
            عذراً، هذا المتجر ({store.name}) متوقف مؤقتاً لانتهاء فترة الاشتراك.
            <br />
            يرجى التواصل مع إدارة المتجر أو الدعم الفني لإعادة التفعيل.
          </p>
          <div className="pt-4 border-t border-white/5 flex flex-col gap-2">
            <a href="mailto:support@egparts.com" className="w-full bg-white/5 hover:bg-white/10 text-white border border-white/10 font-bold py-3.5 rounded-xl transition-all text-sm">
              التواصل مع الدعم الفني
            </a>
            <a href="/admin" className="text-xs text-gray-500 hover:underline">
              هل أنت مدير المتجر؟ قم بتسجيل الدخول للتجديد
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <StoreContext.Provider value={{ store, isSuspended, impersonatedStoreId, changeImpersonatedStore }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error('useStore must be used within a StoreProvider');
  }
  return context;
}
