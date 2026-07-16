import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useSEO } from '../hooks/useSEO';
import { useSettings } from '../context/SettingsContext';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '../context/ToastContext';
import ConfirmModal from '../components/ConfirmModal';
import fetchWithRetry, { RETRY_MESSAGES } from '../lib/fetchWithRetry';
import { Turnstile } from '@marsidev/react-turnstile';
import { useStore } from '../context/StoreContext';

export default function Account() {
  const session = useAuth();
  const navigate = useNavigate();
  const { store } = useStore();
  const { settings } = useSettings();
  const supportNumber = (settings?.whatsapp_number || '201122551272').replace(/[^\d]/g, '');
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'overview');
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  
  const { showToast } = useToast();
  
  const [profileData, setProfileData] = useState({
    name: '',
    phone: '',
    city: '',
    address: ''
  });
  const [savingProfile, setSavingProfile] = useState(false);
  const [shippingZones, setShippingZones] = useState([]);
  const [addresses, setAddresses] = useState([]);
  const [loadingAddresses, setLoadingAddresses] = useState(false);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);

  useSEO({
    title: 'حسابي | لوحة تحكم العميل',
    description: 'إدارة حسابك، تتبع طلباتك، وتعديل بياناتك الشخصية.'
  });

  useEffect(() => {
    if (session === null) {
      navigate('/auth');
    } else if (session && store?.id) {
      setProfileData({
        name: session.user?.user_metadata?.name || '',
        phone: session.user?.user_metadata?.phone || '',
        city: session.user?.user_metadata?.city || '',
        address: session.user?.user_metadata?.address || ''
      });
      fetchUserOrders();
      fetchUserAddresses();
      fetchNotifications();
    }
  }, [session, store?.id]);

  const fetchUserAddresses = async () => {
    if (!session?.user?.id) return;
    setLoadingAddresses(true);
    const { data } = await supabase
      .from('user_addresses')
      .select('*')
      .eq('user_id', session.user.id)
      .order('is_default', { ascending: false });
    if (data) setAddresses(data);
    setLoadingAddresses(false);
  };

  const hasShownPhoneToast = useRef(false);

  useEffect(() => {
    async function fetchShippingZones() {
      if (!store?.id) return;
      const { data } = await supabase.from('shipping_zones').select('*').eq('store_id', store.id).order('city_name', { ascending: true });
      if (data) setShippingZones(data);
    }
    fetchShippingZones();
  }, [store?.id]);

  useEffect(() => {
    if (session && !hasShownPhoneToast.current) {
      const phone = session.user?.user_metadata?.phone;
      if (!phone) {
        showToast('warning', 'قم بتأكيد رقم هاتفك من الاعدادات لتوثيق حسابك');
      }
      hasShownPhoneToast.current = true;
    }
  }, [session]);

  // Ensure shipping fee fallback if city not found
  const getShippingFeeForCity = (city) => {
    const zone = shippingZones.find(z => z.city_name === city);
    return zone ? zone.shipping_fee : 0;
  };
  const fetchNotifications = async () => {
    if (!session?.user?.id || !store?.id) return;
    setLoadingNotifications(true);
    try {
      const { data, error } = await supabase
        .from('user_notifications')
        .select('*')
        .eq('user_id', session.user.id)
        .eq('store_id', store.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setNotifications(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingNotifications(false);
    }
  };

  const fetchUserOrders = async () => {
    if (!session?.user?.id || !store?.id) return;
    setLoadingOrders(true);
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', session.user.id)
        .eq('store_id', store.id)
        .order('created_at', { ascending: false });

      if (data) setOrders(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingOrders(false);
    }
  };

  const [isOtpStep, setIsOtpStep] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpTimer, setOtpTimer] = useState(0);
  const [isSendingOtp, setIsSendingOtp] = useState(false);

  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [changePwOtp, setChangePwOtp] = useState('');
  const [changePwNewPassword, setChangePwNewPassword] = useState('');
  const [changePwConfirmPassword, setChangePwConfirmPassword] = useState('');
  const [changePwStep, setChangePwStep] = useState('init');
  const [changePwTimer, setChangePwTimer] = useState(0);
  const [changingPassword, setChangingPassword] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState(null);

  useEffect(() => {
    let interval;
    if (otpTimer > 0) {
      interval = setInterval(() => setOtpTimer(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [otpTimer]);

  useEffect(() => {
    let interval;
    if (changePwTimer > 0) {
      interval = setInterval(() => setChangePwTimer(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [changePwTimer]);

  const handleSendOtp = async () => {
    const phoneRegex = /^01[0125][0-9]{8}$/;
    if (!phoneRegex.test(profileData.phone)) {
      showToast('error', 'يرجى إدخال رقم هاتف مصري صحيح');
      return;
    }

    setIsSendingOtp(true);
    try {
      const formattedPhone = `2${profileData.phone}`;
      const response = await fetchWithRetry(`${import.meta.env.VITE_BACKEND_URL}/api/auth/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, user_id: session?.user?.id, turnstileToken }),
      }, () => {});
      const data = await response.json();
      if (data.success) {
        setIsOtpStep(true);
        setOtpTimer(60);
        showToast('success', 'تم إرسال كود التحقق بنجاح');
      } else {
        const errorMsg = typeof data.error === 'object' ? data.error.message : data.error;
        throw new Error(errorMsg || 'فشل إرسال الكود');
      }
    } catch (err) {
      showToast('error', err instanceof TypeError ? 'تعذر الاتصال بالخادم بعد عدة محاولات، برجاء المحاولة بعد قليل' : err.message);
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleVerifyOtpAndUpdate = async (e) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const formattedPhone = `2${profileData.phone}`;
      const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, code: otp }),
      });
      const verifyData = await response.json();

      if (verifyData.success) {
        const { error } = await supabase.auth.updateUser({
          data: {
            name: profileData.name,
            phone: profileData.phone,
            phone_verified: true
          }
        });
        if (error) throw error;
        showToast('success', 'تم تحديث البيانات وتوثيق الهاتف بنجاح');
        setIsOtpStep(false);
      } else {
        showToast('error', 'كود التحقق غير صحيح');
        setOtpTimer(prev => Math.min(prev * 2, 600));
      }
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    
    // Check if phone was changed
    const currentPhone = session.user?.user_metadata?.phone;
    const isPhoneChanged = profileData.phone !== currentPhone;

    if (isPhoneChanged) {
      await handleSendOtp();
      return;
    }

    // If only name changed, update directly
    setSavingProfile(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: {
          name: profileData.name,
          // phone remains same, but we send it anyway
          phone: profileData.phone,
          city: profileData.city,
          address: profileData.address
        }
      });
      if (error) throw error;
      showToast('success', 'تم تحديث بياناتك بنجاح');
    } catch (err) {
      showToast('error', 'حدث خطأ أثناء التحديث: ' + err.message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePwSendOtp = async () => {
    const phone = session.user?.user_metadata?.phone || profileData.phone;
    if (!phone) {
      showToast('error', 'لا يوجد رقم هاتف مسجل في حسابك');
      return;
    }
    setChangingPassword(true);
    try {
      const formattedPhone = `2${phone}`;
      const response = await fetchWithRetry(`${import.meta.env.VITE_BACKEND_URL}/api/auth/send-otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, user_id: session?.user?.id, purpose: 'forgot', turnstileToken }),
      }, () => {});
      const data = await response.json();
      if (data.success) {
        setChangePwStep('otp');
        setChangePwTimer(60);
      } else {
        const errorMsg = typeof data.error === 'object' ? data.error.message : data.error;
        throw new Error(errorMsg || 'فشل إرسال الكود');
      }
    } catch (err) {
      showToast('error', err instanceof TypeError ? 'تعذر الاتصال بالخادم بعد عدة محاولات، برجاء المحاولة بعد قليل' : err.message);
    } finally { setChangingPassword(false); }
  };

  const handleChangePwVerifyOtp = async (e) => {
    e.preventDefault();
    if (changingPassword) return;
    setChangingPassword(true);
    try {
      const phone = session.user?.user_metadata?.phone || profileData.phone;
      const formattedPhone = `2${phone}`;
      const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/auth/verify-otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, code: changePwOtp }),
      });
      const data = await response.json();
      if (data.success) {
        setChangePwStep('newPassword');
      } else {
        showToast('error', 'كود التحقق غير صحيح');
        setChangePwTimer(prev => Math.min(prev * 2, 600));
      }
    } catch (err) {
      showToast('error', err.message);
    } finally { setChangingPassword(false); }
  };

  const handleChangePwReset = async (e) => {
    e.preventDefault();
    if (changingPassword) return;
    if (changePwNewPassword !== changePwConfirmPassword) {
      showToast('error', 'كلمة المرور غير متطابقة');
      return;
    }
    if (changePwNewPassword.length < 6) {
      showToast('error', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل');
      return;
    }
    setChangingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: changePwNewPassword });
      if (error) throw error;
      showToast('success', 'تم تغيير كلمة المرور بنجاح');
      setIsChangingPassword(false);
      setChangePwStep('init');
      setChangePwOtp('');
      setChangePwNewPassword('');
      setChangePwConfirmPassword('');
    } catch (err) {
      showToast('error', 'فشل تغيير كلمة المرور: ' + err.message);
    } finally { setChangingPassword(false); }
  };

  const cancelChangePassword = () => {
    setIsChangingPassword(false);
    setChangePwStep('init');
    setChangePwOtp('');
    setChangePwNewPassword('');
    setChangePwConfirmPassword('');
  };

  const getStatusColor = (status) => {
    switch(status) {
      case 'pending': return 'bg-red-500/10 text-red-600 border-red-500/30';
      case 'processing': return 'bg-blue-500/20 text-blue-500 border-blue-500/50';
      case 'shipped': return 'bg-purple-500/20 text-purple-500 border-purple-500/50';
      case 'delivered': return 'bg-green-500/20 text-green-500 border-green-500/50';
      case 'cancelled': return 'bg-error/20 text-error border-error/50';
      default: return 'bg-surface-variant text-on-surface-variant';
    }
  };

  const getStatusText = (status) => {
    switch(status) {
      case 'pending': return 'قيد المراجعة';
      case 'processing': return 'جاري التجهيز';
      case 'shipped': return 'تم الشحن';
      case 'delivered': return 'تم التوصيل';
      case 'cancelled': return 'ملغي';
      default: return status || 'غير معروف';
    }
  };

  const handleSaveAddress = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
      user_id: session.user.id,
      title: formData.get('title'),
      phone: formData.get('phone'),
      city: formData.get('city'),
      address: formData.get('address'),
      is_default: formData.get('is_default') === 'on'
    };

    try {
      if (editingAddress) {
        const { error } = await supabase.from('user_addresses').update(data).eq('id', editingAddress.id);
        if (error) throw error;
        showToast('success', 'تم تحديث العنوان بنجاح ✅');
      } else {
        const { error } = await supabase.from('user_addresses').insert([data]);
        if (error) throw error;
        showToast('success', 'تم إضافة العنوان بنجاح ✅');
      }
      
      setIsAddressModalOpen(false);
      fetchUserAddresses();
    } catch (err) {
      console.error('Address save error:', err);
      showToast('error', 'فشل حفظ العنوان: ' + (err.message || 'خطأ غير معروف'));
    }
  };

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [addressToDelete, setAddressToDelete] = useState(null);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/auth');
  };

  const handleDeleteAddress = async () => {
    if (!addressToDelete) return;
    try {
      const { error } = await supabase.from('user_addresses').delete().eq('id', addressToDelete.id);
      if (error) throw error;
      showToast('success', 'تم حذف العنوان بنجاح 🗑️');
      fetchUserAddresses();
    } catch (err) {
      showToast('error', 'فشل في حذف العنوان');
    } finally {
      setIsDeleteModalOpen(false);
      setAddressToDelete(null);
    }
  };

  if (session === undefined) return <div className="min-h-screen flex items-center justify-center"><div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div></div>;
  if (session === null) return null;

  return (
    <>

    <div className="min-h-screen pt-12 md:pt-20 pb-20 px-4 md:px-6 max-w-7xl mx-auto flex flex-col md:flex-row gap-8" dir="rtl">
      
      {/* Sidebar Navigation */}
      <aside className="w-full md:w-80 flex-shrink-0 space-y-8">
        {/* User Card */}
        <div className="glass-panel p-6 rounded-[2.5rem] flex flex-col items-center text-center relative overflow-hidden group">
          <div className="absolute -top-10 -right-10 w-40 h-40 bg-primary/20 blur-[60px] rounded-full group-hover:bg-primary/30 transition-all duration-700"></div>
          <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-blue-500/10 blur-[50px] rounded-full"></div>
          
          <div className="w-28 h-28 bg-surface-container-high/40 rounded-full flex items-center justify-center border border-white/[0.03] shadow-[0_0_40px_rgba(220,38,38,0.2)] z-10 mb-6 relative">
            <div className="absolute inset-0 bg-primary/10 rounded-full animate-pulse"></div>
            <span className="material-symbols-outlined text-[64px] text-primary z-10">account_circle</span>
          </div>
          
          <h2 className="text-3xl font-black text-gray-900 dark:text-white z-10 tracking-tight">{profileData.name || 'مستخدم جديد'}</h2>
          <p className="text-gray-600 dark:text-gray-400 text-sm z-10 mb-6 font-medium opacity-80">{session.user.email}</p>
          
          {profileData.phone ? (
            <div className="bg-primary/20 text-primary border border-primary/30 px-6 py-2 rounded-2xl text-[11px] font-black z-10 flex items-center gap-2 shadow-[0_0_20px_rgba(220,38,38,0.15)]">
              <span className="material-symbols-outlined text-[16px] animate-pulse">verified</span>
              عميل موثق
            </div>
          ) : (
            <div className="bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 px-6 py-2 rounded-2xl text-[11px] font-black z-10 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">priority_high</span>
              الحساب غير موثق
            </div>
          )}
        </div>

        {/* Navigation Menu */}
        <div className="glass-panel rounded-[2.5rem] overflow-hidden flex flex-col p-3 gap-1 relative shadow-2xl">
          <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none"></div>
          {[
            { id: 'overview', icon: 'dashboard', label: 'نظرة عامة' },
            { id: 'orders', icon: 'local_shipping', label: 'طلباتي السابقة' },
            { id: 'addresses', icon: 'home_pin', label: 'عناويني المحفوظة' },
            { id: 'notifications', icon: 'notifications', label: 'الإشعارات' },
            { id: 'settings', icon: 'manage_accounts', label: 'إعدادات الحساب' }
          ].map(tab => (
            <button 
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-4 p-5 rounded-2xl text-right transition-all duration-300 font-black relative overflow-hidden group ${activeTab === tab.id ? 'bg-primary/20 text-primary' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white'}`}
            >
              {activeTab === tab.id && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full shadow-[0_0_15px_rgba(220,38,38,0.8)]"></div>}
              <span className={`material-symbols-outlined transition-transform duration-300 ${activeTab === tab.id ? 'scale-110' : 'group-hover:scale-110 opacity-70'}`}>{tab.icon}</span> 
              <span className="tracking-wide">{tab.label}</span>
            </button>
          ))}
          <div className="my-3 border-t border-white/[0.02] mx-4"></div>
          <button 
            onClick={handleLogout}
            className="flex items-center gap-4 p-5 rounded-2xl text-right transition-all duration-300 font-black text-error/80 hover:bg-error/10 hover:text-error group"
          >
            <span className="material-symbols-outlined group-hover:rotate-12 transition-transform">logout</span> 
            <span className="tracking-wide">تسجيل الخروج</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <section className="flex-1 glass-panel rounded-[3rem] p-6 md:p-10 min-h-[700px] overflow-hidden relative shadow-[0_20px_100px_rgba(0,0,0,0.4)] border-white/[0.02]">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 blur-[120px] rounded-full pointer-events-none"></div>
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-blue-600/5 blur-[100px] rounded-full pointer-events-none"></div>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="h-full"
          >
            {activeTab === 'overview' && (
              <div className="space-y-8">
                <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 pb-8 border-b border-on-surface/10 gap-6">
                  <div>
                    <h1 className="text-4xl font-black text-gray-900 dark:text-on-surface mb-3">مرحباً، {profileData.name.split(' ')[0] || 'يا غالي'}! 👋</h1>
                    <p className="text-gray-600 dark:text-on-surface-variant text-lg">سعداء برؤيتك مرة أخرى في متجرك المفضل.</p>
                  </div>
                  <div className="bg-primary/5 border border-primary/10 rounded-2xl p-4 flex items-center gap-4">
                    <div className="w-12 h-12 bg-primary rounded-xl flex items-center justify-center text-white">
                      <span className="material-symbols-outlined text-[28px]">account_balance_wallet</span>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 dark:text-on-surface-variant font-bold">رصيدك الحالي</p>
                      <p className="text-xl font-black text-gray-900 dark:text-on-surface" dir="ltr">0.00 EGP</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6">
                  <div className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/[0.02] p-6 md:p-8 rounded-[2.5rem] hover:bg-gray-100 dark:hover:bg-white/[0.05] transition-all duration-300 group shadow-lg">
                    <div className="w-14 h-14 bg-primary/20 text-primary rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                      <span className="material-symbols-outlined text-[32px]">receipt_long</span>
                    </div>
                    <h3 className="text-gray-600 dark:text-on-surface-variant text-sm font-black mb-1 opacity-70">إجمالي الطلبات</h3>
                    <p className="text-5xl font-black text-gray-900 dark:text-white">{orders.length}</p>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/5 p-8 rounded-[2.5rem] hover:bg-gray-100 dark:hover:bg-white/[0.05] transition-all duration-300 group shadow-lg">
                    <div className="w-14 h-14 bg-blue-500/20 text-blue-500 dark:text-blue-400 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                      <span className="material-symbols-outlined text-[32px]">pending_actions</span>
                    </div>
                    <h3 className="text-gray-600 dark:text-on-surface-variant text-sm font-black mb-1 opacity-70">قيد المعالجة</h3>
                    <p className="text-5xl font-black text-gray-900 dark:text-white">{orders.filter(o => o.status === 'pending').length}</p>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/5 p-8 rounded-[2.5rem] hover:bg-gray-100 dark:hover:bg-white/[0.05] transition-all duration-300 group shadow-lg">
                    <div className="w-14 h-14 bg-green-500/20 text-green-500 dark:text-green-400 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                      <span className="material-symbols-outlined text-[32px]">support_agent</span>
                    </div>
                    <h3 className="text-gray-600 dark:text-on-surface-variant text-sm font-black mb-1 opacity-70">الدعم الفني</h3>
                    <a href={`https://wa.me/${supportNumber}`} className="block mt-2 text-green-500 dark:text-green-400 font-bold hover:text-green-600 dark:hover:text-green-300 transition-colors">واتساب &rarr;</a>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'orders' && (
              <div className="space-y-8">
                <h2 className="text-3xl font-black text-gray-900 dark:text-on-surface">سجل طلباتي</h2>
                {loadingOrders ? (
                  <div className="py-20 text-center">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-on-surface-variant">جاري التحميل...</p>
                  </div>
                ) : orders.length === 0 ? (
                  <div className="text-center py-20 bg-gray-50 dark:bg-white/5 rounded-3xl">
                    <p className="text-xl text-gray-600 dark:text-on-surface-variant">لا توجد طلبات سابقة</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {orders.map(order => (
                      <div key={order.id} className="bg-white dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.02] rounded-[2rem] p-8 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:border-primary/20 transition-all group shadow-md dark:shadow-sm">
                        <div className="flex justify-between items-center mb-6">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-gray-100 dark:bg-white/5 rounded-xl flex items-center justify-center">
                              <span className="material-symbols-outlined text-primary">shopping_bag</span>
                            </div>
                            <div>
                              <p className="text-xs font-black text-primary tracking-widest uppercase">طلب رقم</p>
                              <p className="text-sm font-mono text-gray-900 dark:text-white">#{order.id.slice(-8).toUpperCase()}</p>
                            </div>
                          </div>
                          <span className={`px-4 py-1.5 rounded-full text-[10px] font-black tracking-widest uppercase border ${getStatusColor(order.status)}`}>
                            {getStatusText(order.status)}
                          </span>
                        </div>
                        <div className="flex justify-between items-end pt-6 border-t border-gray-200 dark:border-white/5">
                          <div className="space-y-1">
                            <p className="text-gray-500 dark:text-on-surface-variant text-xs font-bold opacity-60">تاريخ الطلب</p>
                            <p className="text-gray-900 dark:text-white font-medium">{new Date(order.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-gray-500 dark:text-on-surface-variant text-xs font-bold opacity-60 mb-1">إجمالي المبلغ</p>
                            <p className="text-2xl font-black text-primary">EGP {order.total}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'addresses' && (
              <div className="space-y-8">
                <div className="flex justify-between items-center">
                  <h2 className="text-3xl font-black text-gray-900 dark:text-on-surface">عناويني</h2>
                  <button onClick={() => { setEditingAddress(null); setIsAddressModalOpen(true); }} className="bg-primary text-on-primary px-6 py-2 rounded-xl font-bold">إضافة عنوان</button>
                </div>
                <div className="space-y-4">
                  {loadingAddresses ? (
                    <div className="py-10 text-center"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                  ) : addresses.length === 0 ? (
                    <div className="bg-gray-50 dark:bg-white/5 rounded-3xl p-10 text-center border border-gray-200 dark:border-white/5">
                      <p className="text-gray-600 dark:text-on-surface-variant">لم تقم بإضافة أي عناوين بعد</p>
                    </div>
                  ) : addresses.map(addr => (
                    <div key={addr.id} className="bg-white dark:bg-white/[0.03] border border-gray-200 dark:border-white/5 p-8 rounded-[2rem] flex justify-between items-center group hover:bg-gray-50 dark:hover:bg-white/[0.05] transition-all shadow-md dark:shadow-none">
                      <div className="flex items-center gap-6">
                        <div className="w-14 h-14 bg-gray-100 dark:bg-white/5 rounded-2xl flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
                          <span className="material-symbols-outlined text-[32px]">location_on</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-3 mb-1">
                            <h3 className="font-black text-gray-900 dark:text-white text-lg">{addr.title}</h3>
                            {addr.is_default && <span className="text-[10px] bg-primary/20 text-primary px-3 py-1 rounded-full font-black tracking-widest uppercase">افتراضي</span>}
                          </div>
                          <p className="text-sm text-gray-600 dark:text-on-surface-variant font-medium opacity-80">{addr.city} • {addr.address}</p>
                          <p className="text-xs text-primary mt-1 font-mono font-bold">{addr.phone}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { setEditingAddress(addr); setIsAddressModalOpen(true); }} className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-white/5 flex items-center justify-center text-gray-900 dark:text-white hover:bg-primary/20 hover:text-primary transition-all">
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                        <button onClick={() => { setAddressToDelete(addr); setIsDeleteModalOpen(true); }} className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-white/5 flex items-center justify-center text-gray-900 dark:text-white hover:bg-error/20 hover:text-error transition-all">
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="space-y-8">
                <h2 className="text-3xl font-black text-gray-900 dark:text-white">الإشعارات</h2>
                {loadingNotifications ? (
                  <div className="py-20 text-center">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-on-surface-variant">جاري التحميل...</p>
                  </div>
                ) : notifications.length === 0 ? (
                  <div className="text-center py-20 bg-gray-50 dark:bg-white/5 rounded-3xl">
                    <span className="material-symbols-outlined text-6xl text-gray-500 dark:text-on-surface-variant mb-4 block">notifications_off</span>
                    <p className="text-xl text-gray-600 dark:text-on-surface-variant">لا توجد إشعارات</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {notifications.map(n => (
                      <div key={n.id} className="bg-white dark:bg-white/[0.03] border border-gray-200 dark:border-white/5 p-6 rounded-[2rem] hover:bg-gray-50 dark:hover:bg-white/[0.05] hover:border-primary/20 transition-all group shadow-sm dark:shadow-none">
                        <div className="flex items-start gap-4">
                          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 ${n.type === 'order_update' ? 'bg-blue-500/20 text-blue-500 dark:text-blue-400' : 'bg-primary/20 text-primary'}`}>
                            <span className="material-symbols-outlined text-[24px]">{n.type === 'order_update' ? 'local_shipping' : 'notifications'}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-start gap-4">
                              <h3 className="font-black text-gray-900 dark:text-white text-sm">{n.title}</h3>
                              <span className="text-[10px] text-gray-500 dark:text-on-surface-variant whitespace-nowrap opacity-60">{new Date(n.created_at).toLocaleString('ar-EG')}</span>
                            </div>
                            <p className="text-sm text-gray-600 dark:text-on-surface-variant mt-1 opacity-80">{n.message}</p>
                            {n.order_id && (
                              <a href={`/track-order/${n.order_id}`} className="inline-flex items-center gap-1 mt-3 text-[11px] font-black text-primary hover:text-primary/80 transition-colors">
                                تتبع الطلب
                                <span className="material-symbols-outlined text-[14px]">arrow_back</span>
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'settings' && (
              <div className="space-y-8">
                <h2 className="text-3xl font-black text-gray-900 dark:text-white">الإعدادات</h2>
                
                {!isOtpStep ? (
                  <form onSubmit={handleUpdateProfile} className="bg-gray-50 dark:bg-white/5 p-8 rounded-3xl space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-black text-gray-600 dark:text-gray-400 mb-2">الاسم <span className="text-error">*</span></label>
                        <input 
                          type="text" value={profileData.name} 
                          onChange={e => setProfileData({...profileData, name: e.target.value})} 
                          className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 p-4 rounded-xl text-gray-900 dark:text-white outline-none focus:border-primary transition-all" 
                          placeholder="الاسم" 
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-black text-gray-600 dark:text-gray-400 mb-2">رقم الهاتف (واتساب) <span className="text-error">*</span></label>
                        <input 
                          type="tel" value={profileData.phone} 
                          onChange={e => setProfileData({...profileData, phone: e.target.value})} 
                          className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 p-4 rounded-xl text-gray-900 dark:text-white outline-none focus:border-primary transition-all font-bold" 
                          placeholder="الهاتف" 
                          dir="ltr"
                        />
                      </div>
                    </div>
                    
                    {profileData.phone !== session?.user?.user_metadata?.phone && (
                      <div className="flex justify-center">
                        <Turnstile 
                          siteKey="0x4AAAAAADF4VfOFuztpzj9u" 
                          onSuccess={(token) => setTurnstileToken(token)}
                          onExpire={() => setTurnstileToken(null)}
                          onError={() => setTurnstileToken(null)}
                        />
                      </div>
                    )}
                    
                    <button 
                      type="submit" disabled={savingProfile || isSendingOtp || (profileData.phone !== session?.user?.user_metadata?.phone && !turnstileToken)} 
                      className="bg-primary text-on-primary px-8 py-3 rounded-xl font-bold disabled:opacity-50 hover:bg-red-700 transition-all"
                    >
                      {savingProfile || isSendingOtp ? 'جاري المعالجة...' : 'حفظ التغييرات'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleVerifyOtpAndUpdate} className="bg-primary/5 p-8 rounded-3xl border border-primary/20 space-y-6 max-w-md mx-auto">
                    <div className="text-center space-y-2">
                      <h3 className="text-xl font-black text-gray-900 dark:text-white">تأكيد رقم الهاتف الجديد</h3>
                      <p className="text-sm text-gray-600 dark:text-on-surface-variant">أدخل الكود المرسل للرقم <span className="text-primary font-bold">{profileData.phone}</span> عبر واتساب</p>
                    </div>
                    <input 
                      type="text" required maxLength={6}
                      value={otp}
                      onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                      className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-2xl py-5 px-4 text-4xl font-black text-center text-primary focus:border-primary tracking-widest outline-none"
                      placeholder="000000"
                    />
                    <div className="flex flex-col gap-3">
                      <button 
                        disabled={savingProfile} type="submit"
                        className="w-full bg-green-500 hover:bg-green-600 text-white font-black py-4 rounded-xl shadow-lg transition-all"
                      >
                        {savingProfile ? 'جاري التحقق...' : 'تأكيد التغيير'}
                      </button>
                      <button 
                        type="button" onClick={() => setIsOtpStep(false)}
                        className="w-full bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-900 dark:text-white font-bold py-3 rounded-xl transition-all"
                      >
                        إلغاء
                      </button>
                    </div>
                    
                    <div className="text-center">
                      {otpTimer > 0 ? (
                        <p className="text-xs text-gray-600 dark:text-on-surface-variant">إعادة إرسال خلال {otpTimer} ثانية</p>
                      ) : (
                        <button type="button" onClick={handleSendOtp} className="text-xs text-primary hover:underline font-bold">إعادة إرسال الكود</button>
                      )}
                    </div>
                  </form>
                )}

                {/* Change Password Section */}
                <div className="bg-gray-50 dark:bg-white/5 p-8 rounded-3xl space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-primary text-2xl">lock</span>
                      <h3 className="text-xl font-black text-gray-900 dark:text-white">تغيير كلمة المرور</h3>
                    </div>
                    {!isChangingPassword && changePwStep === 'init' && (
                      <button onClick={() => setIsChangingPassword(true)} className="bg-primary/20 hover:bg-primary/30 text-primary px-6 py-2 rounded-xl font-bold text-sm transition-all">
                        تغيير كلمة المرور
                      </button>
                    )}
                  </div>

                  {isChangingPassword && changePwStep === 'init' && (
                    <div className="text-center py-4">
                      <p className="text-gray-600 dark:text-on-surface-variant mb-4">سيتم إرسال كود تحقق إلى رقم هاتفك المسجل عبر واتساب</p>
                      
                      <div className="flex justify-center mb-4">
                        <Turnstile 
                          siteKey="0x4AAAAAADF4VfOFuztpzj9u" 
                          onSuccess={(token) => setTurnstileToken(token)}
                          onExpire={() => setTurnstileToken(null)}
                          onError={() => setTurnstileToken(null)}
                        />
                      </div>

                      <div className="flex gap-3 justify-center">
                        <button onClick={handleChangePwSendOtp} disabled={changingPassword || !turnstileToken} className="bg-primary text-on-primary px-8 py-3 rounded-xl font-bold disabled:opacity-50 hover:bg-red-700 transition-all">
                          {changingPassword ? 'جاري الإرسال...' : 'إرسال كود التحقق'}
                        </button>
                        <button onClick={cancelChangePassword} className="bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-900 dark:text-white font-bold px-6 py-3 rounded-xl transition-all">إلغاء</button>
                      </div>
                    </div>
                  )}

                  {changePwStep === 'otp' && (
                    <form onSubmit={handleChangePwVerifyOtp} className="max-w-md mx-auto space-y-6">
                      <div className="text-center space-y-2">
                        <h3 className="text-xl font-black text-gray-900 dark:text-white">تأكيد الهوية</h3>
                        <p className="text-sm text-gray-600 dark:text-on-surface-variant">أدخل الكود المرسل لواتساب</p>
                      </div>
                      <input type="text" required maxLength={6} value={changePwOtp} onChange={e => setChangePwOtp(e.target.value.replace(/\D/g, ''))} className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-2xl py-5 px-4 text-4xl font-black text-center text-primary focus:border-primary tracking-widest outline-none" placeholder="000000" />
                      <div className="flex flex-col gap-3">
                        <button disabled={changingPassword} type="submit" className="w-full bg-green-500 hover:bg-green-600 text-white font-black py-4 rounded-xl shadow-lg transition-all">{changingPassword ? 'جاري التحقق...' : 'تأكيد الكود'}</button>
                        <button type="button" onClick={cancelChangePassword} className="w-full bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-900 dark:text-white font-bold py-3 rounded-xl transition-all">إلغاء</button>
                      </div>
                      <div className="text-center">
                        {changePwTimer > 0 ? (
                          <p className="text-xs text-gray-600 dark:text-on-surface-variant">إعادة إرسال خلال {changePwTimer} ثانية</p>
                        ) : (
                          <button type="button" onClick={handleChangePwSendOtp} className="text-xs text-primary hover:underline font-bold">إعادة إرسال الكود</button>
                        )}
                      </div>
                    </form>
                  )}

                  {changePwStep === 'newPassword' && (
                    <form onSubmit={handleChangePwReset} className="max-w-md mx-auto space-y-6">
                      <div className="text-center space-y-2">
                        <h3 className="text-xl font-black text-gray-900 dark:text-white">كلمة المرور الجديدة</h3>
                        <p className="text-sm text-gray-600 dark:text-on-surface-variant">أدخل كلمة المرور الجديدة لحسابك</p>
                      </div>
                      <div className="relative">
                        <input type={showNewPw ? 'text' : 'password'} required minLength={6} value={changePwNewPassword} onChange={e => setChangePwNewPassword(e.target.value)} className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 p-4 rounded-xl text-gray-900 dark:text-white outline-none focus:border-primary transition-all" placeholder="كلمة المرور الجديدة" dir="ltr" />
                        <button type="button" onClick={() => setShowNewPw(!showNewPw)} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                          <span className="material-symbols-outlined text-[20px]">{showNewPw ? 'visibility' : 'visibility_off'}</span>
                        </button>
                      </div>
                      <div className="relative">
                        <input type={showConfirmPw ? 'text' : 'password'} required minLength={6} value={changePwConfirmPassword} onChange={e => setChangePwConfirmPassword(e.target.value)} className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 p-4 rounded-xl text-gray-900 dark:text-white outline-none focus:border-primary transition-all" placeholder="تأكيد كلمة المرور" dir="ltr" />
                        <button type="button" onClick={() => setShowConfirmPw(!showConfirmPw)} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                          <span className="material-symbols-outlined text-[20px]">{showConfirmPw ? 'visibility' : 'visibility_off'}</span>
                        </button>
                      </div>
                      <div className="flex flex-col gap-3">
                        <button disabled={changingPassword} type="submit" className="w-full bg-primary text-on-primary font-black py-4 rounded-xl shadow-lg transition-all disabled:opacity-50 hover:bg-red-700">{changingPassword ? 'جاري الحفظ...' : 'حفظ كلمة المرور الجديدة'}</button>
                        <button type="button" onClick={cancelChangePassword} className="w-full bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-900 dark:text-white font-bold py-3 rounded-xl transition-all">إلغاء</button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </section>


      {/* Address Modal */}
      {isAddressModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md" dir="rtl">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            className="glass-panel rounded-[3rem] w-full max-w-xl p-10 shadow-2xl relative border-white/10"
          >
            <div className="absolute top-0 right-0 w-40 h-40 bg-primary/10 blur-[80px] rounded-full"></div>
            <div className="flex justify-between items-center mb-10 relative z-10">
              <div>
                <h2 className="text-3xl font-black text-gray-900 dark:text-white">{editingAddress ? 'تعديل العنوان' : 'إضافة عنوان جديد'}</h2>
                <p className="text-gray-600 dark:text-on-surface-variant text-sm mt-1">يرجى إدخال بيانات التوصيل بدقة</p>
              </div>
              <button onClick={() => setIsAddressModalOpen(false)} className="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center text-gray-500 dark:text-on-surface-variant hover:text-primary dark:hover:text-white transition-all">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveAddress} className="space-y-6 relative z-10">
              <div className="space-y-3">
                <label className="block text-[11px] font-black text-primary uppercase tracking-widest mr-2">مسمى العنوان</label>
                <input 
                  name="title" type="text" required defaultValue={editingAddress?.title || ''}
                  className="w-full bg-white dark:bg-white/[0.03] border border-gray-300 dark:border-white/10 rounded-2xl py-5 px-6 text-gray-900 dark:text-white focus:border-primary outline-none transition-all placeholder:text-gray-400 dark:placeholder:text-white/20"
                  placeholder="مثال: المنزل، العمل"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <label className="block text-[11px] font-black text-primary uppercase tracking-widest mr-2">رقم الهاتف</label>
                  <input 
                    name="phone" type="tel" required defaultValue={editingAddress?.phone || ''} dir="ltr"
                    className="w-full bg-white dark:bg-white/[0.03] border border-gray-300 dark:border-white/10 rounded-2xl py-5 px-6 text-gray-900 dark:text-white focus:border-primary outline-none transition-all font-mono text-lg"
                  />
                </div>
                <div className="space-y-3">
                  <label className="block text-[11px] font-black text-primary uppercase tracking-widest mr-2">المحافظة</label>
                  <div className="relative">
                    <select 
                      name="city" required defaultValue={editingAddress?.city || ''}
                      className="w-full bg-white dark:bg-white/[0.03] border border-gray-300 dark:border-white/10 rounded-2xl py-5 px-6 text-gray-900 dark:text-white focus:border-primary outline-none transition-all appearance-none cursor-pointer"
                    >
                      {shippingZones.map(z => <option key={z.id} value={z.city_name} className="bg-white dark:bg-surface text-gray-900 dark:text-white">{z.city_name}</option>)}
                    </select>
                    <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">expand_more</span>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <label className="block text-[11px] font-black text-primary uppercase tracking-widest mr-2">العنوان بالتفصيل</label>
                <input 
                  name="address" type="text" required defaultValue={editingAddress?.address || ''}
                  className="w-full bg-white dark:bg-white/[0.03] border border-gray-300 dark:border-white/10 rounded-2xl py-5 px-6 text-gray-900 dark:text-white focus:border-primary outline-none transition-all placeholder:text-gray-400 dark:placeholder:text-white/20"
                  placeholder="المنطقة، الشارع، رقم العقار"
                />
              </div>
              <div className="flex items-center gap-4 p-5 bg-gray-50 dark:bg-white/[0.02] rounded-2xl border border-gray-200 dark:border-white/5">
                <input 
                  name="is_default" type="checkbox" id="is_default" defaultChecked={editingAddress?.is_default}
                  className="w-6 h-6 accent-primary rounded-lg"
                />
                <label htmlFor="is_default" className="text-sm text-gray-600 dark:text-on-surface-variant font-bold cursor-pointer">تعيين كعنوان افتراضي للشحن</label>
              </div>
              <button 
                type="submit"
                className="w-full bg-primary hover:bg-red-700 text-white font-black py-5 rounded-2xl transition-all shadow-[0_10px_40px_rgba(220,38,38,0.3)] mt-6 text-lg"
              >
                حفظ بيانات العنوان
              </button>
            </form>
          </motion.div>
        </div>
      )}
      {/* Confirmation Modal */}
      <ConfirmModal 
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleDeleteAddress}
        title="حذف العنوان"
        message="هل أنت متأكد من رغبتك في حذف هذا العنوان؟ لا يمكن التراجع عن هذا الإجراء."
        confirmText="نعم، احذف"
        cancelText="تراجع"
        type="danger"
      />
    </div>
       </>
    );
  }
