import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../context/StoreContext';

export default function LoginLogs() {
  const { store } = useStore();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selectedLog, setSelectedLog] = useState(null);
  const [blocking, setBlocking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [blockedIPs, setBlockedIPs] = useState(new Set());
  const [filter, setFilter] = useState('all');
  const pageSize = 20;

  useEffect(() => {
    if (store?.id) {
      fetchLogs();
      fetchBlockedIPs();
    }
  }, [page, filter, store?.id]);

  async function fetchBlockedIPs() {
    if (!store?.id) return;
    const { data } = await supabase.from('blocked_ips').select('ip_address').eq('store_id', store.id);
    if (data) setBlockedIPs(new Set(data.map(r => r.ip_address)));
  }

  function isIPBlocked(ip) { return ip && blockedIPs.has(ip); }

  async function fetchLogs() {
    setLoading(true);
    let query = supabase.from('user_login_logs').select('*', { count: 'exact' });
    if (filter === 'registered') query = query.in('login_method', ['email', 'google', 'admin']);
    else if (filter === 'guest') query = query.eq('login_method', 'guest');
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) console.error(error);
    if (data) setLogs(data);
    if (count !== null) setTotal(count);
    setLoading(false);
  }

  async function handleDeleteLog(logId) {
    const { error } = await supabase.from('user_login_logs').delete().eq('id', logId);
    if (error) { alert('حدث خطأ: ' + error.message); return; }
    setLogs(prev => prev.filter(l => l.id !== logId));
    setTotal(prev => prev - 1);
    setSelectedLog(null);
  }

  async function handleClearAll() {
    setDeleting(true);
    const { error } = await supabase.from('user_login_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) { alert('حدث خطأ: ' + error.message); setDeleting(false); return; }
    setLogs([]);
    setTotal(0);
    setPage(0);
    setDeleting(false);
    setShowDeleteConfirm(false);
  }

  async function handleToggleBlockIP(log) {
    if (!log.ip_address || !store?.id) return;
    setBlocking(true);

    if (isIPBlocked(log.ip_address)) {
      const { error } = await supabase.from('blocked_ips').delete().eq('ip_address', log.ip_address).eq('store_id', store.id);
      if (error) { alert('حدث خطأ: ' + error.message); setBlocking(false); return; }
      setBlockedIPs(prev => { const s = new Set(prev); s.delete(log.ip_address); return s; });
      alert('تم إلغاء حظر الـ IP بنجاح');
    } else {
      const { error } = await supabase.from('blocked_ips').insert({
        ip_address: log.ip_address,
        reason: `تم الحظر من سجل دخول المستخدم ${log.email || log.user_id}`,
        store_id: store.id
      });
      if (error) { alert('حدث خطأ أثناء الحظر: ' + error.message); setBlocking(false); return; }
      setBlockedIPs(prev => { const s = new Set(prev); s.add(log.ip_address); return s; });
      alert('تم حظر الـ IP بنجاح');
    }
    setBlocking(false);
  }

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-8" dir="rtl">
      <div className="flex justify-between items-center bg-gray-50 dark:bg-white/[0.02] p-8 rounded-[2.5rem] border border-gray-200 dark:border-white/5 backdrop-blur-md">
        <div>
          <h1 className="text-4xl font-black text-gray-900 dark:text-white flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[40px]">login</span>
            سجل تسجيل الدخول
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2 text-lg">جميع محاولات دخول المستخدمين والزوار للموقع.</p>
        </div>
        <div className="flex items-center gap-2">
          {['all', 'registered', 'guest'].map(f => (
            <button key={f} onClick={() => { setPage(0); setFilter(f); }}
              className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
                filter === f ? 'bg-primary text-on-primary shadow-lg shadow-primary/20' : 'bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 hover:text-primary dark:hover:text-white'
              }`}
            >
              {f === 'all' ? 'الكل' : f === 'registered' ? 'مسجلين' : 'زوار'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 font-black text-sm transition-all"
          >
            <span className="material-symbols-outlined text-[18px]">delete_sweep</span>
            مسح الكل
          </button>
          <div className="flex items-center gap-2 bg-gray-100 dark:bg-white/5 px-4 py-2 rounded-xl">
            <span className="material-symbols-outlined text-primary text-[20px]">database</span>
            <span className="text-gray-900 dark:text-white font-black">{total}</span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-surface-container-low border border-gray-200 dark:border-white/10 rounded-[2.5rem] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead>
              <tr className="border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5">
                <th className="p-4 text-xs font-black text-gray-600 dark:text-gray-400 uppercase tracking-widest">المستخدم</th>
                <th className="p-4 text-xs font-black text-gray-600 dark:text-gray-400 uppercase tracking-widest">البريد الإلكتروني</th>
                <th className="p-4 text-xs font-black text-gray-600 dark:text-gray-400 uppercase tracking-widest">طريقة الدخول</th>
                <th className="p-4 text-xs font-black text-gray-600 dark:text-gray-400 uppercase tracking-widest">IP</th>
                <th className="p-4 text-xs font-black text-gray-600 dark:text-gray-400 uppercase tracking-widest">المتصفح</th>
                <th className="p-4 text-xs font-black text-gray-600 dark:text-gray-400 uppercase tracking-widest">التاريخ</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="p-20 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-primary mx-auto"></div>
                </td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={6} className="p-20 text-center">
                  <span className="material-symbols-outlined text-[60px] text-white/20">login</span>
                  <p className="text-on-surface-variant mt-4 font-bold">لا توجد سجلات دخول بعد</p>
                </td></tr>
              ) : logs.map((log, i) => (
                <motion.tr
                  key={log.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  onClick={() => setSelectedLog(log)}
                >
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                        <span className="material-symbols-outlined text-[16px] text-primary">person</span>
                      </div>
                      <span className="text-gray-900 dark:text-white font-bold">{log.user_id?.slice(0, 8) || '—'}</span>
                    </div>
                  </td>
                  <td className="p-4 text-gray-600 dark:text-gray-400 text-sm font-mono ltr">{log.email || '—'}</td>
                  <td className="p-4">
                    <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${
                      log.login_method === 'admin' ? 'bg-primary/10 text-primary' :
                      log.login_method === 'guest' ? 'bg-amber-500/10 text-amber-500' :
                      'bg-green-500/10 text-green-500'
                    }`}>
                      {log.login_method === 'admin' ? 'أدمن' :
                       log.login_method === 'google' ? 'جوجل' :
                       log.login_method === 'guest' ? 'زائر' : 'مستخدم'}
                    </span>
                  </td>
                  <td className="p-4 text-gray-600 dark:text-gray-400 text-sm font-mono ltr">
                    {log.ip_address || '—'}
                    {isIPBlocked(log.ip_address) && (
                      <span className="mr-2 px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 text-[10px] font-black">محظور</span>
                    )}
                  </td>
                  <td className="p-4 text-gray-600 dark:text-gray-400 text-sm max-w-[200px] truncate" title={log.user_agent}>{log.user_agent ? log.user_agent.slice(0, 50) + '...' : '—'}</td>
                  <td className="p-4 text-gray-600 dark:text-gray-400 text-sm whitespace-nowrap font-mono ltr">
                    {new Date(log.created_at).toLocaleString('ar-EG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex justify-center items-center gap-3 p-6 border-t border-white/10">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
              className="px-5 py-2.5 rounded-xl bg-white/5 text-white font-bold hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              السابق
            </button>
            <span className="text-on-surface-variant text-sm font-bold">
              {page + 1} / {totalPages}
            </span>
            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
              className="px-5 py-2.5 rounded-xl bg-white/5 text-white font-bold hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              التالي
            </button>
          </div>
        )}
      </div>

      <AnimatePresence>
        {selectedLog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setSelectedLog(null)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white dark:bg-surface-container-low border border-gray-200 dark:border-white/10 rounded-[2.5rem] p-8 max-w-lg w-full max-h-[90vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-black text-gray-900 dark:text-white flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary">info</span>
                  تفاصيل تسجيل الدخول
                </h2>
                <button onClick={() => setSelectedLog(null)}
                  className="text-gray-600 dark:text-on-surface-variant hover:text-primary dark:hover:text-white transition-colors"
                >
                  <span className="material-symbols-outlined text-[28px]">close</span>
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-black text-gray-600 dark:text-on-surface-variant uppercase tracking-widest">معرف المستخدم</label>
                  <p className="text-gray-900 dark:text-white font-mono text-sm mt-1 ltr break-all">{selectedLog.user_id}</p>
                </div>
                <div>
                  <label className="text-xs font-black text-gray-600 dark:text-on-surface-variant uppercase tracking-widest">البريد الإلكتروني</label>
                  <p className="text-gray-900 dark:text-white text-sm mt-1 ltr">{selectedLog.email || '—'}</p>
                </div>
                <div>
                  <label className="text-xs font-black text-gray-600 dark:text-on-surface-variant uppercase tracking-widest">طريقة الدخول</label>
                  <p className="mt-1">
                    <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${selectedLog.login_method === 'admin' ? 'bg-primary/10 text-primary' : 'bg-green-500/10 text-green-500'}`}>
                      {selectedLog.login_method === 'admin' ? 'أدمن' :
                       selectedLog.login_method === 'google' ? 'جوجل' :
                       selectedLog.login_method === 'guest' ? 'زائر' : 'مستخدم'}
                    </span>
                  </p>
                </div>
                <div>
                  <label className="text-xs font-black text-gray-600 dark:text-on-surface-variant uppercase tracking-widest">عنوان IP</label>
                  <p className="text-gray-900 dark:text-white font-mono text-sm mt-1 ltr">{selectedLog.ip_address || '—'}</p>
                </div>
                <div>
                  <label className="text-xs font-black text-gray-600 dark:text-on-surface-variant uppercase tracking-widest">المتصفح</label>
                  <p className="text-gray-900 dark:text-white text-sm mt-1 break-all">{selectedLog.user_agent || '—'}</p>
                </div>
                <div>
                  <label className="text-xs font-black text-gray-600 dark:text-on-surface-variant uppercase tracking-widest">التاريخ</label>
                  <p className="text-gray-900 dark:text-white text-sm mt-1 font-mono ltr">
                    {new Date(selectedLog.created_at).toLocaleString('ar-EG', {
                      day: '2-digit', month: 'long', year: 'numeric',
                      hour: '2-digit', minute: '2-digit', second: '2-digit'
                    })}
                  </p>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-white/10 flex gap-3">
                <button
                  onClick={() => handleDeleteLog(selectedLog.id)}
                  className="flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-white/5 text-on-surface-variant hover:bg-white/10 font-black transition-all"
                >
                  <span className="material-symbols-outlined text-[20px]">delete</span>
                  حذف هذا السجل
                </button>
                {selectedLog.ip_address && (
                  <button
                    onClick={() => handleToggleBlockIP(selectedLog)}
                    disabled={blocking}
                    className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-black transition-all disabled:opacity-50 ${
                      isIPBlocked(selectedLog.ip_address)
                        ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20'
                        : 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      {isIPBlocked(selectedLog.ip_address) ? 'lock_open' : 'block'}
                    </span>
                    {blocking ? 'جاري...' : isIPBlocked(selectedLog.ip_address) ? 'إلغاء حظر هذا الـ IP' : 'حظر هذا الـ IP'}
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDeleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowDeleteConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white dark:bg-surface-container-low border border-gray-200 dark:border-white/10 rounded-[2.5rem] p-8 max-w-sm w-full"
              onClick={e => e.stopPropagation()}
            >
              <div className="text-center">
                <span className="material-symbols-outlined text-[60px] text-red-500">warning</span>
                <h2 className="text-2xl font-black text-gray-900 dark:text-white mt-4">مسح جميع السجلات؟</h2>
                <p className="text-gray-600 dark:text-on-surface-variant mt-2">لا يمكن التراجع عن هذا الإجراء.</p>
              </div>
              <div className="flex gap-3 mt-8">
                <button onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-6 py-3 rounded-xl bg-gray-100 dark:bg-white/5 text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-white/10 font-black transition-all"
                >
                  إلغاء
                </button>
                <button onClick={handleClearAll} disabled={deleting}
                  className="flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 font-black transition-all disabled:opacity-50"
                >
                  {deleting ? 'جاري المسح...' : 'مسح الكل'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
