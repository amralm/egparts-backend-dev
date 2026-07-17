import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { Turnstile } from '@marsidev/react-turnstile';
import { useDevMode } from '../../hooks/useDevMode';

export default function Auth() {
  const devMode = useDevMode();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'not_admin') {
      setError('حسابك غير مسجل كمسؤول نظام أو مسؤول متجر في قاعدة البيانات.');
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      sessionStorage.setItem('pending_login_log', 'true');
      const { data: { user }, error: authError } = await supabase.auth.signInWithPassword({
        email: formData.email,
        password: formData.password,
      });

      if (authError) {
        setError(authError.message);
      } else if (user?.app_metadata?.role !== 'admin') {
        await supabase.auth.signOut();
        setError('ليس لديك صلاحيات الوصول للوحة التحكم');
      } else {
        navigate('/admin');
      }
    } catch (err) {
      setError(err.message || 'حدث خطأ غير متوقع');
    }

    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" dir="rtl">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent pointer-events-none"></div>

      <div className="glass-panel max-w-md w-full p-8 rounded-2xl border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)] z-10">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-black text-white bg-clip-text bg-gradient-to-r from-orange-400 to-amber-600 font-['Space_Grotesk'] tracking-tight mb-2">EG-ADMIN</h1>
          <p className="text-on-surface-variant font-headline-md mt-2">
            سجل الدخول للوصول إلى لوحة التحكم
          </p>
        </div>

        {error && (
          <div className="bg-error/10 border border-error/30 text-error px-4 py-3 rounded-lg mb-6 text-sm text-center font-bold">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-on-surface-variant text-sm mb-2 font-bold">البريد الإلكتروني</label>
            <input
              type="email"
              required
              value={formData.email}
              onChange={e => setFormData({ ...formData, email: e.target.value })}
              className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-primary transition-colors text-left"
              placeholder="admin@eg-parts.com"
              dir="ltr"
            />
          </div>

          <div>
            <label className="block text-on-surface-variant text-sm mb-2 font-bold">كلمة المرور</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={formData.password}
                onChange={e => setFormData({ ...formData, password: e.target.value })}
                className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-primary transition-colors text-left"
                placeholder="••••••••"
                dir="ltr"
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-white transition-colors">
                <span className="material-symbols-outlined text-[20px]">{showPassword ? 'visibility' : 'visibility_off'}</span>
              </button>
            </div>
          </div>

          {!devMode && (
            <div className="flex justify-center py-2">
              <Turnstile 
                siteKey="0x4AAAAAADF4VfOFuztpzj9u" 
                onSuccess={(token) => setTurnstileToken(token)}
                onExpire={() => setTurnstileToken(null)}
                onError={() => setTurnstileToken(null)}
              />
            </div>
          )}

          <button disabled={loading} type="submit" className="w-full bg-primary hover:bg-primary-fixed text-on-primary font-bold py-3 rounded-lg shadow-[0_0_20px_rgba(255,153,0,0.4)] transition-all mt-6 text-lg disabled:opacity-50">
            {loading ? 'جاري الدخول...' : 'تسجيل الدخول'}
          </button>
        </form>
      </div>
    </div>
  );
}
