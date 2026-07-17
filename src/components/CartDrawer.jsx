import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useCart } from '../context/CartContext';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../context/ToastContext';
import { useStore } from '../context/StoreContext';
import { useSettings } from '../context/SettingsContext';
import { motion, AnimatePresence } from 'framer-motion';
import { Turnstile } from '@marsidev/react-turnstile';
import fetchWithRetry, { RETRY_MESSAGES } from '../lib/fetchWithRetry';
import { TURNSTILE_SITE_KEY } from '../lib/turnstile';
import { useDevMode } from '../hooks/useDevMode';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://egparts-backend.onrender.com';

export default function CartDrawer() {
  const { cart, isCartOpen, toggleCart, removeFromCart, updateQuantity, getCartTotal, clearCart } = useCart();
  const session = useAuth();
  const devMode = useDevMode();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [checkoutStep, setCheckoutStep] = useState(1);
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');

  const [shippingZones, setShippingZones] = useState([]);
  const [shippingFee, setShippingFee] = useState(0);

  const [promoCode, setPromoCode] = useState('');
  const [discountObj, setDiscountObj] = useState(null);
  const [validatingPromo, setValidatingPromo] = useState(false);
  const [promoMessage, setPromoMessage] = useState({ text: '', type: '' });

  const [isCityDropdownOpen, setIsCityDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cod');
  const [turnstileToken, setTurnstileToken] = useState(null);

  const { store } = useStore();
  const { settings } = useSettings();

  const freeShippingThreshold = settings?.free_shipping_enabled !== false ? (settings?.free_shipping_threshold ?? 0) : null;
  const isVerified = session?.user?.user_metadata?.phone && session.user.user_metadata.phone === phone;

  useEffect(() => {
    if (isCartOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = 'unset';
    return () => { document.body.style.overflow = 'unset'; };
  }, [isCartOpen]);

  useEffect(() => {
    if (isCartOpen) {
      const draft = localStorage.getItem('cart_draft');
      if (draft) {
        try {
          const parsed = JSON.parse(draft);
          if (parsed.phone && !phone) setPhone(parsed.phone);
          if (parsed.city && !city) setCity(parsed.city);
          if (parsed.address && !address) setAddress(parsed.address);
          if (parsed.note && !note) setNote(parsed.note);
          if (parsed.checkoutStep) setCheckoutStep(parsed.checkoutStep);
        } catch (e) {}
      }
    }
  }, [isCartOpen]);

  useEffect(() => {
    if (isCartOpen) {
      localStorage.setItem('cart_draft', JSON.stringify({ phone, city, address, note, checkoutStep }));
    }
  }, [phone, city, address, note, checkoutStep, isCartOpen]);

  useEffect(() => {
    if (cart.length === 0 && checkoutStep !== 1) {
      setCheckoutStep(1);
    }
  }, [cart.length, checkoutStep]);

  useEffect(() => {
    async function fetchShippingZones() {
      if (!store?.id) return;
      const { data } = await supabase.from('shipping_zones').select('*').eq('store_id', store.id).order('city_name', { ascending: true });
      if (data && data.length > 0) {
        setShippingZones(data);
        if (!city) {
          setCity(data[0].city_name);
          setShippingFee(data[0].shipping_fee);
        }
      }
    }
    fetchShippingZones();
  }, [store?.id]);

  const [savedAddresses, setSavedAddresses] = useState([]);
  const [selectedAddressId, setSelectedAddressId] = useState('');

  useEffect(() => {
    async function fetchAddresses() {
      if (!session?.user || !isCartOpen) return;
      const { data } = await supabase.from('user_addresses').select('*').eq('user_id', session.user.id).order('is_default', { ascending: false });
      if (data && data.length > 0) {
        setSavedAddresses(data);
        const defaultAddr = data.find(a => a.is_default) || data[0];
        setSelectedAddressId(defaultAddr.id);
        if (!phone) setPhone(defaultAddr.phone);
        if (!city) setCity(defaultAddr.city);
        if (!address) setAddress(defaultAddr.address);
      }
    }
    fetchAddresses();
  }, [session, isCartOpen]);

  useEffect(() => {
    async function fetchProfile() {
      if (!session?.user || !isCartOpen || savedAddresses.length > 0 || !store?.id) return;
      const { data: profile } = await supabase.from('user_profiles').select('*').eq('user_id', session.user.id).eq('store_id', store.id).single();
      if (profile) {
        if (profile.phone && !phone) setPhone(profile.phone);
        if (profile.address && !address) setAddress(profile.address);
        if (profile.city && !city) setCity(profile.city);
      }
    }
    fetchProfile();
  }, [session, isCartOpen, savedAddresses, store?.id]);

  useEffect(() => {
    if (city && shippingZones.length > 0) {
      const exact = shippingZones.find(z => z.city_name === city);
      if (exact) setShippingFee(exact.shipping_fee);
      else {
        const partial = shippingZones.find(z => city.includes(z.city_name) || z.city_name.includes(city));
        if (partial) {
          setCity(partial.city_name);
          setShippingFee(partial.shipping_fee);
        } else {
          setCity('محافظة أخرى');
          const fallback = shippingZones.find(z => z.city_name === 'محافظة أخرى');
          if (fallback) setShippingFee(fallback.shipping_fee);
        }
      }
    }
  }, [city, shippingZones]);

  const subtotal = getCartTotal();
  const isFreeShipping = freeShippingThreshold !== null && (freeShippingThreshold === 0 || subtotal >= freeShippingThreshold);
  const effectiveShippingFee = isFreeShipping ? 0 : shippingFee;
  const discountAmount = discountObj ? (discountObj.percentage > 0 ? (subtotal * discountObj.percentage / 100) : discountObj.amount) : 0;
  const totalAmount = subtotal - discountAmount + effectiveShippingFee;

  const handleApplyPromo = async () => {
    if (!promoCode.trim()) return;
    setValidatingPromo(true);
    setPromoMessage({ text: '', type: '' });

    try {
      const { data, error } = await supabase.from('coupons').select('*').eq('code', promoCode.trim().toUpperCase()).eq('is_active', true).eq('store_id', store.id).single();
      if (error || !data) {
        setPromoMessage({ text: 'كود الخصم غير صحيح أو غير مفعّل', type: 'error' });
        setDiscountObj(null);
      } else if (data.expiry_date && new Date(data.expiry_date) < new Date()) {
        setPromoMessage({ text: 'انتهت صلاحية هذا الكود', type: 'error' });
        setDiscountObj(null);
      } else if (data.max_uses > 0 && data.used_count >= data.max_uses) {
        setPromoMessage({ text: 'تم تجاوز الحد الأقصى لاستخدام الكود', type: 'error' });
        setDiscountObj(null);
      } else if (data.min_order_value > 0 && subtotal < data.min_order_value) {
        setPromoMessage({ text: `الحد الأدنى للطلب هو EGP ${data.min_order_value}`, type: 'error' });
        setDiscountObj(null);
      } else {
        showToast('success', 'تم تطبيق كود الخصم بنجاح');
        setDiscountObj({ percentage: data.discount_percentage || 0, amount: data.discount_amount || 0, code: data.code, id: data.id });
      }
    } catch (err) {
      setPromoMessage({ text: 'خطأ في التحقق من الكود', type: 'error' });
    }
    setValidatingPromo(false);
  };

  const [isVerificationModalOpen, setIsVerificationModalOpen] = useState(false);
  const [isOtpStep, setIsOtpStep] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpTimer, setOtpTimer] = useState(0);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [sendingStatus, setSendingStatus] = useState(0);
  const statusMessages = ['جاري الانتظار...', 'جاري الاتصال بواتساب...', 'جاري التحقق...', 'جاري تشفير الاتصال...'];

  useEffect(() => {
    let interval;
    if (otpTimer > 0) interval = setInterval(() => setOtpTimer(prev => prev - 1), 1000);
    return () => clearInterval(interval);
  }, [otpTimer]);

  useEffect(() => {
    if (!isSendingOtp) { setSendingStatus(0); return; }
    const interval = setInterval(() => { setSendingStatus(prev => (prev + 1) % statusMessages.length); }, 1500);
    return () => clearInterval(interval);
  }, [isSendingOtp]);

  const handleSendOtp = async () => {
    const phoneRegex = /^01[0125][0-9]{8}$/;
    if (!phoneRegex.test(phone)) {
      showToast('error', 'برجاء إدخال رقم هاتف مصري صحيح');
      return;
    }

    setIsSendingOtp(true);
    try {
      const formattedPhone = `2${phone}`;
      const response = await fetchWithRetry(`${BACKEND_URL}/api/auth/send-otp`, {
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
        console.error('OTP Send Failure:', data);
        const errorMsg = typeof data.error === 'object' ? data.error.message : data.error;
        throw new Error(errorMsg || 'فشل إرسال الكود');
      }
    } catch (err) {
      showToast('error', err instanceof TypeError ? 'تعذر الاتصال بالخادم بعد عدة محاولات، برجاء المحاولة بعد قليل' : err.message);
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleVerifyOtpAndCheckout = async (e) => {
    e.preventDefault();
    if (loading) return;

    setLoading(true);
    try {
      const formattedPhone = `2${phone}`;
      const response = await fetch(`${BACKEND_URL}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, code: otp }),
      });
      const verifyData = await response.json();

      if (verifyData.success) {
        if (session?.user) {
          await supabase.auth.updateUser({
            data: { phone: phone, phone_verified: true }
          });
        }
        await completeOrder();
      } else {
        showToast('error', 'كود التحقق غير صحيح');
        setOtpTimer(prev => Math.min(prev * 2, 600));
      }
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleValidationAndNext = () => {
    if (checkoutStep === 1) {
      setCheckoutStep(2);
      return;
    }
    if (checkoutStep === 2) {
      if (!session?.user) {
        showToast('error', 'يرجى تسجيل الدخول أولاً لتتمكن من إتمام الطلب');
        navigate('/auth');
        toggleCart();
        return;
      }
      const phoneRegex = /^01[0125][0-9]{8}$/;
      if (!phone) { showToast('error', 'يرجى إدخال رقم الهاتف'); return; }
      if (!phoneRegex.test(phone)) { showToast('error', 'برجاء إدخال رقم هاتف مصري صحيح'); return; }
      if (!city) { showToast('error', 'يرجى اختيار المحافظة'); return; }
      if (!address) { showToast('error', 'يرجى إدخال العنوان التفصيلي'); return; }
      
      setCheckoutStep(3);
      return;
    }
  };

  const handlePlaceOrder = async () => {
    if (loading) return;

    if (!isVerified) {
      setIsVerificationModalOpen(true);
      return;
    }

    await completeOrder();
  };

  const completeOrder = async () => {
    if (loading) return;
    setLoading(true);
    
    const idempotencyKey = crypto.randomUUID();

    try {
      const { data: rpcResult, error: rpcError } = await supabase.rpc('create_order_atomic', {
        p_user_id: session?.user?.id || null,
        p_items: cart.map(item => ({ id: item.id, qty: item.qty })),
        p_phone: phone,
        p_city: city,
        p_address: address,
        p_customer_note: note,
        p_payment_method: paymentMethod,
        p_coupon_code: discountObj?.code || null,
        p_idempotency_key: idempotencyKey,
        p_auth_source: session?.user?.app_metadata?.provider || 'otp',
        p_metadata: { user_agent: navigator.userAgent, platform: navigator.platform },
        p_store_id: store.id
      });

      if (rpcError) {
        if (rpcError.code === '23505') { showToast('warning', 'هذا الطلب مسجل لدينا بالفعل.'); return; }
        throw rpcError;
      }

      if (rpcResult && rpcResult.id) {
        localStorage.setItem('last_order_timestamp', Date.now().toString());
        localStorage.removeItem('cart_draft');
        setCheckoutStep(1);
        setIsVerificationModalOpen(false);
        clearCart();
        toggleCart();
        navigate(`/payment/success?method=${paymentMethod}&orderId=${rpcResult.id}`);
      }
    } catch (err) {
      console.error('Checkout error:', err);
      showToast('error', err.message || 'عذراً، فشل تسجيل الطلب.');
    } finally {
      setLoading(false);
    }
  };

  if (!isCartOpen) return null;

  return (
    <AnimatePresence>
      {isCartOpen && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] cursor-pointer" onClick={toggleCart} />

          <motion.div
            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            className="fixed top-0 left-0 h-full w-full sm:w-[480px] bg-surface border-r border-white/5 z-[210] flex flex-col shadow-[20px_0_100px_rgba(0,0,0,0.9)] overflow-hidden"
            dir="rtl"
          >
            {/* Header */}
            <div className="flex flex-col border-b border-white/5 bg-surface-container/20 shrink-0">
              <div className="flex items-center justify-between p-6 pb-4">
                <div className="flex items-center gap-4">
                  {checkoutStep > 1 && (
                    <button onClick={() => setCheckoutStep(prev => prev - 1)} className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors">
                      <span className="material-symbols-outlined text-[20px]">arrow_forward</span>
                    </button>
                  )}
                  <div>
                    <h2 className="font-bold text-xl text-gray-900 dark:text-white">إتمام الطلب</h2>
                    <p className="text-gray-600 dark:text-gray-400 text-xs">لديك {cart.length} منتجات</p>
                  </div>
                </div>
                <button onClick={toggleCart} className="text-on-surface-variant hover:text-red-500 transition-all p-2 rounded-xl hover:bg-red-500/10">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {/* Progress Bar */}
              {cart.length > 0 && (
                <div className="px-6 pb-4">
                  <div className="flex justify-between relative">
                    <div className="absolute top-1/2 left-0 right-0 h-[2px] bg-white/10 -translate-y-1/2 z-0" />
                    {[ 
                      { step: 1, label: 'السلة', icon: 'shopping_cart' },
                      { step: 2, label: 'الشحن', icon: 'local_shipping' },
                      { step: 3, label: 'الدفع', icon: 'credit_card' }
                    ].map((s) => {
                      const isActive = checkoutStep === s.step;
                      const isCompleted = checkoutStep > s.step;
                      return (
                        <div key={s.step} className="relative z-10 flex flex-col items-center gap-1.5">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                            isCompleted ? 'bg-green-500 text-white' : 
                            isActive ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-surface-container text-on-surface-variant border border-white/10'
                          }`}>
                            <span className="material-symbols-outlined text-[16px]">{isCompleted ? 'check' : s.icon}</span>
                          </div>
                          <span className={`text-[10px] font-bold ${isActive || isCompleted ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>{s.label}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 custom-scrollbar relative">
              {cart.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mb-6">
                    <span className="material-symbols-outlined text-[48px] text-surface-variant">shopping_cart_off</span>
                  </div>
                  <h3 className="text-xl font-bold text-on-surface mb-2">السلة فارغة حالياً</h3>
                  <button onClick={() => { toggleCart(); navigate('/catalog'); }} className="bg-primary text-on-primary px-8 py-3 rounded-xl font-black mt-4">
                    تصفح الكتالوج الآن
                  </button>
                </div>
              ) : (
                <AnimatePresence mode="wait">
                  {checkoutStep === 1 && (
                    <motion.div key="step1" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="space-y-4">
                      {cart.map((item) => (
                        <div key={item.id} className="bg-surface-container/30 border border-white/5 rounded-2xl p-4 flex gap-4">
                          <div className="w-20 h-20 bg-white/5 rounded-xl flex items-center justify-center overflow-hidden shrink-0">
                            {item.image ? <img src={item.image} alt={item.name} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined">image</span>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-start gap-2 mb-1">
                              <h4 className="text-sm font-bold text-on-surface truncate">{item.name}</h4>
                              <button onClick={() => removeFromCart(item.id)} className="text-on-surface-variant/40 hover:text-red-500 transition-colors">
                                <span className="material-symbols-outlined text-[18px]">delete</span>
                              </button>
                            </div>
                            <p className="text-xs text-primary font-black mb-3">EGP {item.price.toLocaleString()}</p>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center bg-gray-100 dark:bg-black/40 rounded-lg p-1 border border-gray-200 dark:border-white/10">
                                <button disabled={item.qty <= 1} onClick={() => updateQuantity(item.id, item.qty - 1)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-900 dark:text-white disabled:opacity-30"><span className="material-symbols-outlined text-[16px]">remove</span></button>
                                <span className="w-10 text-center text-sm font-bold text-gray-900 dark:text-white">{item.qty}</span>
                                <button disabled={item.stock_quantity !== undefined && item.qty >= item.stock_quantity} onClick={() => updateQuantity(item.id, item.qty + 1)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-900 dark:text-white disabled:opacity-30"><span className="material-symbols-outlined text-[16px]">add</span></button>
                              </div>
                              <p className="text-sm font-black text-gray-900 dark:text-white" dir="ltr">EGP {(item.price * item.qty).toLocaleString()}</p>
                            </div>
                          </div>
                        </div>
                      ))}

                      {/* Coupon */}
                      <div className="mt-6 pt-6 border-t border-white/5">
                        <label className="block text-[11px] font-black text-gray-600 dark:text-gray-400 uppercase mb-2 tracking-wider">هل لديك كوبون خصم؟</label>
                        <div className="flex gap-2">
                          <input type="text" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} placeholder="أدخل الكود هنا..." className="flex-1 bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-xl px-4 py-3 text-sm text-gray-900 dark:text-white focus:border-primary uppercase font-mono" />
                          <button onClick={handleApplyPromo} disabled={validatingPromo || !promoCode} className="bg-primary/10 hover:bg-primary/20 text-primary px-5 py-3 rounded-xl text-sm font-bold disabled:opacity-50 border border-primary/20">تطبيق</button>
                        </div>
                        {promoMessage.text && <p className={`text-[11px] mt-2 font-bold px-2 ${promoMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>{promoMessage.text}</p>}
                      </div>
                    </motion.div>
                  )}

                  {checkoutStep === 2 && (
                    <motion.div key="step2" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
                      {savedAddresses.length > 0 && (
                        <div className="mb-2">
                          <label className="block text-[10px] font-black text-on-surface-variant mb-2 tracking-wider">استخدام عنوان محفوظ</label>
                          <div className="flex flex-col gap-1.5">
                            <button type="button" onClick={() => { setSelectedAddressId(''); setPhone(session?.user?.user_metadata?.phone || ''); setAddress(''); }} className={`text-right px-3 py-2 rounded-lg text-[11px] transition-all border ${!selectedAddressId ? 'bg-primary/20 border-primary/40 text-primary font-bold' : 'bg-black/30 border-white/5 text-on-surface-variant hover:bg-white/5'}`}>
                              <span className="material-symbols-outlined text-[14px] align-middle ml-1">edit_note</span> إدخال يدوي
                            </button>
                            {savedAddresses.map(addr => {
                              const isSelected = selectedAddressId === addr.id;
                              return (
                                <button key={addr.id} type="button" onClick={() => { setPhone(addr.phone); setCity(addr.city); setAddress(addr.address); setSelectedAddressId(addr.id); const zone = shippingZones.find(z => z.city_name === addr.city); if (zone) setShippingFee(zone.shipping_fee); }} className={`text-right px-3 py-2.5 rounded-lg transition-all border ${isSelected ? 'bg-primary/20 border-primary/40' : 'bg-black/30 border-white/5 hover:bg-white/5 hover:border-white/20'}`}>
                                  <div className="flex items-center gap-1.5 mb-1"><span className="material-symbols-outlined text-[14px] text-primary">location_on</span><span className={`text-xs font-bold ${isSelected ? 'text-primary' : 'text-on-surface-variant'}`}>{addr.title}</span></div>
                                  <p className="text-[10px] text-on-surface-variant/60 truncate">{addr.city} • {addr.address}</p>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="block text-[11px] font-black text-gray-600 dark:text-gray-400 uppercase mb-1.5 tracking-wider">رقم الهاتف <span className="text-red-500">*</span></label>
                        <input type="tel" required value={phone} onChange={e => setPhone(e.target.value)} className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:border-primary font-mono text-left" placeholder="01xxxxxxxxx" dir="ltr" />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-black text-gray-600 dark:text-gray-400 uppercase mb-1.5 tracking-wider">المحافظة <span className="text-red-500">*</span></label>
                          <div className="relative">
                            <button type="button" onClick={() => setIsCityDropdownOpen(!isCityDropdownOpen)} className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white text-right flex items-center justify-between text-sm font-bold">
                              <span className="truncate">{city || 'اختر'}</span>
                              <span className="material-symbols-outlined text-[18px]">expand_more</span>
                            </button>
                            {isCityDropdownOpen && (
                              <div className="absolute bottom-full mb-2 left-0 right-0 bg-white dark:bg-surface-container border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl z-50 max-h-48 overflow-y-auto custom-scrollbar">
                                {shippingZones.map(zone => (
                                  <button key={zone.id} type="button" onClick={() => { setCity(zone.city_name); setShippingFee(zone.shipping_fee); setIsCityDropdownOpen(false); }} className="w-full px-4 py-3 text-right text-sm text-gray-900 dark:text-white hover:bg-primary/10 dark:hover:bg-primary/20 hover:text-primary transition-all flex justify-between items-center">
                                    <span className="text-[10px] text-green-600 dark:text-green-500 font-mono">+{zone.shipping_fee}</span><span>{zone.city_name}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <div>
                          <label className="block text-[11px] font-black text-gray-600 dark:text-gray-400 uppercase mb-1.5 tracking-wider">العنوان التفصيلي <span className="text-red-500">*</span></label>
                          <input type="text" required value={address} onChange={e => setAddress(e.target.value)} className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:border-primary text-sm" placeholder="الشارع، رقم العمارة..." />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-black text-gray-600 dark:text-gray-400 uppercase mb-1.5 tracking-wider">ملاحظات (اختياري)</label>
                        <textarea value={note} onChange={e => setNote(e.target.value)} className="w-full bg-white dark:bg-black/40 border border-gray-300 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:border-primary text-sm resize-none h-20" placeholder="أي تفاصيل إضافية لمندوب الشحن..." />
                      </div>
                    </motion.div>
                  )}

                  {checkoutStep === 3 && (
                    <motion.div key="step3" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
                      <div>
                        <h3 className="text-sm font-bold text-on-surface mb-4">طريقة الدفع</h3>
                        <div className="grid grid-cols-2 gap-3">
                          <button type="button" onClick={() => setPaymentMethod('cod')} className={`flex flex-col items-center justify-center gap-2 py-4 rounded-xl border transition-all text-sm font-bold ${paymentMethod === 'cod' ? 'border-primary bg-primary/10 text-primary shadow-[0_0_15px_rgba(220,38,38,0.15)]' : 'border-white/5 bg-black/40 text-on-surface-variant hover:border-white/20 hover:bg-white/5'}`}>
                            <span className="material-symbols-outlined text-[24px]">payments</span>
                            عند الاستلام
                          </button>
                          <button type="button" disabled className="relative flex flex-col items-center justify-center gap-2 py-4 rounded-xl border border-white/5 bg-black/20 text-on-surface-variant/40 cursor-not-allowed text-sm font-bold">
                            <span className="absolute top-2 left-2 bg-white/10 text-[9px] px-2 py-0.5 rounded-md font-bold text-white/50">قريباً</span>
                            <span className="material-symbols-outlined text-[24px]">credit_card</span>
                            بطاقة بنكية
                          </button>
                        </div>
                      </div>
                      
                      {paymentMethod === 'cod' && (
                        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 flex items-start gap-3 mt-4">
                          <span className="material-symbols-outlined text-green-400">verified_user</span>
                          <p className="text-xs text-green-400 font-bold leading-relaxed">
                            لن يتم خصم أي مبلغ منك الآن. الدفع سيكون نقداً أو بالفيزا عند وصول المندوب إليك.
                          </p>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
            </div>

            {/* Persistent Footer & Summary */}
            {cart.length > 0 && (
              <div className="p-5 border-t border-white/5 bg-surface-container shrink-0 shadow-[0_-10px_20px_rgba(0,0,0,0.3)] z-20">
                <div className="space-y-1.5 mb-4">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600 dark:text-gray-400">المجموع الفرعي</span>
                    <span className="text-gray-900 dark:text-white font-mono font-bold" dir="ltr">EGP {subtotal.toLocaleString()}</span>
                  </div>
                  {discountAmount > 0 && (
                    <div className="flex justify-between text-xs text-green-600 dark:text-green-400">
                      <span>الخصم</span>
                      <span className="font-mono font-bold" dir="ltr">- EGP {discountAmount.toLocaleString()}</span>
                    </div>
                  )}
                  {checkoutStep >= 2 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-600 dark:text-gray-400">الشحن</span>
                      <span className="text-gray-900 dark:text-white font-mono font-bold" dir="ltr">{effectiveShippingFee > 0 ? `EGP ${effectiveShippingFee.toLocaleString()}` : 'مجاني'}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-lg font-black pt-2 border-t border-gray-200 dark:border-white/10 mt-1">
                    <span className="text-gray-900 dark:text-white">الإجمالي</span>
                    <span className="text-primary font-mono" dir="ltr">EGP {totalAmount.toLocaleString()}</span>
                  </div>
                </div>

                {checkoutStep < 3 ? (
                  <button onClick={handleValidationAndNext} className="w-full bg-primary hover:bg-red-700 text-white font-black py-4 rounded-xl transition-all shadow-[0_10px_30px_rgba(220,38,38,0.3)] flex justify-center items-center gap-2">
                    {checkoutStep === 1 ? 'التالي: بيانات الشحن' : 'التالي: طريقة الدفع'}
                    <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                  </button>
                ) : (
                  <button disabled={loading} onClick={handlePlaceOrder} className={`w-full text-white font-black py-4 rounded-xl transition-all flex justify-center items-center gap-2 ${paymentMethod === 'cod' ? 'bg-primary hover:bg-red-700 shadow-[0_10px_30px_rgba(220,38,38,0.3)]' : 'bg-blue-600 hover:bg-blue-700 shadow-[0_10px_30px_rgba(37,99,235,0.3)]'}`}>
                    {loading ? <span className="material-symbols-outlined animate-spin">sync</span> : (
                      <>
                        <span className="material-symbols-outlined">{paymentMethod === 'cod' ? 'local_shipping' : 'credit_card'}</span>
                        تأكيد الطلب
                      </>
                    )}
                  </button>
                )}

                <div className="flex items-center justify-center gap-1.5 mt-3 text-[10px] text-on-surface-variant/40 font-bold">
                  <span className="material-symbols-outlined text-[12px] text-green-500">verified_user</span>
                  <span>الطلب مؤمن بواسطة EG-PARTS Cloud</span>
                </div>
              </div>
            )}
          </motion.div>

          {/* Verification Modal (OTP & Turnstile) */}
          <AnimatePresence>
            {isVerificationModalOpen && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/90 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
                <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }} className="bg-surface w-full max-w-sm rounded-3xl overflow-hidden border border-white/10 shadow-2xl relative">
                  <button onClick={() => setIsVerificationModalOpen(false)} className="absolute top-4 right-4 text-on-surface-variant hover:text-white bg-white/5 w-8 h-8 rounded-full flex items-center justify-center transition-all z-10"><span className="material-symbols-outlined text-[18px]">close</span></button>
                  
                  <div className="p-8">
                    <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6 text-primary">
                      <span className="material-symbols-outlined text-[32px]">security</span>
                    </div>
                    
                    {!isOtpStep ? (
                      <div className="text-center space-y-6">
                        <div>
                          <h3 className="text-xl font-bold text-on-surface mb-2">تأكيد أمني</h3>
                          <p className="text-sm text-on-surface-variant">لحماية حسابك، يرجى تأكيد أنك لست برنامجاً آلياً للمتابعة.</p>
                        </div>
                        {!devMode && (
                          <div className="flex justify-center bg-black/20 p-4 rounded-xl border border-white/5">
                            <Turnstile siteKey={TURNSTILE_SITE_KEY} onSuccess={(token) => setTurnstileToken(token)} onExpire={() => setTurnstileToken(null)} onError={() => setTurnstileToken(null)} />
                          </div>
                        )}
                        <button disabled={isSendingOtp} onClick={handleSendOtp} className="w-full bg-primary hover:bg-red-700 text-white font-bold py-3.5 rounded-xl transition-all disabled:opacity-50">
                          {isSendingOtp ? statusMessages[sendingStatus] : 'المتابعة للحصول على الكود'}
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleVerifyOtpAndCheckout} className="space-y-6 text-center">
                        <div>
                          <h3 className="text-xl font-bold text-on-surface mb-2">رمز التحقق</h3>
                          <p className="text-sm text-on-surface-variant">أدخل الكود المكون من 6 أرقام المرسل إلى <b className="text-primary font-mono">{phone}</b> عبر الواتساب</p>
                        </div>
                        <input type="text" required maxLength={6} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-4 text-3xl font-black text-center text-primary focus:border-primary tracking-widest" placeholder="000000" />
                        <button disabled={loading} type="submit" className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3.5 rounded-xl transition-all">
                          {loading ? 'جاري التحقق...' : 'تأكيد الرمز وإتمام الطلب'}
                        </button>
                        <div>
                          {otpTimer > 0 ? (
                            <p className="text-xs text-on-surface-variant">إعادة إرسال الكود خلال {otpTimer} ثانية</p>
                          ) : (
                            <button type="button" onClick={handleSendOtp} className="text-xs text-primary font-bold hover:underline">إعادة إرسال الكود؟</button>
                          )}
                        </div>
                      </form>
                    )}
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
