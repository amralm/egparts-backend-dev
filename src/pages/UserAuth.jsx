import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { supabase } from '../lib/supabase';
import { Turnstile } from '@marsidev/react-turnstile';
import { syncUserProfile } from '../services/authService';
import fetchWithRetry, { RETRY_MESSAGES } from '../lib/fetchWithRetry';
import { useSettings } from '../context/SettingsContext';
import { useStore } from '../context/StoreContext';
import { useDevMode } from '../hooks/useDevMode';

export default function UserAuth() {
  const { store } = useStore();
  const devMode = useDevMode();
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    password: ''
  });
  const [otp, setOtp] = useState('');
  const [isOtpStep, setIsOtpStep] = useState(false);
  const [loading, setLoading] = useState(false);
  const [timer, setTimer] = useState(0);
  const [verifiedPhone, setVerifiedPhone] = useState(''); 
  const [turnstileToken, setTurnstileToken] = useState(null);
  
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [forgotStep, setForgotStep] = useState(1);
  const [forgotPhone, setForgotPhone] = useState('');
  const [forgotOtp, setForgotOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [forgotTimer, setForgotTimer] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showForgotNewPassword, setShowForgotNewPassword] = useState(false);
  const [showForgotConfirmPassword, setShowForgotConfirmPassword] = useState(false);
  const [retryIndex, setRetryIndex] = useState(-1);

  const navigate = useNavigate();
  const { showToast } = useToast();
  const { settings } = useSettings();

  useEffect(() => {
    let interval;
    if (timer > 0) {
      interval = setInterval(() => setTimer(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [timer]);

  useEffect(() => {
    let interval;
    if (forgotTimer > 0) {
      interval = setInterval(() => setForgotTimer(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [forgotTimer]);

  const handleInitialAction = async (e) => {
    e.preventDefault();
    if (loading || timer > 0) return;

    setLoading(true);
    try {
      if (isLogin) {
        // ✅ Login logic: Just Email and Password (No OTP by default)
        sessionStorage.setItem('pending_login_log', 'true');
        const { data: { user }, error: loginError } = await supabase.auth.signInWithPassword({
          email: formData.email,
          password: formData.password,
        });

        if (loginError) {
          if (loginError.message === 'Invalid login credentials') {
            throw new Error('البريد الإلكتروني أو كلمة المرور غير صحيحة');
          }
          throw loginError;
        }

        if (user) {
          await syncUserProfile(user, store?.id);
        }

        showToast('success', 'أهلاً بك مجدداً! جاري توجيهك...');
        const redirectUrl = new URLSearchParams(window.location.search).get('redirect') || '/';
        navigate(redirectUrl);
      } else {
        // ✅ Signup logic: Must verify phone via OTP first
        if (!/^01[0125][0-9]{8}$/.test(formData.phone)) {
          throw new Error('يرجى إدخال رقم هاتف مصري صحيح');
        }

        setVerifiedPhone(formData.phone);
        const formattedPhone = `2${formData.phone}`;
        
        setRetryIndex(0);
        const response = await fetchWithRetry(`${import.meta.env.VITE_BACKEND_URL}/api/auth/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: formattedPhone, purpose: 'signup', turnstileToken }),
        }, (i) => setRetryIndex(i + 1));

        const data = await response.json();

        if (data.success) {
          setIsOtpStep(true);
          setTimer(60);
        } else {
          const errorMsg = typeof data.error === 'object' ? data.error.message : data.error;
          throw new Error(errorMsg || 'فشل في إرسال كود واتساب');
        }
      }
    } catch (err) {
      if (err instanceof TypeError) {
        showToast('error', 'تعذر الاتصال بالخادم بعد عدة محاولات، برجاء المحاولة بعد قليل');
      } else {
        showToast('error', err.message || 'حدث خطأ غير متوقع');
      }
    } finally {
      setLoading(false);
      setRetryIndex(-1);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    if (loading) return;

    setLoading(true);
    try {
      const formattedPhone = `2${verifiedPhone}`;
      const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, code: otp }),
      });

      const verifyData = await response.json();

      if (verifyData.success) {
        // OTP Verified, now complete the Signup
        const { data: { user }, error: signUpError } = await supabase.auth.signUp({
          email: formData.email,
          password: formData.password,
          options: {
            data: {
              name: formData.name,
              phone: formData.phone,
              role: 'user'
            },
            emailRedirectTo: `${window.location.origin}/email-verified`
          }
        });
        
        if (signUpError) throw signUpError;

        if (user) {
          await syncUserProfile(user, store?.id);
          // Save the verified phone to user_profiles
          await supabase.from('user_profiles').update({ phone: verifiedPhone }).eq('user_id', user.id).eq('store_id', store?.id);
          // Refresh session metadata so phone shows in Account page on first load
          await supabase.auth.updateUser({ data: { phone: verifiedPhone } });
        }

        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData?.session) {
          showToast('success', 'تم إنشاء الحساب والدخول بنجاح! 🎉');
          const redirectUrl = new URLSearchParams(window.location.search).get('redirect') || '/';
          navigate(redirectUrl);
        } else {
          showToast('success', 'تم إنشاء الحساب! الدخول بعد تفعيل البريد الإلكتروني');
          setIsLogin(true);
          setIsOtpStep(false);
        }
      } else {
        showToast('error', 'كود التحقق غير صحيح');
        setTimer(prev => Math.min(prev * 2, 600));
      }
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      sessionStorage.setItem('pending_login_log', 'true');
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin
        }
      });
      if (error) throw error;
    } catch (err) {
      showToast('error', 'فشل الدخول عبر جوجل');
    }
  };

  const handleForgotSendOtp = async (e) => {
    e.preventDefault();
    if (loading || forgotTimer > 0) return;
    if (!/^01[0125][0-9]{8}$/.test(forgotPhone)) {
      showToast('error', 'يرجى إدخال رقم هاتف مصري صحيح');
      return;
    }
    setLoading(true);
    try {
      const formattedPhone = `2${forgotPhone}`;
      const response = await fetchWithRetry(`${import.meta.env.VITE_BACKEND_URL}/api/auth/send-otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, purpose: 'forgot', turnstileToken }),
      }, (i) => {});

      const data = await response.json();
      if (data.success) {
        setForgotStep(2);
        setForgotTimer(60);
      } else {
        const errorMsg = typeof data.error === 'object' ? data.error.message : data.error;
        throw new Error(errorMsg || 'فشل في إرسال كود واتساب');
      }
    } catch (err) {
      showToast('error', err instanceof TypeError ? 'تعذر الاتصال بالخادم بعد عدة محاولات، برجاء المحاولة بعد قليل' : err.message);
    } finally { setLoading(false); }
  };

  const handleForgotVerifyOtp = async (e) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      const formattedPhone = `2${forgotPhone}`;
      const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/auth/verify-otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, code: forgotOtp }),
      });
      const data = await response.json();
      if (data.success) {
        setForgotStep(3);
      } else {
        showToast('error', 'كود التحقق غير صحيح');
        setForgotTimer(prev => Math.min(prev * 2, 600));
      }
    } catch (err) {
      showToast('error', err.message);
    } finally { setLoading(false); }
  };

  const handleForgotResetPassword = async (e) => {
    e.preventDefault();
    if (loading) return;
    if (newPassword !== confirmPassword) {
      showToast('error', 'كلمة المرور غير متطابقة');
      return;
    }
    if (newPassword.length < 6) {
      showToast('error', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل');
      return;
    }
    setLoading(true);
    try {
      const formattedPhone = `2${forgotPhone}`;
      const response = await fetchWithRetry(`${import.meta.env.VITE_BACKEND_URL}/api/auth/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, code: forgotOtp, new_password: newPassword }),
      });
      const data = await response.json();
      if (data.success) {
        showToast('success', 'تم تغيير كلمة المرور بنجاح! يمكنك تسجيل الدخول الآن');
        setIsForgotPassword(false);
        setForgotStep(1);
        setForgotPhone('');
        setForgotOtp('');
        setNewPassword('');
        setConfirmPassword('');
        setIsLogin(true);
      } else {
        const errorMsg = typeof data.error === 'object' ? data.error.message : data.error;
        throw new Error(errorMsg || 'فشل في تغيير كلمة المرور');
      }
    } catch (err) {
      showToast('error', err instanceof TypeError ? 'تعذر الاتصال بالخادم بعد عدة محاولات، برجاء المحاولة بعد قليل' : err.message);
    } finally { setLoading(false); }
  };

  const startForgotPassword = () => {
    setIsForgotPassword(true);
    setIsOtpStep(false);
    setForgotStep(1);
    setForgotPhone('');
    setForgotOtp('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const cancelForgotPassword = () => {
    setIsForgotPassword(false);
    setForgotStep(1);
    setForgotPhone('');
    setForgotOtp('');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="pb-[100px] px-4 max-w-[500px] mx-auto min-h-screen flex items-center justify-center" dir="rtl">
      <div className="bg-surface w-full p-8 rounded-3xl border border-on-surface/5 shadow-2xl relative">
        <button 
          onClick={() => navigate('/')}
          className="absolute top-6 left-6 text-on-surface-variant hover:text-primary transition-colors"
          title="العودة للرئيسية"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
        
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black text-on-surface mb-2">
            {isForgotPassword ? 'استعادة كلمة المرور' : (isOtpStep ? 'تأكيد الهوية' : (isLogin ? 'تسجيل الدخول' : 'إنشاء حساب جديد'))}
          </h1>
          <p className="text-on-surface-variant font-medium">
            {isForgotPassword 
              ? (forgotStep === 1 ? 'أدخل رقم هاتفك المسجل لإرسال كود التحقق' : forgotStep === 2 ? 'أدخل الكود المرسل لواتساب' : 'أدخل كلمة المرور الجديدة')
              : (isOtpStep ? `أدخل الكود المرسل لواتساب الرقم المسجل` : `أهلاً بك في ${settings?.brand_name || 'EG-PARTS'}`)}
          </p>
        </div>

        {isForgotPassword ? (
          forgotStep === 1 ? (
            <form onSubmit={handleForgotSendOtp} className="space-y-4">
              <div>
                <label className="block text-on-surface-variant text-xs font-bold mb-2 mr-2">رقم الهاتف (واتساب)</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary font-bold">2+</span>
                  <input type="tel" required value={forgotPhone} onChange={e => setForgotPhone(e.target.value)} className="w-full bg-surface-container border border-on-surface/10 rounded-xl pl-12 pr-4 py-3 text-on-surface text-lg font-bold focus:outline-none focus:border-primary text-left" placeholder="01xxxxxxxxx" dir="ltr" />
                </div>
              </div>
              {!devMode && (
                <div className="flex justify-center py-2">
                  <Turnstile siteKey="0x4AAAAAADF4VfOFuztpzj9u" onSuccess={(token) => setTurnstileToken(token)} onExpire={() => setTurnstileToken(null)} onError={() => setTurnstileToken(null)} />
                </div>
              )}
              <button disabled={loading} type="submit" className="w-full bg-primary hover:bg-red-700 text-white font-black py-4 rounded-xl shadow-lg transition-all mt-2 disabled:opacity-50">
                {loading ? 'جاري الاتصال بالخادم...' : 'إرسال كود التحقق'}
              </button>
              <div className="text-center">
                <button type="button" onClick={cancelForgotPassword} className="text-on-surface-variant hover:text-primary transition-colors text-sm font-bold">العودة لتسجيل الدخول</button>
              </div>
            </form>
          ) : forgotStep === 2 ? (
            <form onSubmit={handleForgotVerifyOtp} className="space-y-6">
              <div>
                <label className="block text-on-surface-variant text-xs font-black text-center mb-4 uppercase tracking-widest">كود التحقق من واتساب</label>
                <input type="text" required maxLength={6} value={forgotOtp} onChange={e => setForgotOtp(e.target.value.replace(/\D/g, ''))} className="w-full bg-surface-container border border-on-surface/10 rounded-2xl px-4 py-5 text-on-surface text-4xl font-black text-center focus:outline-none focus:border-primary tracking-[0.5em]" placeholder="000000" dir="ltr" autoFocus />
                <p className="text-center text-on-surface-variant text-xs mt-4">تم إرسال الكود للرقم المنتهي بـ <span className="text-primary font-bold">*{forgotPhone.slice(-4)}</span></p>
              </div>
              <button disabled={loading} type="submit" className="w-full bg-green-500 hover:bg-green-600 text-white font-black py-5 rounded-2xl shadow-xl transition-all disabled:opacity-50">{loading ? 'جاري التحقق...' : 'تأكيد الرمز'}</button>
              <div className="text-center">
                {forgotTimer > 0 ? (
                  <p className="text-on-surface-variant text-sm">إعادة إرسال الكود خلال <span className="text-primary font-bold">{forgotTimer} ثانية</span></p>
                ) : (
                  <button type="button" onClick={handleForgotSendOtp} className="text-primary hover:underline text-sm font-bold">إعادة إرسال الكود؟</button>
                )}
              </div>
            </form>
          ) : (
            <form onSubmit={handleForgotResetPassword} className="space-y-4">
              <div>
                <label className="block text-on-surface-variant text-xs font-bold mb-2 mr-2">كلمة المرور الجديدة</label>
                <div className="relative">
                  <input type={showForgotNewPassword ? 'text' : 'password'} required minLength={6} value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full bg-surface-container border border-on-surface/10 rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:border-primary text-left" placeholder="••••••••" dir="ltr" />
                  <button type="button" onClick={() => setShowForgotNewPassword(!showForgotNewPassword)} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors">
                    <span className="material-symbols-outlined text-[20px]">{showForgotNewPassword ? 'visibility' : 'visibility_off'}</span>
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-on-surface-variant text-xs font-bold mb-2 mr-2">تأكيد كلمة المرور الجديدة</label>
                <div className="relative">
                  <input type={showForgotConfirmPassword ? 'text' : 'password'} required minLength={6} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="w-full bg-surface-container border border-on-surface/10 rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:border-primary text-left" placeholder="••••••••" dir="ltr" />
                  <button type="button" onClick={() => setShowForgotConfirmPassword(!showForgotConfirmPassword)} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors">
                    <span className="material-symbols-outlined text-[20px]">{showForgotConfirmPassword ? 'visibility' : 'visibility_off'}</span>
                  </button>
                </div>
              </div>
              <button disabled={loading} type="submit" className="w-full bg-primary hover:bg-red-700 text-white font-black py-4 rounded-xl shadow-lg transition-all mt-2 disabled:opacity-50">{loading ? 'جاري الحفظ...' : 'تغيير كلمة المرور'}</button>
            </form>
          )
        ) : !isOtpStep ? (
          <form onSubmit={handleInitialAction} className="space-y-4">
            {!isLogin && (
              <div>
                <label className="block text-on-surface-variant text-xs font-bold mb-2 mr-2">الاسم بالكامل</label>
                <input 
                  type="text" required
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  className="w-full bg-surface-container border border-on-surface/10 rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:border-primary"
                  placeholder="محمد أحمد"
                />
              </div>
            )}

            <div>
              <label className="block text-on-surface-variant text-xs font-bold mb-2 mr-2">البريد الإلكتروني</label>
              <input 
                type="email" required
                value={formData.email}
                onChange={e => setFormData({...formData, email: e.target.value})}
                className="w-full bg-surface-container border border-on-surface/10 rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:border-primary text-left"
                placeholder="user@example.com"
                dir="ltr"
              />
            </div>

            {!isLogin && (
              <div>
                <label className="block text-on-surface-variant text-xs font-bold mb-2 mr-2">رقم الهاتف (واتساب)</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary font-bold">2+</span>
                  <input 
                    type="tel" required
                    value={formData.phone}
                    onChange={e => setFormData({...formData, phone: e.target.value})}
                    className="w-full bg-surface-container border border-on-surface/10 rounded-xl pl-12 pr-4 py-3 text-on-surface text-lg font-bold focus:outline-none focus:border-primary text-left"
                    placeholder="01xxxxxxxxx"
                    dir="ltr"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-on-surface-variant text-xs font-bold mb-2 mr-2">كلمة المرور</label>
              <div className="relative">
                <input 
                  type={showPassword ? 'text' : 'password'} required minLength={6}
                  value={formData.password}
                  onChange={e => setFormData({...formData, password: e.target.value})}
                  className="w-full bg-surface-container border border-on-surface/10 rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:border-primary text-left"
                  placeholder="••••••••"
                  dir="ltr"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors">
                  <span className="material-symbols-outlined text-[20px]">{showPassword ? 'visibility' : 'visibility_off'}</span>
                </button>
              </div>
            </div>

            {isLogin && (
              <div className="text-left">
                <button type="button" onClick={startForgotPassword} className="text-primary hover:underline text-xs font-bold">
                  نسيت كلمة المرور؟
                </button>
              </div>
            )}

            <div className="flex justify-center py-2">
            {!devMode && (
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
              disabled={loading} 
              type="submit" 
              className="w-full bg-primary hover:bg-red-700 text-white font-black py-4 rounded-xl shadow-lg transition-all mt-2 disabled:opacity-50"
            >
              {loading && retryIndex >= 0 ? RETRY_MESSAGES[Math.min(retryIndex, RETRY_MESSAGES.length - 1)] : (loading ? 'جاري التحقق...' : (isLogin ? 'تسجيل الدخول' : 'إنشاء الحساب'))}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-6">
            <div>
              <label className="block text-on-surface-variant text-xs font-black text-center mb-4 uppercase tracking-widest">كود التحقق من واتساب</label>
              <input 
                type="text" required maxLength={6}
                value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                className="w-full bg-surface-container border border-on-surface/10 rounded-2xl px-4 py-5 text-on-surface text-4xl font-black text-center focus:outline-none focus:border-primary tracking-[0.5em]"
                placeholder="000000"
                dir="ltr"
                autoFocus
              />
              <p className="text-center text-on-surface-variant text-xs mt-4">
                تم إرسال الكود للرقم المنتهي بـ <span className="text-primary font-bold">*{verifiedPhone.slice(-4)}</span>
              </p>
            </div>

            <button 
              disabled={loading} 
              type="submit" 
              className="w-full bg-green-500 hover:bg-green-600 text-white font-black py-5 rounded-2xl shadow-xl transition-all disabled:opacity-50"
            >
              {loading ? 'جاري التحقق...' : 'تأكيد الرمز والدخول'}
            </button>

            <div className="text-center">
              {timer > 0 ? (
                <p className="text-on-surface-variant text-sm">
                  إعادة إرسال الكود خلال <span className="text-primary font-bold">{timer} ثانية</span>
                </p>
              ) : (
                <button 
                  type="button" onClick={handleInitialAction}
                  className="text-primary hover:underline text-sm font-bold"
                >
                  إعادة إرسال الكود؟
                </button>
              )}
            </div>
          </form>
        )}

        <div className="mt-8 text-center pt-6 border-t border-on-surface/10 space-y-4">
          <button 
            type="button"
            onClick={handleGoogleLogin}
            className="w-full flex items-center justify-center gap-3 bg-white text-black font-black py-4 rounded-xl shadow-lg hover:bg-gray-100 transition-all"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="Google" />
            الدخول عبر جوجل
          </button>

          <button 
            type="button"
            onClick={() => { setIsLogin(!isLogin); setIsOtpStep(false); }} 
            className="text-on-surface-variant hover:text-primary transition-colors text-sm font-bold block mx-auto"
          >
            {isLogin ? 'لا تملك حساب؟ إنشاء حساب جديد' : 'لديك حساب بالفعل؟ تسجيل الدخول'}
          </button>
        </div>
      </div>
    </div>
  );
}
