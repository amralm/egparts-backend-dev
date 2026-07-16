import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function IPBlockGuard({ children }) {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const url = `${import.meta.env.VITE_BACKEND_URL}/api/blocked/check${!session ? '?guest=1' : ''}`;
      try {
        const r = await fetch(url);
        const data = await r.json();
        if (data.blocked) {
          setBlocked(true);
        }
      } catch {
        // Ignore errors to not block legitimate users
      }
    })();
  }, []);

  if (blocked) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-8" dir="rtl">
        <div className="text-center max-w-md">
          <div className="w-24 h-24 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-8">
            <span className="material-symbols-outlined text-[56px] text-red-500">block</span>
          </div>
          <h1 className="text-4xl font-black text-on-surface mb-4">تم حظر الوصول</h1>
          <p className="text-on-surface-variant text-lg leading-relaxed">
            عنوان IP الخاص بك محظور من الوصول إلى هذا الموقع. إذا كنت تعتقد أن هذا خطأ، يرجى التواصل مع الدعم الفني.
          </p>
        </div>
      </div>
    );
  }

  return children;
}
