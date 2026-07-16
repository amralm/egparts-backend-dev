import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { supabase } from '../../lib/supabase';

import { useStore } from '../../context/StoreContext';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export default function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { store, isSuspended, impersonatedStoreId, changeImpersonatedStore } = useStore();
  const [adminName, setAdminName] = useState('Admin');
  const [checking, setChecking] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [allStores, setAllStores] = useState([]);
  const [adminTheme, setAdminTheme] = useState(() => localStorage.getItem('admin_theme') || 'system');

  useEffect(() => {
    localStorage.setItem('admin_theme', adminTheme);
    document.documentElement.classList.add('admin-panel');
    
    const isDark = adminTheme === 'dark' || (adminTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    }

    return () => {
      document.documentElement.classList.remove('admin-panel');
    };
  }, [adminTheme]);

  useEffect(() => {
    async function checkAdmin() {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        navigate('/admin/auth');
        return;
      }

      // 1. Check Super Admin Role
      const { data: superAdmin } = await supabase
        .from('super_admins')
        .select('*')
        .eq('user_id', session.user.id)
        .maybeSingle();

      const isSuper = !!superAdmin;
      setIsSuperAdmin(isSuper);

      // 2. Check Store Admin Role if not Super Admin
      if (!isSuper) {
        const { data: storeAdmin } = await supabase
          .from('store_admins')
          .select('*')
          .eq('user_id', session.user.id)
          .maybeSingle();
        
        if (!storeAdmin) {
          await supabase.auth.signOut();
          navigate('/admin/auth?error=not_admin');
          return;
        }
      }

      // 3. Load all stores for switcher if Super Admin
      if (isSuper) {
        const { data: stores } = await supabase
          .from('stores')
          .select('id, name, subdomain')
          .order('name');
        if (stores) setAllStores(stores);
      }

      if (session.user.user_metadata.name) {
        setAdminName(session.user.user_metadata.name);
      } else if (session.user.email) {
        setAdminName(session.user.email.split('@')[0]);
      }
      setChecking(false);
    }
    checkAdmin();
  }, [navigate]);

  if (checking) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-primary"></div>
    </div>
  );

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/admin/auth');
  };

  const adminNavItems = [
    { name: 'Dashboard', path: '/admin', icon: 'dashboard' },
    { name: 'Products', path: '/admin/products', icon: 'inventory_2' },
    { name: 'Users', path: '/admin/users', icon: 'group' },
    { name: 'WA Orders', path: '/admin/wa-requests', icon: 'list_alt' },
    { name: 'Reviews', path: '/admin/reviews', icon: 'reviews' },
    { name: 'Banners', path: '/admin/banners', icon: 'gallery_thumbnail' },
    { name: 'Coupons', path: '/admin/coupons', icon: 'local_offer' },
    { name: 'Shipping', path: '/admin/shipping', icon: 'local_shipping' },
    { name: 'Login Logs', path: '/admin/login-logs', icon: 'login' },
    { name: 'Blocked IPs', path: '/admin/blocked-ips', icon: 'block' },
    { name: 'Health', path: '/admin/health', icon: 'health_and_safety' },
    { name: 'Content', path: '/admin/content', icon: 'edit_note' },
    { name: 'Settings', path: '/admin/settings', icon: 'settings' },
  ];

  if (isSuperAdmin) {
    adminNavItems.push({ name: 'Tenants', path: '/admin/tenants', icon: 'store' });
  }

  adminNavItems.push({ name: 'Storefront', path: '/', icon: 'storefront' });

  return (
    <div className="flex h-screen overflow-hidden bg-background text-on-surface" dir="ltr">
      {/* Sidebar Desktop */}
      <aside className="w-64 bg-surface-container-low border-r border-outline/20 hidden md:flex flex-col overflow-y-auto hide-scrollbar">
        <div className="p-6 border-b border-outline/20 shrink-0">
          <h1 className="text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-amber-600 font-['Space_Grotesk'] tracking-tight">EG-ADMIN</h1>
          
          {isSuperAdmin && (
            <div className="mt-4 space-y-1.5 bg-surface-container-high/40 p-3 rounded-xl border border-outline/10">
              <label className="text-[10px] font-black uppercase text-on-surface-variant/60 tracking-wider block">Store Switcher</label>
              <select
                value={impersonatedStoreId || store?.id || ''}
                onChange={(e) => changeImpersonatedStore(e.target.value)}
                className="w-full bg-surface border border-outline/20 rounded-lg px-2 py-1.5 text-xs text-on-surface focus:outline-none focus:border-primary transition-colors cursor-pointer"
              >
                <option value="">-- Active Store --</option>
                {allStores.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.subdomain})</option>
                ))}
              </select>
              {impersonatedStoreId && (
                <button
                  onClick={() => changeImpersonatedStore(null)}
                  className="w-full text-center text-[10px] text-red-500 hover:underline font-bold block pt-1"
                >
                  Reset Impersonation
                </button>
              )}
            </div>
          )}
        </div>
        <nav className="flex-1 p-4 space-y-2">
          {adminNavItems.map((item) => {
            const isActive = location.pathname === item.path || (item.path !== '/admin' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.name}
                to={item.path}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-lg transition-colors font-headline-md",
                  isActive 
                    ? "bg-primary/10 text-primary border border-primary/20" 
                    : "text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
                )}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                {item.name}
              </Link>
            );
          })}
        </nav>
        
        {/* Admin Info & Logout */}
        <div className="p-4 border-t border-outline/20 flex flex-col gap-3 shrink-0">
          <div className="flex bg-surface-container-high rounded-lg p-1 w-full justify-between items-center mb-2">
            <button onClick={() => setAdminTheme('light')} className={cn("p-2 flex-1 rounded-md transition-colors flex justify-center", adminTheme === 'light' ? 'bg-surface shadow text-on-surface' : 'text-on-surface-variant')} title="Light Mode">
              <span className="material-symbols-outlined text-[18px]">light_mode</span>
            </button>
            <button onClick={() => setAdminTheme('system')} className={cn("p-2 flex-1 rounded-md transition-colors flex justify-center", adminTheme === 'system' ? 'bg-surface shadow text-on-surface' : 'text-on-surface-variant')} title="System Default">
              <span className="material-symbols-outlined text-[18px]">desktop_windows</span>
            </button>
            <button onClick={() => setAdminTheme('dark')} className={cn("p-2 flex-1 rounded-md transition-colors flex justify-center", adminTheme === 'dark' ? 'bg-surface shadow text-on-surface' : 'text-on-surface-variant')} title="Dark Mode">
              <span className="material-symbols-outlined text-[18px]">dark_mode</span>
            </button>
          </div>
          <div className="flex items-center gap-3 px-2">
            <div className="w-10 h-10 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-lg border border-primary/30">
              {adminName.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-bold text-on-surface">{adminName}</p>
              <p className="text-[10px] text-on-surface-variant uppercase tracking-wider font-bold">
                {isSuperAdmin ? 'Super Administrator' : 'Tenant Admin'}
              </p>
            </div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-3 px-4 py-2 rounded-lg transition-colors text-error hover:bg-error/10 w-full text-right mt-2">
            <span className="material-symbols-outlined">logout</span>
            تسجيل خروج
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden relative">
        {/* Topbar Mobile */}
        <header className="md:hidden bg-surface-container-low border-b border-outline/20 p-4 flex justify-between items-center shrink-0">
          <h1 className="text-xl font-black bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-amber-600 font-['Space_Grotesk'] tracking-tight">EG-ADMIN</h1>
          <div className="flex gap-4 items-center">
            {isSuperAdmin && (
              <select
                value={impersonatedStoreId || store?.id || ''}
                onChange={(e) => changeImpersonatedStore(e.target.value)}
                className="bg-surface border border-outline/20 rounded px-1.5 py-1 text-xs text-on-surface focus:outline-none max-w-[120px] font-bold"
              >
                <option value="">-- Active --</option>
                {allStores.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <button onClick={() => setAdminTheme(adminTheme === 'dark' ? 'light' : 'dark')} className="text-on-surface-variant hover:text-on-surface">
              <span className="material-symbols-outlined">{adminTheme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
            </button>
            <Link to="/" className="text-primary" title="المتجر"><span className="material-symbols-outlined">storefront</span></Link>
            <button onClick={handleLogout} className="text-error" title="تسجيل خروج"><span className="material-symbols-outlined">logout</span></button>
          </div>
        </header>

        <main 
          id="admin-main-scroll"
          className="flex-1 overflow-y-auto"
          style={{ padding: 'var(--admin-pad-y) var(--admin-pad-x) var(--admin-pad-b) var(--admin-pad-x)' }}
        >
          {isSuspended && (
            <div className="bg-red-600/90 text-white font-bold p-4 mb-6 rounded-2xl border border-red-500/20 text-center shadow-lg animate-pulse" dir="rtl">
              ⚠️ تنبيه: انتهت صلاحية اشتراك متجرك وتم إيقافه مؤقتاً. لا يمكن للعملاء تصفح المنتجات أو تقديم طلبات جديدة. يرجى تجديد الاشتراك عبر التواصل مع المسؤول العام.
            </div>
          )}
          <Outlet />
        </main>
        
        {/* Mobile Nav */}
        <nav className="md:hidden fixed bottom-0 left-0 w-full z-50 bg-surface-container-low/90 backdrop-blur-2xl border-t border-outline/20">
          <div className="flex items-center gap-6 px-4 py-3 pb-6 overflow-x-auto hide-scrollbar">
            {adminNavItems.map((item) => {
               const isActive = location.pathname === item.path || (item.path !== '/admin' && location.pathname.startsWith(item.path));
               return (
                 <Link 
                   key={item.name} 
                   to={item.path} 
                   className={cn(
                     "flex flex-col items-center justify-center min-w-[64px] gap-1 transition-colors",
                     isActive ? "text-primary" : "text-on-surface-variant hover:text-on-surface"
                   )}
                 >
                   <span className="material-symbols-outlined text-[24px]">{item.icon}</span>
                   <span className="text-[10px] font-bold whitespace-nowrap">{item.name}</span>
                 </Link>
               );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
