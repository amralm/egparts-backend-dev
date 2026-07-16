import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../context/StoreContext';

export default function Users() {
  const { store } = useStore();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [banModal, setBanModal] = useState({ open: false, user: null, reason: 'مخالفة شروط وسياسة المتجر' });
  const [viewType, setViewType] = useState('grid'); // 'grid' or 'list'

  const [selectedUserAddresses, setSelectedUserAddresses] = useState({ open: false, addresses: [], userName: '' });
  const [loadingAddresses, setLoadingAddresses] = useState(false);

  useEffect(() => {
    if (store?.id) {
      fetchUsers();
    }
  }, [store?.id]);

  const fetchAddresses = async (user) => {
    setLoadingAddresses(true);
    setSelectedUserAddresses({ open: true, addresses: [], userName: user.full_name || user.phone });
    
    try {
      const { data, error } = await supabase
        .from('user_addresses')
        .select('*')
        .eq('user_id', user.user_id);
      
      if (error) throw error;
      setSelectedUserAddresses(prev => ({ ...prev, addresses: data || [] }));
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingAddresses(false);
    }
  };

  async function fetchUsers() {
    if (!store?.id) return;
    setLoading(true);
    try {
      // 1. Fetch profiles for this store
      const { data: profiles, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;

      // 2. Try to enrich names from orders if profile name is missing (scoped to this store)
      const enrichedUsers = await Promise.all((profiles || []).map(async (user) => {
        if (!user.full_name) {
          const { data: order } = await supabase
            .from('orders')
            .select('full_name')
            .eq('user_id', user.user_id)
            .eq('store_id', store.id)
            .limit(1)
            .maybeSingle(); // Use maybeSingle to prevent exceptions if order doesn't exist
          
          if (order?.full_name) {
            return { ...user, full_name: order.full_name };
          }
        }
        return user;
      }));

      setUsers(enrichedUsers);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const handleBan = async () => {
    if (!banModal.user || !store?.id) return;
    setLoading(true);
    const { error } = await supabase
      .from('user_profiles')
      .update({ 
        is_banned: true, 
        ban_reason: banModal.reason || 'مخالفة شروط وسياسة المتجر' 
      })
      .eq('user_id', banModal.user.user_id)
      .eq('store_id', store.id);

    if (!error) {
      setBanModal({ open: false, user: null, reason: '' });
      fetchUsers();
    }
    setLoading(false);
  };

  const handleUnban = async (userId) => {
    if (!store?.id) return;
    setLoading(true);
    const { error } = await supabase
      .from('user_profiles')
      .update({ is_banned: false, ban_reason: null })
      .eq('user_id', userId)
      .eq('store_id', store.id);
    
    if (!error) fetchUsers();
    setLoading(false);
  };

  const filteredUsers = users.filter(u => 
    u.phone?.includes(searchQuery) || 
    u.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.city?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-8" dir="rtl">
      {/* Dynamic Header Section */}
      <div className="relative overflow-hidden bg-white/[0.02] p-8 md:p-12 rounded-[3rem] border border-white/5 backdrop-blur-xl">
        <div className="absolute -right-20 -top-20 w-64 h-64 bg-primary/10 rounded-full blur-[100px]"></div>
        <div className="absolute -left-20 -bottom-20 w-64 h-64 bg-blue-500/10 rounded-full blur-[100px]"></div>
        
        <div className="relative z-10 flex flex-col lg:flex-row justify-between items-center gap-8">
          <div>
            <h1 className="text-4xl md:text-5xl font-black text-gray-900 dark:text-white leading-tight">إدارة المجتمع 👥</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-3 text-lg font-medium max-w-xl">
              تحكم كامل في أعضاء متجرك. يمكنك مراقبة النشاط، تقديم الدعم، أو حظر الحسابات المخالفة.
            </p>
          </div>
          
          <div className="flex flex-col sm:flex-row items-center gap-4 w-full lg:w-auto">
            {/* View Toggle */}
            <div className="flex bg-black/40 p-1.5 rounded-2xl border border-white/10 shrink-0">
              <button 
                onClick={() => setViewType('grid')}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${viewType === 'grid' ? 'bg-primary text-on-primary shadow-lg shadow-primary/20' : 'text-on-surface-variant hover:text-white'}`}
              >
                <span className="material-symbols-outlined text-sm">grid_view</span>
                <span className="text-xs font-black">كروت</span>
              </button>
              <button 
                onClick={() => setViewType('list')}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${viewType === 'list' ? 'bg-primary text-on-primary shadow-lg shadow-primary/20' : 'text-on-surface-variant hover:text-white'}`}
              >
                <span className="material-symbols-outlined text-sm">view_list</span>
                <span className="text-xs font-black">قائمة</span>
              </button>
            </div>

            <div className="relative w-full md:w-80 group">
              <input 
                type="text" 
                placeholder="ابحث..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-2xl px-12 py-4 text-gray-900 dark:text-white outline-none focus:border-primary transition-all font-bold"
              />
              <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 dark:text-on-surface-variant group-focus-within:text-primary transition-colors">search</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {loading && users.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-32 space-y-4">
          <span className="material-symbols-outlined animate-spin text-[60px] text-primary">progress_activity</span>
          <p className="text-on-surface-variant font-black animate-pulse">جاري جلب بيانات المجتمع...</p>
        </div>
      ) : viewType === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          <AnimatePresence mode="popLayout">
            {filteredUsers.map((user) => (
              <motion.div 
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                key={user.user_id} 
                className={`group relative bg-white dark:bg-surface-container-low border ${user.is_banned ? 'border-error/30' : 'border-gray-200 dark:border-white/5'} rounded-[2.5rem] p-8 hover:border-primary/40 transition-all duration-500 shadow-xl shadow-black/5 dark:shadow-black/40`}
              >
                {/* User Status Badge */}
                <div className="absolute top-6 left-6 flex flex-col items-end gap-2">
                  {user.is_banned ? (
                    <span className="flex items-center gap-1.5 px-4 py-1.5 bg-error text-white text-[10px] font-black rounded-full shadow-lg shadow-error/30 uppercase tracking-tighter">
                      <span className="material-symbols-outlined text-[14px]">block</span> محظور
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 px-4 py-1.5 bg-green-500 text-white text-[10px] font-black rounded-full shadow-lg shadow-green-500/30 uppercase tracking-tighter">
                      <span className="material-symbols-outlined text-[14px]">verified_user</span> نشط
                    </span>
                  )}
                  
                  {user.phone ? (
                    <span className="flex items-center gap-1 px-3 py-1 bg-blue-500/10 text-blue-400 text-[9px] font-black rounded-full border border-blue-500/20">
                      <span className="material-symbols-outlined text-[12px]">verified</span> موثق
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 px-3 py-1 bg-amber-500/10 text-amber-500 text-[9px] font-black rounded-full border border-amber-500/20">
                      <span className="material-symbols-outlined text-[12px]">close</span> غير موثق
                    </span>
                  )}
                </div>

                {/* Avatar & Basic Info */}
                <div className="flex flex-col items-center text-center mt-4">
                  <div className={`w-24 h-24 rounded-[2rem] flex items-center justify-center font-black text-3xl mb-6 relative group-hover:rotate-6 transition-transform duration-500 ${user.is_banned ? 'bg-error/20 text-error' : 'bg-primary/20 text-primary'}`}>
                    <div className="absolute inset-0 bg-current opacity-10 rounded-[2rem] blur-xl group-hover:blur-2xl transition-all"></div>
                    {(user.full_name || user.phone || 'U').charAt(0).toUpperCase()}
                  </div>
                  <h3 className="text-2xl font-black text-gray-900 dark:text-white mb-1 group-hover:text-primary transition-colors">
                    {user.full_name || `عميل #${user.user_id.slice(-4)}`}
                  </h3>
                  <p className="text-primary/80 dark:text-primary/60 text-xs font-bold mb-3">{user.email || 'بدون بريد إلكتروني'}</p>
                  <p className="text-gray-600 dark:text-gray-400 font-mono text-sm tracking-widest">{user.phone || 'بدون هاتف'}</p>
                </div>

                {/* Stats / Details Section */}
                <div className="mt-8 grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 dark:bg-black/20 p-4 rounded-2xl border border-gray-200 dark:border-white/5 text-center">
                    <p className="text-[10px] text-primary/80 font-black uppercase mb-1">المدينة</p>
                    <p className="text-gray-900 dark:text-white font-bold truncate">{user.city || '—'}</p>
                  </div>
                  <div className="bg-gray-50 dark:bg-black/20 p-4 rounded-2xl border border-gray-200 dark:border-white/5 text-center">
                    <p className="text-[10px] text-primary/80 font-black uppercase mb-1">منذ</p>
                    <p className="text-gray-900 dark:text-white font-bold">{user.created_at ? new Date(user.created_at).getFullYear() : '—'}</p>
                  </div>
                </div>

                {/* Actions Button Grid */}
                <div className="mt-8 grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => fetchAddresses(user)}
                    className="col-span-2 bg-primary/10 text-primary py-3 rounded-2xl hover:bg-primary hover:text-white transition-all font-black text-xs flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[18px]">location_on</span> عرض العناوين ({user.address_count || '...'})
                  </button>
                  <button 
                    onClick={() => window.open(`https://wa.me/${user.phone}`, '_blank')}
                    className="flex-1 bg-green-500/10 text-green-500 py-4 rounded-2xl hover:bg-green-500 hover:text-white transition-all font-black text-xs flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[18px]">forum</span> واتساب
                  </button>
                  
                  {user.is_banned ? (
                    <button 
                      onClick={() => handleUnban(user.user_id)}
                      className="flex-1 bg-blue-500/10 text-blue-500 py-4 rounded-2xl hover:bg-blue-500 hover:text-white transition-all font-black text-xs flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-[18px]">lock_open</span> فك الحظر
                    </button>
                  ) : (
                    <button 
                      onClick={() => setBanModal({ open: true, user, reason: 'مخالفة شروط وسياسة المتجر' })}
                      className="flex-1 bg-error/10 text-error py-4 rounded-2xl hover:bg-error hover:text-white transition-all font-black text-xs flex items-center justify-center gap-2 shadow-lg shadow-error/10"
                    >
                      <span className="material-symbols-outlined text-[18px]">block</span> حظر
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        /* List View Implementation */
        <div className="bg-white dark:bg-surface-container-low border border-gray-200 dark:border-white/5 rounded-[2.5rem] overflow-hidden shadow-xl dark:shadow-2xl backdrop-blur-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-gray-50 dark:bg-white/5 text-gray-600 dark:text-on-surface-variant text-[10px] uppercase tracking-[0.2em] font-black border-b border-gray-200 dark:border-white/5">
                  <th className="p-8">العميل</th>
                  <th className="p-8">رقم الهاتف</th>
                  <th className="p-8">المدينة</th>
                  <th className="p-8">الحالة</th>
                  <th className="p-8 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence mode="popLayout">
                  {filteredUsers.map((user) => (
                    <motion.tr 
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      key={user.user_id} 
                      className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-all group"
                    >
                      <td className="p-8">
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center font-black text-lg ${user.is_banned ? 'bg-error/20 text-error' : 'bg-primary/20 text-primary'}`}>
                            {(user.full_name || user.phone || 'U').charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-gray-900 dark:text-white font-bold text-lg leading-tight">{user.full_name || `عميل #${user.user_id.slice(-4)}`}</p>
                            <p className="text-primary/80 dark:text-primary/60 text-[10px] font-bold mb-1">{user.email || '—'}</p>
                            <p className="text-gray-500 dark:text-on-surface-variant text-[10px] font-mono opacity-50">#{user.user_id.slice(0, 8)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-8 font-mono text-gray-600 dark:text-white/80 font-bold">{user.phone || '—'}</td>
                      <td className="p-8 text-gray-900 dark:text-on-surface font-medium">{user.city || '—'}</td>
                      <td className="p-8">
                        <div className="flex flex-col gap-2">
                          {user.is_banned ? (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-error/20 text-error text-[10px] font-black rounded-lg border border-error/20">
                              محظور
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-green-500/20 text-green-500 text-[10px] font-black rounded-lg border border-green-500/20">
                              نشط
                            </span>
                          )}
                          
                          {user.phone ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 text-blue-400 text-[9px] font-black rounded-md border border-blue-500/10">
                              موثق
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 text-amber-500 text-[9px] font-black rounded-md border border-amber-500/10">
                              غير موثق
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-8">
                        <div className="flex justify-end gap-3 opacity-0 group-hover:opacity-100 transition-all">
                             <button 
                              onClick={() => fetchAddresses(user)}
                              className="w-10 h-10 bg-primary/10 text-primary rounded-xl hover:bg-primary hover:text-white transition-all flex items-center justify-center"
                              title="عرض العناوين"
                            >
                              <span className="material-symbols-outlined text-[18px]">location_on</span>
                            </button>
                            <button 
                              onClick={() => window.open(`https://wa.me/${user.phone}`, '_blank')}
                              className="w-10 h-10 bg-green-500/10 text-green-500 rounded-xl hover:bg-green-500 hover:text-white transition-all flex items-center justify-center"
                              title="واتساب"
                            >
                              <span className="material-symbols-outlined text-[18px]">forum</span>
                            </button>
                            {user.is_banned ? (
                              <button 
                                onClick={() => handleUnban(user.user_id)}
                                className="w-10 h-10 bg-blue-500/10 text-blue-500 rounded-xl hover:bg-blue-500 hover:text-white transition-all flex items-center justify-center"
                                title="فك الحظر"
                              >
                                <span className="material-symbols-outlined text-[18px]">lock_open</span>
                              </button>
                            ) : (
                              <button 
                                onClick={() => setBanModal({ open: true, user, reason: 'مخالفة شروط وسياسة المتجر' })}
                                className="w-10 h-10 bg-error/10 text-error rounded-xl hover:bg-error hover:text-white transition-all flex items-center justify-center"
                                title="حظر"
                              >
                                <span className="material-symbols-outlined text-[18px]">block</span>
                              </button>
                            )}
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Addresses Modal */}
      <AnimatePresence>
        {selectedUserAddresses.open && (
          <div className="fixed inset-0 z-[400] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md" dir="rtl">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white dark:bg-surface-container-lowest border border-gray-200 dark:border-white/10 rounded-[3rem] w-full max-w-2xl p-10 shadow-2xl dark:shadow-3xl overflow-hidden relative"
            >
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h2 className="text-3xl font-black text-gray-900 dark:text-white">عناوين الشحن 📍</h2>
                  <p className="text-gray-600 dark:text-on-surface-variant font-bold mt-1">العميل: {selectedUserAddresses.userName}</p>
                </div>
                <button onClick={() => setSelectedUserAddresses({ ...selectedUserAddresses, open: false })} className="text-gray-500 dark:text-on-surface-variant hover:text-primary dark:hover:text-white">
                  <span className="material-symbols-outlined text-[32px]">close</span>
                </button>
              </div>

              <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {loadingAddresses ? (
                  <div className="py-20 text-center"><span className="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span></div>
                ) : selectedUserAddresses.addresses.length === 0 ? (
                  <div className="py-20 text-center bg-white/5 rounded-3xl">
                    <span className="material-symbols-outlined text-5xl text-on-surface-variant/30 mb-4">home_pin</span>
                    <p className="text-on-surface-variant font-bold">لا توجد عناوين مسجلة لهذا العميل</p>
                  </div>
                ) : (
                  selectedUserAddresses.addresses.map(addr => (
                    <div key={addr.id} className="bg-white/5 border border-white/10 p-6 rounded-2xl flex justify-between items-center">
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <h4 className="text-white font-black">{addr.title}</h4>
                          {addr.is_default && <span className="bg-primary/20 text-primary text-[10px] px-2 py-0.5 rounded-full font-black">افتراضي</span>}
                        </div>
                        <p className="text-on-surface-variant text-sm font-bold">{addr.city} - {addr.address}</p>
                        <p className="text-primary text-xs font-mono mt-2">{addr.phone}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Ban Reason Modal */}
      <AnimatePresence>
        {banModal.open && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-surface-container-lowest border border-white/10 rounded-[3rem] w-full max-w-lg p-10 shadow-3xl text-center"
            >
              <div className="w-20 h-20 bg-error/20 text-error rounded-full flex items-center justify-center mx-auto mb-6">
                <span className="material-symbols-outlined text-[40px]">security</span>
              </div>
              
              <h2 className="text-3xl font-black text-white mb-2">تأكيد حظر الحساب</h2>
              <p className="text-on-surface-variant mb-8 font-medium">أنت على وشك حظر حساب <span className="text-white font-bold">{banModal.user?.full_name}</span>. يرجى تحديد السبب ليظهر له.</p>

              <div className="space-y-4 text-right">
                <label className="text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">سبب الحظر</label>
                <textarea 
                  className="w-full bg-black/40 border border-white/10 rounded-2xl p-5 text-white outline-none focus:border-error transition-all h-32 resize-none" 
                  placeholder="أدخل سبب الحظر بالتفصيل..." 
                  value={banModal.reason}
                  onChange={(e) => setBanModal({...banModal, reason: e.target.value})}
                />
              </div>

              <div className="flex gap-4 mt-10">
                <button 
                  onClick={handleBan}
                  className="flex-1 bg-error text-white py-5 rounded-2xl font-black text-lg hover:bg-red-600 transition-all shadow-xl shadow-error/20"
                >
                  حظر الآن
                </button>
                <button 
                  onClick={() => setBanModal({ open: false, user: null, reason: '' })}
                  className="px-10 py-5 bg-white/5 text-white rounded-2xl hover:bg-white/10 transition-all font-bold"
                >
                  إلغاء
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
