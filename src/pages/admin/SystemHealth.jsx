import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion } from 'framer-motion';
import { useStore } from '../../context/StoreContext';

export default function SystemHealth() {
  const { store } = useStore();
  const [stats, setStats] = useState({
    pending: 0,
    sent: 0,
    failed: 0,
    total: 0
  });
  const [failedJobs, setFailedJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [whatsappStatus, setWhatsappStatus] = useState('unknown');

  useEffect(() => {
    if (store?.id) {
      fetchHealthData();
      const interval = setInterval(fetchHealthData, 30000); // Poll every 30s
      return () => clearInterval(interval);
    }
  }, [store?.id]);

  const fetchHealthData = async () => {
    if (!store?.id) return;
    try {
      // 1. Fetch Stats
      const { data: queueData, error: queueError } = await supabase
        .from('notification_queue')
        .select('status')
        .eq('store_id', store.id);

      if (queueError) throw queueError;

      const newStats = { pending: 0, sent: 0, failed: 0, total: queueData.length };
      queueData.forEach(job => {
        if (job.status === 'pending') newStats.pending++;
        else if (job.status === 'sent') newStats.sent++;
        else if (job.status === 'failed') newStats.failed++;
      });
      setStats(newStats);

      // 2. Fetch Recent Failures
      const { data: failures, error: failError } = await supabase
        .from('notification_queue')
        .select('*')
        .eq('status', 'failed')
        .eq('store_id', store.id)
        .order('updated_at', { ascending: false })
        .limit(10);
      
      if (!failError) setFailedJobs(failures);

      // 3. Fetch WhatsApp Status (via server health endpoint)
      try {
        const res = await fetch(`${import.meta.env.VITE_BACKEND_URL || 'https://egparts-backend.onrender.com'}/`);
        const health = await res.json();
        setWhatsappStatus(health.whatsapp || 'disconnected');
      } catch (e) {
        setWhatsappStatus('server_down');
      }

    } catch (err) {
      console.error('Error fetching health data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (jobId) => {
    if (!store?.id) return;
    try {
      const { error } = await supabase
        .from('notification_queue')
        .update({ 
          status: 'pending', 
          retry_count: 0,
          next_retry_at: new Date()
        })
        .eq('id', jobId)
        .eq('store_id', store.id);
      
      if (!error) {
        setFailedJobs(prev => prev.filter(j => j.id !== jobId));
        fetchHealthData();
      }
    } catch (err) {
      alert('Failed to retry job');
    }
  };

  const handleRetryAll = async () => {
    if (!store?.id) return;
    if (!window.confirm('هل أنت متأكد من إعادة محاولة إرسال كافة الرسائل الفاشلة؟')) return;
    try {
      await supabase
        .from('notification_queue')
        .update({ status: 'pending', retry_count: 0, next_retry_at: new Date() })
        .eq('status', 'failed')
        .eq('store_id', store.id);
      fetchHealthData();
    } catch (err) {
      alert('Failed to retry all jobs');
    }
  };

  return (
    <div className="p-6 space-y-8" dir="rtl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">analytics</span>
            صحة النظام والموثوقية
          </h1>
          <p className="text-on-surface-variant text-sm mt-1">مراقبة طابور التنبيهات وحالة الخدمات الخلفية</p>
        </div>
        <button 
          onClick={fetchHealthData}
          className="bg-white/5 hover:bg-white/10 p-2 rounded-lg border border-white/10 transition-all"
        >
          <span className={`material-symbols-outlined ${loading ? 'animate-spin' : ''}`}>refresh</span>
        </button>
      </div>

      {/* Status Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="glass-panel p-6 rounded-2xl border border-white/10 bg-gradient-to-br from-white/5 to-transparent">
          <p className="text-on-surface-variant text-xs mb-1">حالة الواتساب</p>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${
              whatsappStatus === 'connected' ? 'bg-green-500 animate-pulse' : 
              whatsappStatus === 'connecting' ? 'bg-amber-500 animate-bounce' : 'bg-red-500'
            }`}></div>
            <p className="text-xl font-black text-white uppercase">
              {whatsappStatus === 'connected' ? 'متصل' : 
               whatsappStatus === 'connecting' ? 'جاري الاتصال...' : 'منقطع'}
            </p>
          </div>

        </div>

        <div className="glass-panel p-6 rounded-2xl border border-white/10">
          <p className="text-on-surface-variant text-xs mb-1">رسائل قيد الانتظار</p>
          <p className="text-3xl font-black text-primary">{stats.pending}</p>
        </div>

        <div className="glass-panel p-6 rounded-2xl border border-white/10">
          <p className="text-on-surface-variant text-xs mb-1">تم الإرسال بنجاح</p>
          <p className="text-3xl font-black text-green-500">{stats.sent}</p>
        </div>

        <div className="glass-panel p-6 rounded-2xl border border-red-500/20 bg-red-500/5">
          <p className="text-on-surface-variant text-xs mb-1">فشل الإرسال</p>
          <div className="flex justify-between items-end">
            <p className="text-3xl font-black text-red-500">{stats.failed}</p>
            {stats.failed > 0 && (
              <button 
                onClick={handleRetryAll}
                className="text-[10px] bg-red-500 text-white px-2 py-1 rounded font-bold hover:bg-red-600 transition-all"
              >
                إعادة محاولة الكل
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Recent Failures */}
      <div className="glass-panel rounded-3xl border border-white/10 overflow-hidden">
        <div className="p-6 border-b border-white/10 flex justify-between items-center">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-red-500">error</span>
            آخر التنبيهات الفاشلة
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-white/5 text-on-surface-variant text-xs uppercase">
                <th className="p-4">الطلب</th>
                <th className="p-4">المستلم</th>
                <th className="p-4">المحاولات</th>
                <th className="p-4">آخر خطأ</th>
                <th className="p-4">المحاولة القادمة</th>
                <th className="p-4">الإجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {failedJobs.length === 0 ? (
                <tr>
                  <td colSpan="6" className="p-10 text-center text-on-surface-variant">لا توجد رسائل فاشلة حالياً. النظام يعمل بشكل مثالي! ✨</td>
                </tr>
              ) : (
                failedJobs.map(job => (
                  <tr key={job.id} className="hover:bg-white/5 transition-colors">
                    <td className="p-4 text-xs font-mono text-white">#{job.order_id?.split('-')[0]}</td>
                    <td className="p-4 text-xs text-white">{job.recipient}</td>
                    <td className="p-4">
                      <span className="bg-red-500/20 text-red-400 px-2 py-0.5 rounded text-[10px] font-bold">
                        {job.retry_count} / 5
                      </span>
                    </td>
                    <td className="p-4 text-[10px] text-red-400 max-w-[200px] truncate" title={job.last_error}>
                      {job.last_error || 'خطأ غير معروف'}
                    </td>
                    <td className="p-4 text-[10px] text-on-surface-variant">
                      {job.next_retry_at ? new Date(job.next_retry_at).toLocaleString('ar-EG') : '-'}
                    </td>
                    <td className="p-4">
                      <button 
                        onClick={() => handleRetry(job.id)}
                        className="p-1.5 bg-primary/20 text-primary rounded-lg hover:bg-primary hover:text-on-primary transition-all flex items-center justify-center"
                        title="إعادة محاولة"
                      >
                        <span className="material-symbols-outlined text-[18px]">replay</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Debug Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="glass-panel p-6 rounded-2xl border border-white/10 space-y-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-xs">info</span>
            معلومات الخادم (Worker)
          </h3>
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-on-surface-variant">وقت الاستجابة (Polling):</span>
              <span className="text-white">15 ثانية</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-on-surface-variant">أقصى عدد محاولات:</span>
              <span className="text-white">5 محاولات</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-on-surface-variant">المنطق المستخدم:</span>
              <span className="text-white">Exponential Backoff</span>
            </div>
          </div>
        </div>

        <div className="glass-panel p-6 rounded-2xl border border-white/10 bg-primary/5">
          <h3 className="text-sm font-bold text-primary flex items-center gap-2">
            <span className="material-symbols-outlined text-xs">verified</span>
            ضمانات قاعدة البيانات
          </h3>
          <ul className="space-y-2 mt-2">
            <li className="text-[10px] text-on-surface-variant flex items-center gap-2">
              <span className="material-symbols-outlined text-[12px] text-green-500">check</span>
              التكرار ممنوع عبر Unique Idempotency Key
            </li>
            <li className="text-[10px] text-on-surface-variant flex items-center gap-2">
              <span className="material-symbols-outlined text-[12px] text-green-500">check</span>
              تغيير الحالات محمي عبر DB Triggers
            </li>
            <li className="text-[10px] text-on-surface-variant flex items-center gap-2">
              <span className="material-symbols-outlined text-[12px] text-green-500">check</span>
              معالجة الطابور ذرية (Atomic Locking)
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
