import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../context/ToastContext';

export default function TenantManagement() {
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const { showToast } = useToast();

  // Create Store Modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreSubdomain, setNewStoreSubdomain] = useState('');
  const [newStoreDomain, setNewStoreDomain] = useState('');
  const [newStoreExpiry, setNewStoreExpiry] = useState('');
  const [newStoreActive, setNewStoreActive] = useState(true);
  const [savingStore, setSavingStore] = useState(false);

  // Edit Store state
  const [editingStore, setEditingStore] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDomain, setEditDomain] = useState('');
  const [editExpiry, setEditExpiry] = useState('');
  const [editActive, setEditActive] = useState(true);

  const fetchStores = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('stores')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setStores(data || []);
    } catch (err) {
      console.error('Error fetching stores:', err);
      showToast('error', 'فشل تحميل بيانات المتاجر');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStores();
  }, []);

  const handleCreateStore = async (e) => {
    e.preventDefault();
    if (!newStoreName.trim() || !newStoreSubdomain.trim() || !newStoreExpiry) {
      showToast('error', 'يرجى ملء جميع الحقول المطلوبة');
      return;
    }

    setSavingStore(true);
    try {
      const cleanSubdomain = newStoreSubdomain.trim().toLowerCase();
      
      // 1. Check if subdomain exists
      const { data: existing } = await supabase
        .from('stores')
        .select('id')
        .eq('subdomain', cleanSubdomain)
        .maybeSingle();

      if (existing) {
        showToast('error', 'هذا النطاق الفرعي مستخدم بالفعل');
        setSavingStore(false);
        return;
      }

      // 2. Insert Store
      const { data: newStore, error: insertError } = await supabase
        .from('stores')
        .insert([{
          name: newStoreName.trim(),
          subdomain: cleanSubdomain,
          custom_domain: newStoreDomain.trim() || null,
          subscription_expires_at: new Date(newStoreExpiry).toISOString(),
          is_active: newStoreActive
        }])
        .select()
        .single();

      if (insertError) throw insertError;

      // 3. Create Default Site Settings for this store to prevent errors
      const { error: settingsError } = await supabase
        .from('site_settings')
        .insert([{
          store_id: newStore.id,
          brand_name: newStoreName.trim(),
          store_description: 'متجر إلكتروني جديد على منصة EG-PARTS Cloud',
          theme_colors: {
            primary: '#dc2626',
            primary_hover: '#b91c1c',
            primary_foreground: '#ffffff',
            secondary: '#1e293b',
            secondary_foreground: '#f8fafc'
          }
        }]);

      if (settingsError) throw settingsError;

      showToast('success', 'تم إنشاء المتجر وتثبيت الإعدادات الافتراضية بنجاح');
      setIsCreateModalOpen(false);
      resetForm();
      fetchStores();
    } catch (err) {
      console.error('Error creating store:', err);
      showToast('error', 'حدث خطأ أثناء إنشاء المتجر: ' + err.message);
    } finally {
      setSavingStore(false);
    }
  };

  const handleUpdateStore = async (e) => {
    e.preventDefault();
    if (!editingStore) return;

    setSavingStore(true);
    try {
      const { error } = await supabase
        .from('stores')
        .update({
          name: editName.trim(),
          custom_domain: editDomain.trim() || null,
          subscription_expires_at: new Date(editExpiry).toISOString(),
          is_active: editActive,
          updated_at: new Date().toISOString()
        })
        .eq('id', editingStore.id);

      if (error) throw error;

      showToast('success', 'تم تحديث بيانات المتجر بنجاح');
      setEditingStore(null);
      fetchStores();
    } catch (err) {
      console.error('Error updating store:', err);
      showToast('error', 'فشل تحديث بيانات المتجر: ' + err.message);
    } finally {
      setSavingStore(false);
    }
  };

  const resetForm = () => {
    setNewStoreName('');
    setNewStoreSubdomain('');
    setNewStoreDomain('');
    setNewStoreExpiry('');
    setNewStoreActive(true);
  };

  const openEditModal = (store) => {
    setEditingStore(store);
    setEditName(store.name);
    setEditDomain(store.custom_domain || '');
    // Format date for datetime-local input (YYYY-MM-DDThh:mm)
    const expiryDate = new Date(store.subscription_expires_at);
    const formatted = expiryDate.toISOString().slice(0, 16);
    setEditExpiry(formatted);
    setEditActive(store.is_active);
  };

  const filteredStores = stores.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.subdomain.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (s.custom_domain && s.custom_domain.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-white/5 pb-6">
        <div>
          <h1 className="text-3xl font-black text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[32px]">store</span>
            إدارة المتاجر (Tenants)
          </h1>
          <p className="text-sm text-gray-400 mt-1">إنشاء ومتابعة اشتراكات المتاجر والتحكم في إعدادات المنصة المتعددة.</p>
        </div>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="bg-primary hover:bg-red-700 text-white font-bold px-5 py-3 rounded-xl transition-all shadow-lg shadow-primary/20 flex items-center gap-2"
        >
          <span className="material-symbols-outlined text-[20px]">add_business</span>
          إضافة متجر جديد
        </button>
      </div>

      {/* Search and Filters */}
      <div className="flex bg-[#121218]/50 border border-white/5 p-4 rounded-2xl items-center gap-3">
        <span className="material-symbols-outlined text-gray-500">search</span>
        <input
          type="text"
          placeholder="ابحث عن متجر بالاسم أو النطاق..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="bg-transparent border-none text-white focus:outline-none w-full text-sm placeholder:text-gray-600"
        />
      </div>

      {/* Stores List */}
      {loading ? (
        <div className="text-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-primary mx-auto"></div>
          <p className="text-gray-400 text-sm mt-4 font-bold">جاري تحميل بيانات المتاجر...</p>
        </div>
      ) : filteredStores.length === 0 ? (
        <div className="text-center py-20 bg-[#121218]/30 rounded-3xl border border-white/5 text-gray-400">
          <span className="material-symbols-outlined text-[64px] text-gray-600 mb-4">storefront</span>
          <p className="font-bold">لا يوجد متاجر مطابقة للبحث</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredStores.map(s => {
            const expiry = new Date(s.subscription_expires_at);
            const isExpired = expiry < new Date();
            const statusColor = (!s.is_active || isExpired) ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-green-500/10 text-green-500 border-green-500/20';
            const statusText = isExpired ? 'منتهي الاشتراك' : s.is_active ? 'نشط' : 'متوقف مؤقتاً';

            return (
              <div key={s.id} className="bg-[#121218]/90 border border-white/5 rounded-3xl p-6 relative overflow-hidden flex flex-col justify-between hover:border-white/10 transition-colors shadow-lg">
                <div className="space-y-4">
                  {/* Store Status Badge */}
                  <div className="flex justify-between items-start">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${statusColor}`}>
                      {statusText}
                    </span>
                    <span className="text-[10px] text-gray-500 font-mono">ID: {s.id.split('-')[0]}</span>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold text-white mb-1.5">{s.name}</h3>
                    <div className="space-y-1 text-xs text-gray-400 font-mono">
                      <div className="flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[14px]">dns</span>
                        <span>{s.subdomain}.egparts.com</span>
                      </div>
                      {s.custom_domain && (
                        <div className="flex items-center gap-1.5 text-primary">
                          <span className="material-symbols-outlined text-[14px]">link</span>
                          <span>{s.custom_domain}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white/5 rounded-2xl p-4 text-xs space-y-2 border border-white/5">
                    <div className="flex justify-between text-gray-400">
                      <span>تاريخ انتهاء الاشتراك:</span>
                      <span className={`font-bold font-mono ${isExpired ? 'text-red-400' : 'text-gray-300'}`}>
                        {expiry.toLocaleDateString('ar-EG')}
                      </span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span>وقت الانتهاء بالتفصيل:</span>
                      <span className="font-mono text-gray-300">
                        {expiry.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2.5 mt-6 pt-4 border-t border-white/5">
                  <button
                    onClick={() => openEditModal(s)}
                    className="flex-1 bg-white/5 hover:bg-white/10 text-white font-bold py-2.5 rounded-xl border border-white/10 transition-all text-xs flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[16px]">edit</span>
                    تعديل البيانات
                  </button>
                  <a
                    href={
                      window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
                        ? s.custom_domain
                          ? `https://${s.custom_domain}`
                          : `https://${s.subdomain}.${
                              window.location.hostname.includes('egparts.gt.tc') 
                                ? 'egparts.gt.tc' 
                                : window.location.hostname.includes('egparts.store')
                                  ? 'egparts.store'
                                  : window.location.hostname.split('.').slice(-2).join('.')
                            }`
                        : `http://${s.subdomain}.localhost:5173`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 font-bold px-3 py-2.5 rounded-xl transition-all text-xs flex items-center justify-center"
                    title="زيارة المتجر"
                  >
                    <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Store Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121218] w-full max-w-lg rounded-3xl border border-white/10 p-6 md:p-8 shadow-2xl relative">
            <button
              onClick={() => setIsCreateModalOpen(false)}
              className="absolute top-4 left-4 bg-white/5 w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>

            <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[28px]">add_business</span>
              إضافة متجر جديد
            </h2>

            <form onSubmit={handleCreateStore} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">اسم المتجر / العلامة التجارية <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  required
                  value={newStoreName}
                  onChange={e => setNewStoreName(e.target.value)}
                  className="w-full bg-[#060608] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-primary focus:outline-none transition-colors"
                  placeholder="مثال: متجر الهدي"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">النطاق الفرعي (Subdomain) <span className="text-red-500">*</span></label>
                <div className="flex items-center bg-[#060608] border border-white/10 rounded-xl px-4 py-3 focus-within:border-primary transition-colors" dir="ltr">
                  <input
                    type="text"
                    required
                    value={newStoreSubdomain}
                    onChange={e => setNewStoreSubdomain(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))}
                    className="bg-transparent border-none text-white focus:outline-none w-full text-sm font-mono"
                    placeholder="elhoda"
                  />
                  <span className="text-gray-500 font-mono text-xs select-none">.egparts.com</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">النطاق المخصص (Custom Domain - اختياري)</label>
                <input
                  type="text"
                  value={newStoreDomain}
                  onChange={e => setNewStoreDomain(e.target.value)}
                  className="w-full bg-[#060608] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-primary focus:outline-none transition-colors text-left font-mono"
                  placeholder="www.elhoda-parts.com"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">تاريخ انتهاء الاشتراك <span className="text-red-500">*</span></label>
                <input
                  type="datetime-local"
                  required
                  value={newStoreExpiry}
                  onChange={e => setNewStoreExpiry(e.target.value)}
                  className="w-full bg-[#060608] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-primary focus:outline-none transition-colors text-left"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="newStoreActive"
                  checked={newStoreActive}
                  onChange={e => setNewStoreActive(e.target.checked)}
                  className="w-4 h-4 rounded border-white/10 text-primary focus:ring-primary bg-black/40"
                />
                <label htmlFor="newStoreActive" className="text-xs font-bold text-gray-300 cursor-pointer">تنشيط المتجر فور الإنشاء</label>
              </div>

              <button
                type="submit"
                disabled={savingStore}
                className="w-full bg-primary hover:bg-red-700 text-white font-bold py-3.5 rounded-xl transition-all disabled:opacity-50 mt-4 shadow-lg shadow-primary/10"
              >
                {savingStore ? 'جاري الإنشاء...' : 'إنشاء المتجر الجديد'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Edit Store Modal */}
      {editingStore && (
        <div className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121218] w-full max-w-lg rounded-3xl border border-white/10 p-6 md:p-8 shadow-2xl relative">
            <button
              onClick={() => setEditingStore(null)}
              className="absolute top-4 left-4 bg-white/5 w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>

            <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[28px]">edit_note</span>
              تعديل بيانات المتجر: {editingStore.name}
            </h2>

            <form onSubmit={handleUpdateStore} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">اسم المتجر / العلامة التجارية <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full bg-[#060608] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-primary focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">النطاق الفرعي (غير قابل للتعديل)</label>
                <input
                  type="text"
                  disabled
                  value={editingStore.subdomain}
                  className="w-full bg-white/5 border border-white/5 rounded-xl px-4 py-3 text-sm text-gray-500 font-mono text-left cursor-not-allowed"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">النطاق المخصص (Custom Domain)</label>
                <input
                  type="text"
                  value={editDomain}
                  onChange={e => setEditDomain(e.target.value)}
                  className="w-full bg-[#060608] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-primary focus:outline-none transition-colors text-left font-mono"
                  placeholder="www.domain.com"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1.5">تاريخ انتهاء الاشتراك <span className="text-red-500">*</span></label>
                <input
                  type="datetime-local"
                  required
                  value={editExpiry}
                  onChange={e => setEditExpiry(e.target.value)}
                  className="w-full bg-[#060608] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:border-primary focus:outline-none transition-colors text-left"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="editActive"
                  checked={editActive}
                  onChange={e => setEditActive(e.target.checked)}
                  className="w-4 h-4 rounded border-white/10 text-primary focus:ring-primary bg-black/40"
                />
                <label htmlFor="editActive" className="text-xs font-bold text-gray-300 cursor-pointer">المتجر نشط ويقبل الطلبات</label>
              </div>

              <button
                type="submit"
                disabled={savingStore}
                className="w-full bg-primary hover:bg-red-700 text-white font-bold py-3.5 rounded-xl transition-all disabled:opacity-50 mt-4 shadow-lg shadow-primary/10"
              >
                {savingStore ? 'جاري الحفظ...' : 'حفظ التعديلات'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
