import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../context/StoreContext';

export default function BlockedIPs() {
  const { store } = useStore();
  const [ips, setIps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [unblocking, setUnblocking] = useState(null);
  const [newIP, setNewIP] = useState('');
  const [newReason, setNewReason] = useState('');
  const [adding, setAdding] = useState(false);

  async function fetchBlocked() {
    if (!store?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('blocked_ips')
      .select('*')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });
    if (error) console.error(error);
    if (data) setIps(data);
    setLoading(false);
  }

  useEffect(() => {
    if (store?.id) {
      fetchBlocked();
    }
  }, [store?.id]);

  async function handleAddIP(e) {
    e.preventDefault();
    if (!newIP.trim() || !store?.id) return;
    setAdding(true);
    const { error } = await supabase.from('blocked_ips').insert({
      ip_address: newIP.trim(),
      reason: newReason.trim() || 'حظر يدوي',
      store_id: store.id
    });
    if (error) {
      if (error.code === '23505') { alert('هذا الـ IP محظور بالفعل'); }
      else { alert('حدث خطأ: ' + error.message); }
      setAdding(false);
      return;
    }
    setNewIP('');
    setNewReason('');
    setAdding(false);
    fetchBlocked();
  }

  async function handleUnblock(id) {
    if (!store?.id) return;
    setUnblocking(id);
    const { error } = await supabase.from('blocked_ips').delete().eq('id', id).eq('store_id', store.id);
    if (error) { alert('حدث خطأ: ' + error.message); setUnblocking(null); return; }
    setIps(prev => prev.filter(i => i.id !== id));
    setUnblocking(null);
  }

  return (
    <div className="space-y-8" dir="rtl">
      <div className="flex justify-between items-center bg-white/[0.02] p-8 rounded-[2.5rem] border border-white/5 backdrop-blur-md">
        <div>
          <h1 className="text-4xl font-black text-white flex items-center gap-3">
            <span className="material-symbols-outlined text-red-500 text-[40px]">block</span>
            عناوين IP المحظورة
          </h1>
          <p className="text-on-surface-variant mt-2 text-lg">إدارة عناوين IP التي تم حظرها.</p>
        </div>
        <div className="flex items-center gap-2 bg-white/5 px-4 py-2 rounded-xl">
          <span className="material-symbols-outlined text-primary text-[20px]">database</span>
          <span className="text-white font-black">{ips.length}</span>
        </div>
      </div>

      {/* Add IP Form */}
      <form onSubmit={handleAddIP} className="bg-surface-container-low border border-white/10 rounded-[2.5rem] p-6">
        <div className="flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1 w-full">
            <label className="text-xs font-black text-on-surface-variant mb-2 block">عنوان IP</label>
            <input type="text" value={newIP} onChange={e => setNewIP(e.target.value)}
              placeholder="مثال: 192.168.1.1"
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-primary transition-all font-mono ltr"
            />
          </div>
          <div className="flex-1 w-full">
            <label className="text-xs font-black text-on-surface-variant mb-2 block">السبب (اختياري)</label>
            <input type="text" value={newReason} onChange={e => setNewReason(e.target.value)}
              placeholder="سبب الحظر..."
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-primary transition-all"
            />
          </div>
          <button type="submit" disabled={adding || !newIP.trim()}
            className="w-full md:w-auto px-8 py-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 font-black transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-[20px]">block</span>
            {adding ? 'جاري الحظر...' : 'حظر IP'}
          </button>
        </div>
      </form>

      <div className="bg-surface-container-low border border-white/10 rounded-[2.5rem] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="p-4 text-xs font-black text-on-surface-variant uppercase tracking-widest">عنوان IP</th>
                <th className="p-4 text-xs font-black text-on-surface-variant uppercase tracking-widest">السبب</th>
                <th className="p-4 text-xs font-black text-on-surface-variant uppercase tracking-widest">التاريخ</th>
                <th className="p-4 text-xs font-black text-on-surface-variant uppercase tracking-widest"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="p-20 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-primary mx-auto"></div>
                </td></tr>
              ) : ips.length === 0 ? (
                <tr><td colSpan={4} className="p-20 text-center">
                  <span className="material-symbols-outlined text-[60px] text-white/20">check_circle</span>
                  <p className="text-on-surface-variant mt-4 font-bold">لا توجد عناوين IP محظورة</p>
                </td></tr>
              ) : ips.map((ip, i) => (
                <motion.tr
                  key={ip.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="p-4">
                    <span className="text-white font-mono font-bold ltr">{ip.ip_address}</span>
                  </td>
                  <td className="p-4 text-on-surface-variant text-sm">{ip.reason || '—'}</td>
                  <td className="p-4 text-on-surface-variant text-sm whitespace-nowrap font-mono ltr">
                    {new Date(ip.created_at).toLocaleString('ar-EG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => handleUnblock(ip.id)}
                      disabled={unblocking === ip.id}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-green-500/10 text-green-500 hover:bg-green-500/20 text-xs font-black transition-all disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[16px]">lock_open</span>
                      {unblocking === ip.id ? 'جاري...' : 'إلغاء الحظر'}
                    </button>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
