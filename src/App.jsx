import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { supabase } from './lib/supabase';
import Home from './pages/Home';
import Catalog from './pages/Catalog';
import Product from './pages/Product';
import Support from './pages/Support';
import Orders from './pages/Orders';
import Layout from './components/Layout';
import AdminLayout from './pages/admin/AdminLayout';
import Dashboard from './pages/admin/Dashboard';
import Products from './pages/admin/Products';
import WARequests from './pages/admin/WARequests';
import Auth from './pages/admin/Auth';
import UserAuth from './pages/UserAuth';
import ProtectedRoute from './components/ProtectedRoute';
import Favorites from './pages/Favorites';
import EmailVerified from './pages/EmailVerified';

// Admin Pages
import Coupons from './pages/admin/Coupons';
import Settings from './pages/admin/Settings';
import ShippingAdmin from './pages/admin/ShippingAdmin';
import ManageReviews from './pages/admin/ManageReviews';
import ManageBanners from './pages/admin/ManageBanners';
import Users from './pages/admin/Users';
import LoginLogs from './pages/admin/LoginLogs';
import BlockedIPs from './pages/admin/BlockedIPs';
import ManageContent from './pages/admin/ManageContent';
import SystemHealth from './pages/admin/SystemHealth';
import TenantManagement from './pages/admin/TenantManagement';

import { CartProvider } from './context/CartContext';
import { WishlistProvider } from './context/WishlistContext';

import Account from './pages/Account';
import PaymentSuccess from './pages/PaymentSuccess';
import PaymentFail from './pages/PaymentFail';
import TrackOrder from './pages/TrackOrder';
import { ToastProvider } from './context/ToastContext';

import { useAuth } from './hooks/useAuth';
import BannedScreen from './components/BannedScreen';
import IPBlockGuard from './components/IPBlockGuard';
import { useState, useEffect } from 'react';
import { syncUserProfile } from './services/authService';
import { SettingsProvider } from './context/SettingsContext';

import { StoreProvider, useStore } from './context/StoreContext';

function BannedGuard({ children }) {
  const session = useAuth();
  const { store } = useStore();
  const [banStatus, setBanStatus] = useState({ checked: false, banned: false, reason: '' });

  useEffect(() => {
    let subscription;
    
    async function checkBan() {
      if (session?.user && store?.id) {
        // Sync profile first (idempotent)
        const profile = await syncUserProfile(session.user, store.id);
        
        if (profile) {
          setBanStatus({ 
            checked: true, 
            banned: profile.is_banned, 
            reason: profile.ban_reason 
          });
        } else {
          setBanStatus({ checked: true, banned: false, reason: '' });
        }

        // إعداد الاشتراك اللحظي للتأكد من طرده فوراً عند الحظر
        const channel = supabase.channel(`ban_check_${session.user.id}`);
        
        subscription = channel
          .on(
            'postgres_changes',
            { 
              event: 'UPDATE', 
              schema: 'public', 
              table: 'user_profiles', 
              filter: `user_id=eq.${session.user.id}` 
            },
            (payload) => {
              if (payload.new) {
                setBanStatus({ 
                  checked: true, 
                  banned: payload.new.is_banned, 
                  reason: payload.new.ban_reason 
                });
              }
            }
          )
          .subscribe();
      } else if (session === null) {
        setBanStatus({ checked: true, banned: false, reason: '' });
      }
    }

    checkBan();

    return () => {
      if (subscription) supabase.removeChannel(subscription);
    };
  }, [session?.user?.id, store?.id]);

  if (session !== undefined && banStatus.checked && banStatus.banned) {
    return <BannedScreen reason={banStatus.reason} />;
  }

  return children;
}

function App() {
  useEffect(() => {
    if (window.location.hostname.endsWith('egparts.gt.tc')) {
      const newUrl = window.location.href.replace('egparts.gt.tc', 'egparts.store');
      window.location.replace(newUrl);
    }
  }, []);

  return (
    <IPBlockGuard>
    <StoreProvider>
    <SettingsProvider>
    <ToastProvider>
      <WishlistProvider>
        <CartProvider>
          <BannedGuard>
            <BrowserRouter>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="catalog" element={<Catalog />} />
                <Route path="product/:id" element={<Product />} />
                <Route path="support" element={<Support />} />
                <Route path="orders" element={<Orders />} />
                <Route path="auth" element={<UserAuth />} />
                <Route path="favorites" element={<Favorites />} />
                <Route path="account" element={<Account />} />
                <Route path="payment/success" element={<PaymentSuccess />} />
                <Route path="payment/fail" element={<PaymentFail />} />
                <Route path="track-order/:orderId" element={<TrackOrder />} />
                <Route path="email-verified" element={<EmailVerified />} />
              </Route>
              
              <Route path="/admin/auth" element={<Auth />} />
              <Route path="/admin" element={<ProtectedRoute><AdminLayout /></ProtectedRoute>}>
                <Route index element={<Dashboard />} />
                <Route path="products" element={<Products />} />
                <Route path="wa-requests" element={<WARequests />} />
                <Route path="coupons" element={<Coupons />} />
                <Route path="settings" element={<Settings />} />
                <Route path="shipping" element={<ShippingAdmin />} />
                <Route path="reviews" element={<ManageReviews />} />
                <Route path="banners" element={<ManageBanners />} />
                <Route path="users" element={<Users />} />
                <Route path="login-logs" element={<LoginLogs />} />
                <Route path="blocked-ips" element={<BlockedIPs />} />
                <Route path="content" element={<ManageContent />} />
                <Route path="health" element={<SystemHealth />} />
                <Route path="tenants" element={<TenantManagement />} />
              </Route>
            </Routes>
          </BrowserRouter>
          </BannedGuard>
        </CartProvider>
      </WishlistProvider>
    </ToastProvider>
    </SettingsProvider>
    </StoreProvider>
    </IPBlockGuard>
  );
}

export default App;
