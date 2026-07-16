import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';
import { useEffect, useState } from 'react';

export default function ProtectedRoute({ children }) {
  const session = useAuth();
  const [isChecking, setIsChecking] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    if (session === undefined) return; // جاري التحميل

    if (session) {
      // الاعتماد على الـ Role من app_metadata للأمان المطلق
      const role = session.user?.app_metadata?.role;
      if (role !== 'admin') {
        // إذا كان يوزر عادي لا يملك Role أدمن، اطرده
        supabase.auth.signOut().then(() => {
          setIsAuthorized(false);
          setIsChecking(false);
        });
      } else {
        setIsAuthorized(true);
        setIsChecking(false);
      }
    } else {
      setIsAuthorized(false);
      setIsChecking(false);
    }
  }, [session]);

  if (session === undefined || isChecking) {
    return <div className="min-h-screen flex items-center justify-center bg-background text-primary font-bold text-xl">جاري التحقق من الصلاحيات...</div>;
  }

  if (!isAuthorized) {
    return <Navigate to="/admin/auth" replace />;
  }

  return children;
}
