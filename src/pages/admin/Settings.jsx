import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useStore } from '../../context/StoreContext';
import { uploadFileToR2, deleteFileFromR2, getMediaUrl } from '../../utils/uploadHelper';

// ─── Reusable Toggle Switch ───
function Toggle({ checked, onChange, color = 'green' }) {
  const colorMap = {
    green: 'bg-green-500', purple: 'bg-purple-500', orange: 'bg-orange-500',
    amber: 'bg-amber-500', emerald: 'bg-emerald-500', rose: 'bg-rose-500',
    sky: 'bg-sky-500', red: 'bg-red-500', blue: 'bg-blue-500',
  };
  return (
    <label className="flex items-center cursor-pointer shrink-0">
      <div className="relative">
        <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
        <div className={`block w-11 h-6 rounded-full transition-colors ${checked ? (colorMap[color] || colorMap.green) : 'bg-gray-600'}`}></div>
        <div className={`absolute right-0.5 top-0.5 bg-white w-5 h-5 rounded-full transition-transform shadow-sm ${checked ? '-translate-x-[20px]' : 'translate-x-0'}`}></div>
      </div>
    </label>
  );
}

// ─── Reusable Feature Row ───
function FeatureRow({ icon, iconColor, title, description, children, disabled }) {
  return (
    <div className={`flex items-center justify-between p-4 rounded-xl border border-white/5 dark:bg-white/[0.02] bg-gray-50 transition-all hover:border-white/10 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className={`material-symbols-outlined text-2xl shrink-0 ${iconColor}`}>{icon}</span>
        <div className="min-w-0">
          <h4 className="font-bold text-sm text-gray-900 dark:text-white">{title}</h4>
          {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{description}</p>}
        </div>
      </div>
      <div className="shrink-0 mr-4">{children}</div>
    </div>
  );
}

// ─── Modern Two-Column Section ───
function SettingSection({ title, description, icon, iconColor, children }) {
  return (
    <div className="flex flex-col xl:flex-row gap-6 xl:gap-12 py-8 border-b border-gray-200 dark:border-white/10 last:border-0">
      <div className="xl:w-1/3 shrink-0">
        <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2 mb-2">
          {icon && <span className={`material-symbols-outlined ${iconColor}`}>{icon}</span>}
          {title}
        </h3>
        {description && <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{description}</p>}
      </div>
      <div className="xl:w-2/3">
        <div className="bg-white dark:bg-white/[0.02] rounded-2xl border border-gray-200 dark:border-white/[0.06] p-6 shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Section Tab Definitions ───
const TABS = [
  { id: 'branding', label: 'الهوية والتخصيص', icon: 'branding_watermark', color: 'text-blue-400' },
  { id: 'theme', label: 'نظام الألوان', icon: 'palette', color: 'text-violet-400' },
  { id: 'flash', label: 'العرض الخاص', icon: 'local_fire_department', color: 'text-red-400' },
  { id: 'features', label: 'الميزات التفاعلية', icon: 'tune', color: 'text-cyan-400' },
  { id: 'hotdeals', label: 'العروض النارية', icon: 'whatshot', color: 'text-amber-400' },
  { id: 'dev', label: 'خيارات المطورين', icon: 'developer_mode', color: 'text-gray-400' },
];

export default function Settings() {
  const { store } = useStore();
  const [activeTab, setActiveTab] = useState('branding');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  const [settings, setSettings] = useState({
    flash_sale_active: true,
    flash_sale_title: 'عرض اليوم! 🔥',
    flash_sale_desc: 'خصم 15% على جميع كمبروسرات LG',
    flash_sale_end_time: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
    social_proof_active: true,
    social_proof_demo: true,
    cross_sell_active: true,
    cross_sell_demo: true,
    low_stock_warning_enabled: true,
    low_stock_threshold: 100,
    live_view_enabled: true,
    live_view_base: 15,
    today_sales_enabled: true,
    today_sales_count: 87,
    free_shipping_enabled: true,
    free_shipping_threshold: 500,
    guarantee_badge_enabled: true,
    guarantee_text: 'ضمان سنتين على جميع المنتجات',
    brand_name: 'EG-PARTS',
    store_description: '',
    copyright_text: '',
    support_hours: '',
    logo_url: '',
    favicon_url: '',
    whatsapp_number: '',
    vodafone_cash_number: '',
    payment_screenshot_number: '',
    order_confirmation_number: '',
    support_email: '',
    store_address: '',
    facebook_url: '',
    instagram_url: '',
    tiktok_url: '',
    theme_colors: {
      primary: '#dc2626', primary_hover: '#b91c1c', primary_foreground: '#ffffff',
      secondary: '#4b5563', secondary_foreground: '#ffffff',
      background: '#0e141c', surface: '#161c24', surface_2: '#1a2028',
      text: '#dde3ee', text_muted: '#dbc2ad',
      border: '#a38d7a', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444'
    }
  });
  const [dbData, setDbData] = useState(null);
  const [debugError, setDebugError] = useState(null);
  const [userEmail, setUserEmail] = useState('جارِ التحميل...');
  const [showDebug, setShowDebug] = useState(false);
  const [pendingDeletes, setPendingDeletes] = useState([]);

  const [hotDeals, setHotDeals] = useState({
    active: false, badge_text: 'عرض ناري', end_time: '', product_ids: []
  });
  const [selectedProductsList, setSelectedProductsList] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchTimeout = useRef(null);

  // Guarantee badge product search state
  const [guaranteeProductIds, setGuaranteeProductIds] = useState([]);
  const [guaranteeSelectedProducts, setGuaranteeSelectedProducts] = useState([]);
  const [guaranteeSearchQuery, setGuaranteeSearchQuery] = useState('');
  const [guaranteeSearchResults, setGuaranteeSearchResults] = useState([]);
  const [guaranteeSearching, setGuaranteeSearching] = useState(false);
  const [guaranteeShowResults, setGuaranteeShowResults] = useState(false);
  const searchGuaranteeTimeout = useRef(null);

  useEffect(() => { fetchSelectedProducts(); }, [hotDeals.product_ids]);

  async function fetchSelectedProducts() {
    const ids = hotDeals.product_ids;
    if (!ids || ids.length === 0) { setSelectedProductsList([]); return; }
    if (!store?.id) return;
    const { data } = await supabase.from('products').select('id, name, image').eq('store_id', store.id).in('id', ids);
    if (data) setSelectedProductsList(data);
  }

  const defaultThemeColors = {
    primary: '#dc2626', primary_hover: '#b91c1c', primary_foreground: '#ffffff',
    secondary: '#4b5563', secondary_foreground: '#ffffff',
    background: '#0e141c', surface: '#161c24', surface_2: '#1a2028',
    text: '#dde3ee', text_muted: '#dbc2ad',
    border: '#a38d7a', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444'
  };

  const handleColorChange = (key, value) => {
    setSettings(prev => ({
      ...prev,
      theme_colors: { ...(prev.theme_colors || defaultThemeColors), [key]: value }
    }));
  };

  const restoreDefaultColors = () => {
    setSettings(prev => ({ ...prev, theme_colors: defaultThemeColors }));
  };

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearchQuery(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!val.trim()) { setSearchResults([]); setShowResults(false); return; }
    searchTimeout.current = setTimeout(async () => {
      if (!store?.id) return;
      setSearching(true);
      const { data } = await supabase.from('products').select('id, name, image').eq('store_id', store.id).ilike('name', `%${val}%`).limit(8);
      setSearchResults(data || []);
      setShowResults(true);
      setSearching(false);
    }, 300);
  };

  const addHotDealProduct = (id) => {
    if (!hotDeals.product_ids.includes(id)) {
      setHotDeals({ ...hotDeals, product_ids: [...hotDeals.product_ids, id] });
    }
    setSearchQuery(''); setSearchResults([]); setShowResults(false);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
  };

  const removeHotDealProduct = (id) => {
    setHotDeals({ ...hotDeals, product_ids: hotDeals.product_ids.filter(pid => pid !== id) });
  };

  // Guarantee product search
  const handleGuaranteeSearchChange = (e) => {
    const val = e.target.value;
    setGuaranteeSearchQuery(val);
    if (searchGuaranteeTimeout.current) clearTimeout(searchGuaranteeTimeout.current);
    if (!val.trim()) { setGuaranteeSearchResults([]); setGuaranteeShowResults(false); return; }
    searchGuaranteeTimeout.current = setTimeout(async () => {
      if (!store?.id) return;
      setGuaranteeSearching(true);
      const { data } = await supabase.from('products').select('id, name, image').eq('store_id', store.id).ilike('name', `%${val}%`).limit(8);
      setGuaranteeSearchResults(data || []);
      setGuaranteeShowResults(true);
      setGuaranteeSearching(false);
    }, 300);
  };

  const addGuaranteeProduct = (product) => {
    const id = product.id;
    if (!guaranteeProductIds.includes(id)) {
      setGuaranteeProductIds(prev => [...prev, id]);
      setGuaranteeSelectedProducts(prev => [...prev, { id: product.id, name: product.name, image: product.image }]);
    }
    setGuaranteeSearchQuery(''); setGuaranteeSearchResults([]); setGuaranteeShowResults(false);
    if (searchGuaranteeTimeout.current) clearTimeout(searchGuaranteeTimeout.current);
  };

  const removeGuaranteeProduct = (id) => {
    setGuaranteeProductIds(prev => prev.filter(pid => pid !== id));
    setGuaranteeSelectedProducts(prev => prev.filter(p => p.id !== id));
  };

  async function fetchGuaranteeProducts() {
    if (!store?.id) return;
    const { data } = await supabase.from('products').select('id, name, image').eq('store_id', store.id).eq('guarantee_badge', true);
    if (data) {
      setGuaranteeSelectedProducts(data);
      setGuaranteeProductIds(data.map(p => p.id));
    }
  }

  useEffect(() => {
    if (store?.id) {
      fetchSettings();
    }
  }, [store?.id]);

  async function fetchSettings() {
    if (!store?.id) return;
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    setUserEmail(user?.email || 'غير مسجل دخول');

    const { data, error } = await supabase
      .from('site_settings')
      .select('*')
      .eq('store_id', store.id);

    if (data) {
      setDbData(data);
      const row = data[0];
      if (row) {
        setSettings({
          ...row,
          theme_colors: row.theme_colors || defaultThemeColors,
          flash_sale_end_time: row.flash_sale_end_time ? new Date(row.flash_sale_end_time).toISOString().slice(0, 16) : ''
        });
        const hd = row.hot_deals || {};
        setHotDeals({
          active: hd.active || false,
          badge_text: hd.badge_text || 'عرض ناري',
          end_time: hd.end_time ? new Date(hd.end_time).toISOString().slice(0, 16) : '',
          product_ids: Array.isArray(hd.product_ids) ? hd.product_ids : []
        });
      } else {
        setDebugError("لم يتم العثور على إعدادات خاصة بهذا المتجر.");
      }
    } else if (error) {
      console.error('Error fetching settings:', error);
      setDebugError(JSON.stringify(error, null, 2));
      setToastMessage('حدث خطأ أثناء تحميل الإعدادات. الرجاء التأكد من اتصالك وقاعدة البيانات.');
    }
    // Load guarantee badge products
    await fetchGuaranteeProducts();
    setLoading(false);
  }

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(''), 3000);
  };

  const handleSave = async (e) => {
    e.preventDefault();

    // URL Validation for Socials
    const urlPattern = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
    if (settings.facebook_url && !urlPattern.test(settings.facebook_url)) {
      showToast('رابط فيسبوك غير صالح');
      return;
    }
    if (settings.instagram_url && !urlPattern.test(settings.instagram_url)) {
      showToast('رابط انستجرام غير صالح');
      return;
    }
    if (settings.tiktok_url && !urlPattern.test(settings.tiktok_url)) {
      showToast('رابط تيك توك غير صالح');
      return;
    }

    setSaving(true);

    // Normalize all phone numbers (digits and leading + only)
    const cleanPhone = (val) => (val || '').replace(/[^\d+]/g, '');
    const wa = cleanPhone(settings.whatsapp_number);

    const dbSettings = {
      ...settings,
      whatsapp_number: wa,
      vodafone_cash_number: cleanPhone(settings.vodafone_cash_number),
      payment_screenshot_number: cleanPhone(settings.payment_screenshot_number),
      order_confirmation_number: cleanPhone(settings.order_confirmation_number),
      flash_sale_end_time: settings.flash_sale_end_time ? new Date(settings.flash_sale_end_time).toISOString() : null,
      hot_deals: {
        active: hotDeals.active,
        badge_text: hotDeals.badge_text,
        end_time: hotDeals.end_time ? new Date(hotDeals.end_time).toISOString() : null,
        product_ids: hotDeals.product_ids
      }
    };

    const { id, store_id, created_at, updated_at, ...updatePayload } = dbSettings;

    const { data, error } = await supabase
      .from('site_settings')
      .update(updatePayload)
      .eq('store_id', store.id)
      .select();

    if (!error) {
      if (data && data.length > 0) {
        // Sync guarantee badge products
        try {
          if (guaranteeProductIds.length > 0) {
            await supabase.from('products').update({ guarantee_badge: false }).eq('store_id', store.id).neq('guarantee_badge', false);
            await supabase.from('products').update({ guarantee_badge: true }).eq('store_id', store.id).in('id', guaranteeProductIds);
          } else {
            await supabase.from('products').update({ guarantee_badge: false }).eq('store_id', store.id).eq('guarantee_badge', true);
          }
        } catch (syncErr) {
          console.error('Guarantee badge sync error:', syncErr);
        }

        // Clean up old files from R2 only if DB save succeeded
        if (pendingDeletes.length > 0) {
          Promise.all(pendingDeletes.map(key => deleteFileFromR2(key)))
            .catch(console.error);
          setPendingDeletes([]);
        }

        showToast('تم حفظ الإعدادات بنجاح! 🚀');
        setDebugError(null);
        fetchSettings();
      } else {
        setDebugError("عملية التحديث لم تُرجع أي أخطاء، ولكن لم يتم تحديث أي صف! (تأكد أن المتجر مهيأ بالإعدادات)");
        showToast('فشل التحديث: إعدادات المتجر غير موجودة.');
      }
    } else {
      setDebugError(JSON.stringify(error, null, 2));
      showToast('فشل في حفظ الإعدادات.');
    }
    setSaving(false);
  };

  const handleImageUpload = async (e, field) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setSaving(true);
    showToast('جاري رفع الصورة...');
    
    try {
      const newKey = await uploadFileToR2({ file, category: 'logos' });
      const oldKey = settings[field];
      if (oldKey && !oldKey.startsWith('http://') && !oldKey.startsWith('https://')) {
        setPendingDeletes(prev => [...prev, oldKey]);
      }
      setSettings(prev => ({ ...prev, [field]: newKey }));
      showToast('تم رفع الصورة بنجاح');
    } catch (err) {
      console.error('Error uploading image to R2:', err);
      showToast(err.message || 'فشل رفع الصورة!');
    } finally {
      setSaving(false);
    }
  };

  // ─── Input helper class ───
  const inputCls = "w-full bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all placeholder:text-gray-400 dark:placeholder:text-gray-500";
  const labelCls = "block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide";

  if (loading) {
    return <div className="flex justify-center items-center min-h-[60vh]"><span className="material-symbols-outlined animate-spin text-4xl text-primary">progress_activity</span></div>;
  }

  // ───────────────── Product Search Dropdown (shared) ─────────────────
  const ProductSearchDropdown = ({ query, onChange, results, showDrop, loading: isSearching, onSelect, selectedIds, borderColor = 'primary' }) => (
    <div className="relative">
      <span className="material-symbols-outlined absolute right-3 top-3 text-gray-400 text-[20px]">search</span>
      <input type="text" placeholder="ابحث عن منتج لإضافته..." value={query} onChange={onChange}
        className={`${inputCls} pr-10`} />
      {isSearching && <div className="absolute left-3 top-3"><span className="material-symbols-outlined animate-spin text-primary text-[20px]">progress_activity</span></div>}
      {showDrop && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-[#1e293b] border border-gray-200 dark:border-white/10 rounded-xl max-h-48 overflow-y-auto shadow-2xl">
          {results.map((p) => (
            <button key={p.id} onClick={() => onSelect(p)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors text-right">
              {p.image ? <img src={p.image} className="w-8 h-8 rounded-lg object-cover" /> : <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-white/5 flex items-center justify-center"><span className="material-symbols-outlined text-[14px] text-gray-400">image</span></div>}
              <span className="text-gray-800 dark:text-white text-sm flex-1 truncate">{p.name}</span>
              {selectedIds.includes(p.id) ? (
                <span className="text-green-500 text-xs font-bold shrink-0">✓ مضاف</span>
              ) : (
                <span className="text-primary text-xs font-bold shrink-0">+ إضافة</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const SelectedProductChip = ({ product, onRemove }) => (
    <div className="flex items-center gap-3 bg-gray-50 dark:bg-white/[0.03] p-2.5 rounded-xl border border-gray-100 dark:border-white/5">
      {product.image ? <img src={product.image} className="w-10 h-10 rounded-lg object-cover" /> : <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-white/5 flex items-center justify-center"><span className="material-symbols-outlined text-[18px] text-gray-400">image</span></div>}
      <span className="text-gray-800 dark:text-white text-sm flex-1 truncate">{product.name}</span>
      <button onClick={onRemove} className="text-red-400 hover:text-red-500 transition-colors p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10"><span className="material-symbols-outlined text-[18px]">close</span></button>
    </div>
  );

  return (
    <div className="min-h-[calc(100vh-80px)]" dir="rtl">
      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-green-500 text-white px-6 py-3 rounded-xl shadow-[0_0_30px_rgba(34,197,94,0.4)] animate-fade-in flex items-center gap-2 font-bold">
          <span className="material-symbols-outlined">check_circle</span>
          {toastMessage}
        </div>
      )}

      {/* Header */}
      <div className="mb-8">
        <h2 className="text-3xl font-black text-gray-900 dark:text-white flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-[36px]">settings</span>
          إعدادات المتجر
        </h2>
        <p className="text-gray-500 dark:text-gray-400 mt-1">تحكم في الهوية، العروض، الميزات التفاعلية، والألوان من مكان واحد.</p>
      </div>

      <form onSubmit={handleSave}>
        <div className="flex gap-6">
          {/* ─── Sidebar Navigation ─── */}
          <div className="w-56 shrink-0 hidden lg:block">
            <div className="sticky top-4 space-y-1">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-right ${
                    activeTab === tab.id
                      ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}
                >
                  <span className={`material-symbols-outlined text-[20px] ${activeTab === tab.id ? 'text-primary' : tab.color}`}>{tab.icon}</span>
                  {tab.label}
                </button>
              ))}

              {/* Save Button in sidebar */}
              <div className="pt-4 mt-4 border-t border-gray-200 dark:border-white/10">
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full bg-primary text-white font-bold px-4 py-3 rounded-xl flex items-center justify-center gap-2 hover:brightness-110 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {saving ? (
                    <><span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span> جاري الحفظ...</>
                  ) : (
                    <><span className="material-symbols-outlined text-[20px]">save</span> حفظ التغييرات</>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* ─── Mobile Tab Bar ─── */}
          <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-[#0f172a] border-t border-gray-200 dark:border-white/10 px-2 py-2 flex gap-1 overflow-x-auto">
            {TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all shrink-0 ${
                  activeTab === tab.id ? 'bg-primary/10 text-primary' : 'text-gray-400'
                }`}
              >
                <span className="material-symbols-outlined text-[20px]">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          {/* ─── Content Area ─── */}
          <div className="flex-1 min-w-0 space-y-6 pb-24 lg:pb-0">

            {/* ════════════════ TAB: BRANDING ════════════════ */}
            {activeTab === 'branding' && (
              <div className="animate-fade-in -my-8">
                {/* Basic Info */}
                <SettingSection title="المعلومات الأساسية" description="تحكم في اسم المتجر، وصف المتجر، وساعات العمل التي تظهر في تذييل الموقع (Footer) وللمحركات." icon="store" iconColor="text-blue-400">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div>
                      <label className={labelCls}>اسم المتجر</label>
                      <input type="text" value={settings.brand_name || ''} onChange={(e) => setSettings({...settings, brand_name: e.target.value})} className={inputCls} />
                    </div>
                  </div>
                  <div className="mt-5">
                    <label className={labelCls}>وصف المتجر (Footer & SEO)</label>
                    <textarea value={settings.store_description || ''} onChange={(e) => setSettings({...settings, store_description: e.target.value})} className={`${inputCls} h-24 resize-none`} placeholder="اكتب وصفاً جذاباً لمتجرك..." />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
                    <div>
                      <label className={labelCls}>حقوق النشر</label>
                      <input type="text" value={settings.copyright_text || ''} onChange={(e) => setSettings({...settings, copyright_text: e.target.value})} className={inputCls} placeholder="© 2024 اسم متجرك" />
                    </div>
                    <div>
                      <label className={labelCls}>ساعات العمل والدعم</label>
                      <input type="text" value={settings.support_hours || ''} onChange={(e) => setSettings({...settings, support_hours: e.target.value})} className={inputCls} placeholder="يومياً من 9 صباحاً حتى 10 مساءً" />
                    </div>
                  </div>
                </SettingSection>

                {/* Payment & Contact Numbers */}
                <SettingSection title="أرقام الدفع والتواصل" description="تحكم في الأرقام المستخدمة في عملية الشراء والدفع. كل رقم قابل للتعديل في أي وقت من هنا دون الحاجة لتعديل الكود." icon="contact_phone" iconColor="text-green-400">
                  {/* Unified number convenience */}
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5 p-4 rounded-xl bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20">
                    <span className="material-symbols-outlined text-green-500 text-[20px] shrink-0">link</span>
                    <p className="text-xs text-green-700 dark:text-green-300 flex-1 leading-relaxed">
                      <b>رقم موحّد؟</b> إذا كنت تستخدم نفس الرقم لكل العمليات (تأكيد الطلب + استلام صور التحويل)، فعّل الخيار بالأسفل وأدخل الرقم مرة واحدة وسيتم تعبئة الحقول الثلاثة تلقائياً.
                    </p>
                  </div>

                  <div className="flex items-center justify-between mb-4 p-3 rounded-xl bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10">
                    <div>
                      <h4 className="font-bold text-sm text-gray-900 dark:text-white">استخدام رقم موحّد لكل العمليات</h4>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">ينسخ الرقم نفسه إلى الحقول الثلاثة لتسهيل الإعداد.</p>
                    </div>
                    <Toggle
                      checked={
                        settings.whatsapp_number &&
                        settings.whatsapp_number === settings.order_confirmation_number &&
                        settings.whatsapp_number === settings.payment_screenshot_number
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          const unified = settings.order_confirmation_number || settings.whatsapp_number || '';
                          setSettings({
                            ...settings,
                            whatsapp_number: unified,
                            order_confirmation_number: unified,
                            payment_screenshot_number: unified
                          });
                        }
                      }}
                      color="green"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    <div>
                      <label className={labelCls}>رقم فودافون كاش (التحويل)</label>
                      <input type="text" value={settings.vodafone_cash_number || ''} onChange={(e) => setSettings({...settings, vodafone_cash_number: e.target.value})} className={inputCls} dir="ltr" placeholder="0101..." />
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">الرقم الذي يحوّل إليه العميل المبلغ.</p>
                    </div>
                    <div>
                      <label className={labelCls}>رقم استلام صور التحويل (واتساب)</label>
                      <input type="text" value={settings.payment_screenshot_number || ''} onChange={(e) => setSettings({...settings, payment_screenshot_number: e.target.value})} className={inputCls} dir="ltr" placeholder="+2010..." />
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">يرسل إليه العميل صورة تأكيد التحويل.</p>
                    </div>
                    <div>
                      <label className={labelCls}>رقم تأكيد الطلب (واتساب)</label>
                      <input type="text" value={settings.order_confirmation_number || settings.whatsapp_number || ''} onChange={(e) => setSettings({...settings, order_confirmation_number: e.target.value, whatsapp_number: e.target.value})} className={inputCls} dir="ltr" placeholder="+2010..." />
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">يُحوَّل إليه العميل لتأكيد الطلب بعد الشراء.</p>
                    </div>
                  </div>

                  <div className="mt-5 p-4 rounded-xl bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 flex gap-3 text-blue-600 dark:text-blue-400">
                    <span className="material-symbols-outlined shrink-0 text-[20px]">info</span>
                    <p className="text-sm font-bold leading-relaxed">هذه الأرقام تظهر تلقائياً للعميل أثناء عملية الشراء وبعدها (صفحة نجاح الدفع). أي تعديل هنا ينعكس فوراً على جميع العملاء.</p>
                  </div>
                </SettingSection>

                {/* Branding Assets */}
                <SettingSection title="الشعار والأيقونات" description="ارفع شعار متجرك وأيقونة المتصفح لتعزيز هويتك البصرية." icon="image" iconColor="text-violet-400">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {[
                      { field: 'logo_url', label: 'الشعار (Logo)' },
                      { field: 'favicon_url', label: 'أيقونة المتصفح (Favicon)' }
                    ].map(item => (
                      <div key={item.field}>
                        <label className={labelCls}>{item.label}</label>
                        <div className="flex gap-2 items-center">
                          <label className="bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 px-4 py-3 rounded-xl cursor-pointer transition-all whitespace-nowrap font-bold text-sm">
                            <span className="material-symbols-outlined align-middle ml-1 text-[18px]">upload</span>
                            رفع
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, item.field)} />
                          </label>
                          <input type="text" value={settings[item.field] || ''} onChange={(e) => setSettings({...settings, [item.field]: e.target.value})} className={`${inputCls} flex-1`} dir="ltr" placeholder="أو ضع رابط مباشر" />
                          {settings[item.field] && <img src={getMediaUrl(settings[item.field])} className="w-12 h-12 object-contain bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10" />}
                        </div>
                      </div>
                    ))}
                  </div>
                </SettingSection>

                {/* Social Links */}
                <SettingSection title="روابط التواصل الاجتماعي" description="أضف روابط حسابات المتجر لتظهر في تذييل الموقع ويسهل على العملاء متابعتك." icon="share" iconColor="text-pink-400">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                    {[
                      { key: 'facebook_url', label: 'فيسبوك', icon: '🔵' },
                      { key: 'instagram_url', label: 'انستجرام', icon: '🟣' },
                      { key: 'tiktok_url', label: 'تيك توك', icon: '⚫' },
                    ].map(s => (
                      <div key={s.key}>
                        <label className={labelCls}>{s.icon} {s.label}</label>
                        <input type="text" value={settings[s.key] || ''} onChange={(e) => setSettings({...settings, [s.key]: e.target.value})} className={inputCls} dir="ltr" placeholder={`https://${s.label.toLowerCase()}.com/...`} />
                      </div>
                    ))}
                  </div>
                </SettingSection>
              </div>
            )}

            {/* ════════════════ TAB: THEME COLORS ════════════════ */}
            {activeTab === 'theme' && (
              <div className="animate-fade-in -my-8">
                <SettingSection title="نظام الألوان" description="خصص ألوان الهوية البصرية لمتجرك لتناسب علامتك التجارية. يمكنك استعادة الألوان الافتراضية في أي وقت." icon="palette" iconColor="text-violet-400">
                  <div className="flex justify-end mb-6">
                    <button type="button" onClick={restoreDefaultColors} className="text-xs text-red-400 hover:text-red-500 font-bold flex items-center gap-1 px-3 py-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-all">
                      <span className="material-symbols-outlined text-[16px]">history</span>
                      استعادة الافتراضي
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    {[
                      { label: 'الأساسي', key: 'primary' },
                      { label: 'الأساسي (Hover)', key: 'primary_hover' },
                      { label: 'نص الأساسي', key: 'primary_foreground' },
                      { label: 'الثانوي', key: 'secondary' },
                      { label: 'نص الثانوي', key: 'secondary_foreground' },
                      { label: 'الخلفية', key: 'background' },
                      { label: 'الأسطح', key: 'surface' },
                      { label: 'الأسطح 2', key: 'surface_2' },
                      { label: 'النص', key: 'text' },
                      { label: 'النص الخافت', key: 'text_muted' },
                      { label: 'الحدود', key: 'border' },
                      { label: 'النجاح', key: 'success' },
                      { label: 'التحذير', key: 'warning' },
                      { label: 'الخطأ', key: 'danger' }
                    ].map(color => (
                      <div key={color.key} className="group">
                        <label className="text-[11px] font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">{color.label}</label>
                        <div className="flex items-center gap-2 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 p-1.5 rounded-xl group-hover:border-primary/30 transition-colors">
                          <input type="color" value={settings.theme_colors?.[color.key] || defaultThemeColors[color.key]} onChange={(e) => handleColorChange(color.key, e.target.value)} className="w-8 h-8 rounded-lg cursor-pointer border-0 p-0 bg-transparent" />
                          <input type="text" value={settings.theme_colors?.[color.key] || defaultThemeColors[color.key]} onChange={(e) => handleColorChange(color.key, e.target.value)} className="w-full bg-transparent text-xs text-gray-700 dark:text-white uppercase focus:outline-none font-mono" dir="ltr" />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Live Preview Inside */}
                  <div className="mt-8 rounded-2xl border border-gray-200 dark:border-white/[0.06] overflow-hidden">
                    <div className="px-6 py-3 bg-gray-50 dark:bg-white/[0.03] border-b border-gray-200 dark:border-white/[0.06]">
                      <h4 className="font-bold text-sm text-gray-900 dark:text-white flex items-center gap-2">
                        <span className="material-symbols-outlined text-[18px] text-green-400">preview</span>
                        معاينة حية
                      </h4>
                    </div>
                    <div className="p-6" style={{
                      backgroundColor: settings.theme_colors?.background || defaultThemeColors.background,
                      color: settings.theme_colors?.text || defaultThemeColors.text
                    }}>
                      <p className="text-sm mb-4 font-bold">هكذا سيبدو متجرك بالألوان الجديدة:</p>
                      <p className="text-xs mb-4" style={{ color: settings.theme_colors?.text_muted || defaultThemeColors.text_muted }}>هذا نص خافت للوصف والتفاصيل الثانوية.</p>
                      <div className="flex gap-3 flex-wrap">
                        <div className="px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg cursor-pointer transition-transform hover:scale-105" style={{
                          backgroundColor: settings.theme_colors?.primary || defaultThemeColors.primary,
                          color: settings.theme_colors?.primary_foreground || defaultThemeColors.primary_foreground
                        }}>
                          زر أساسي
                        </div>
                        <div className="px-5 py-2.5 rounded-xl text-sm font-bold cursor-pointer transition-transform hover:scale-105" style={{
                          backgroundColor: settings.theme_colors?.secondary || defaultThemeColors.secondary,
                          color: settings.theme_colors?.secondary_foreground || defaultThemeColors.secondary_foreground
                        }}>
                          زر ثانوي
                        </div>
                        <div className="px-4 py-2 rounded-lg text-xs font-bold" style={{ backgroundColor: `${settings.theme_colors?.success || defaultThemeColors.success}20`, color: settings.theme_colors?.success || defaultThemeColors.success }}>
                          نجاح
                        </div>
                        <div className="px-4 py-2 rounded-lg text-xs font-bold" style={{ backgroundColor: `${settings.theme_colors?.danger || defaultThemeColors.danger}20`, color: settings.theme_colors?.danger || defaultThemeColors.danger }}>
                          خطأ
                        </div>
                      </div>
                      <div className="mt-4 p-3 rounded-xl" style={{ backgroundColor: settings.theme_colors?.surface || defaultThemeColors.surface, borderColor: settings.theme_colors?.border || defaultThemeColors.border, border: '1px solid' }}>
                        <p className="text-xs">هذه معاينة لسطح (Card) بحدود.</p>
                      </div>
                    </div>
                  </div>
                </SettingSection>
              </div>
            )}

            {/* ════════════════ TAB: FLASH SALE ════════════════ */}
            {activeTab === 'flash' && (
              <div className="animate-fade-in -my-8">
                <SettingSection title="العرض الخاص (Flash Sale)" description="قم بتفعيل وإدارة العروض الخاصة مع عداد تنازلي يظهر في الصفحة الرئيسية لزيادة المبيعات." icon="local_fire_department" iconColor="text-red-400">
                  <div className="flex items-center justify-between mb-6 pb-6 border-b border-gray-200 dark:border-white/10">
                    <div>
                      <h4 className="font-bold text-gray-900 dark:text-white">تفعيل العرض</h4>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">تشغيل أو إيقاف العرض الخاص بالكامل.</p>
                    </div>
                    <Toggle checked={settings.flash_sale_active} onChange={(e) => setSettings({ ...settings, flash_sale_active: e.target.checked })} color="red" />
                  </div>

                  <div className={`space-y-5 transition-opacity ${!settings.flash_sale_active ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <div>
                        <label className={labelCls}>عنوان العرض</label>
                        <input type="text" value={settings.flash_sale_title} onChange={(e) => setSettings({ ...settings, flash_sale_title: e.target.value })} className={inputCls} placeholder="مثال: عرض اليوم! 🔥" />
                      </div>
                      <div>
                        <label className={labelCls}>نص الخصم / التفاصيل</label>
                        <input type="text" value={settings.flash_sale_desc} onChange={(e) => setSettings({ ...settings, flash_sale_desc: e.target.value })} className={inputCls} placeholder="مثال: خصم 15%" />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>تاريخ ووقت انتهاء العرض (للعداد التنازلي)</label>
                      <input type="datetime-local" value={settings.flash_sale_end_time} onChange={(e) => setSettings({ ...settings, flash_sale_end_time: e.target.value })} className={`${inputCls} md:w-1/2`} dir="ltr" />
                    </div>

                    <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 p-4 rounded-xl flex gap-3 text-blue-600 dark:text-blue-400 mt-6">
                      <span className="material-symbols-outlined shrink-0">info</span>
                      <p className="text-sm font-bold">تلميح: هذا الإعداد سيغير العداد التنازلي في الصفحة الرئيسية فوراً لجميع المستخدمين!</p>
                    </div>
                  </div>
                </SettingSection>
              </div>
            )}

            {/* ════════════════ TAB: FEATURES ════════════════ */}
            {activeTab === 'features' && (
              <div className="animate-fade-in -my-8">
                {/* Social Proof & Cross Sell Group */}
                <SettingSection title="الإشعارات والاقتراحات" description="فعل إشعارات الشراء المباشرة والمنتجات المقترحة لزيادة تفاعل العملاء ودفعهم للشراء." icon="notifications_active" iconColor="text-green-400">
                  <div className="space-y-3">
                    <FeatureRow icon="notifications_active" iconColor="text-green-400" title="إشعارات الشراء المباشرة" description='تظهر إشعارات مثل "قام مهندس محمد بشراء كمبروسر" لزيادة الثقة.'>
                      <Toggle checked={settings.social_proof_active !== false} onChange={(e) => setSettings({ ...settings, social_proof_active: e.target.checked })} color="green" />
                    </FeatureRow>
                    <FeatureRow icon="smart_toy" iconColor="text-purple-400" title="الوضع التجريبي للإشعارات" description="توليد إشعارات وهمية بأسماء عشوائية (مفيدة في بداية المتجر)." disabled={settings.social_proof_active === false}>
                      <Toggle checked={settings.social_proof_demo !== false} onChange={(e) => setSettings({ ...settings, social_proof_demo: e.target.checked })} color="purple" />
                    </FeatureRow>
                    <FeatureRow icon="account_tree" iconColor="text-orange-400" title="شريط المنتجات المقترحة (Cross-Selling)" description='عرض شريط "عملاء آخرون اشتروا أيضاً" في صفحة المنتج.'>
                      <Toggle checked={settings.cross_sell_active !== false} onChange={(e) => setSettings({ ...settings, cross_sell_active: e.target.checked })} color="orange" />
                    </FeatureRow>
                    <FeatureRow icon="science" iconColor="text-orange-400" title="الوضع التجريبي للمنتجات المقترحة" description="يعرض منتجات من نفس القسم. عند التعطيل، يعرض عشوائية.">
                      <Toggle checked={settings.cross_sell_demo !== false} onChange={(e) => setSettings({ ...settings, cross_sell_demo: e.target.checked })} color="orange" />
                    </FeatureRow>
                  </div>
                </SettingSection>

                {/* Stock & Urgency Group */}
                <SettingSection title="المخزون والندرة" description="استخدم العدادات وتحذيرات المخزون لخلق حالة من الاستعجال (FOMO) لدى الزوار." icon="inventory_2" iconColor="text-amber-400">
                  <div className="space-y-3">
                    <FeatureRow icon="inventory_2" iconColor="text-amber-400" title="تحذير نفاد المخزون" description='إظهار "قرب يخلص" عندما تقل الكمية عن الحد المحدد.'>
                      <Toggle checked={settings.low_stock_warning_enabled !== false} onChange={(e) => setSettings({ ...settings, low_stock_warning_enabled: e.target.checked })} color="amber" />
                    </FeatureRow>
                    <FeatureRow icon="settings_suggest" iconColor="text-amber-400" title="حد التحذير الكمي" description='أقل كمية تبدأ عندها رسالة "قرب يخلص".' disabled={settings.low_stock_warning_enabled === false}>
                      <input type="number" min={1} max={10000} value={settings.low_stock_threshold ?? 100} onChange={(e) => setSettings({ ...settings, low_stock_threshold: parseInt(e.target.value) || 100 })} className="w-20 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 text-gray-900 dark:text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/40" />
                    </FeatureRow>
                    <FeatureRow icon="visibility" iconColor="text-emerald-400" title="عداد المشاهدة الحية" description='يعرض "يشاهده X فني الآن" في صفحة المنتج.'>
                      <Toggle checked={settings.live_view_enabled !== false} onChange={(e) => setSettings({ ...settings, live_view_enabled: e.target.checked })} color="emerald" />
                    </FeatureRow>
                    <FeatureRow icon="edit_note" iconColor="text-emerald-400" title="عدد المشاهدين الأساسي" description="الرقم اللي يبدأ منه العداد." disabled={settings.live_view_enabled === false}>
                      <input type="number" min={5} max={500} value={settings.live_view_base ?? 15} onChange={(e) => setSettings({ ...settings, live_view_base: parseInt(e.target.value) || 15 })} className="w-20 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 text-gray-900 dark:text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
                    </FeatureRow>
                    <FeatureRow icon="trending_up" iconColor="text-rose-400" title="عداد مبيعات اليوم" description='يعرض "تم بيع X قطعة اليوم" لتحفيز الشراء.'>
                      <Toggle checked={settings.today_sales_enabled !== false} onChange={(e) => setSettings({ ...settings, today_sales_enabled: e.target.checked })} color="rose" />
                    </FeatureRow>
                    <FeatureRow icon="counter_1" iconColor="text-rose-400" title="عدد المبيعات اليومي" description='الرقم اللي يظهر بجانب "تم بيع".' disabled={settings.today_sales_enabled === false}>
                      <input type="number" min={10} max={9999} value={settings.today_sales_count ?? 87} onChange={(e) => setSettings({ ...settings, today_sales_count: parseInt(e.target.value) || 87 })} className="w-24 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 text-gray-900 dark:text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-rose-500/40" />
                    </FeatureRow>
                  </div>
                </SettingSection>

                {/* Shipping & Trust Group */}
                <SettingSection title="الشحن والثقة" description="عزز ثقة عملائك بشارات الضمان وعروض التوصيل المجاني." icon="local_shipping" iconColor="text-sky-400">
                  <div className="space-y-3">
                    <FeatureRow icon="local_shipping" iconColor="text-sky-400" title="شريط التوصيل المجاني" description='يعرض "توصيل مجاني للطلبات فوق X ج" في أعلى الصفحة.'>
                      <Toggle checked={settings.free_shipping_enabled !== false} onChange={(e) => setSettings({ ...settings, free_shipping_enabled: e.target.checked })} color="sky" />
                    </FeatureRow>
                    <FeatureRow icon="monetization_on" iconColor="text-sky-400" title="الحد الأدنى للتوصيل المجاني" description="الطلبات فوق هذا المبلغ تكون رسوم الشحن 0." disabled={settings.free_shipping_enabled === false}>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 dark:text-gray-400 text-xs font-bold">EGP</span>
                        <input type="number" min={0} max={99999} value={settings.free_shipping_threshold ?? 500} onChange={(e) => setSettings({ ...settings, free_shipping_threshold: parseInt(e.target.value) || 500 })} className="w-24 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 text-gray-900 dark:text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-sky-500/40" />
                      </div>
                    </FeatureRow>
                    <FeatureRow icon="verified" iconColor="text-amber-400" title="شارة الضمان" description='عرض شارة "ضمان سنتين" أو "منتج أصلي" في صفحة المنتج.'>
                      <Toggle checked={settings.guarantee_badge_enabled !== false} onChange={(e) => setSettings({ ...settings, guarantee_badge_enabled: e.target.checked })} color="amber" />
                    </FeatureRow>
                    <FeatureRow icon="text_fields" iconColor="text-amber-400" title="نص شارة الضمان" description="النص اللي يظهر في الشارة." disabled={settings.guarantee_badge_enabled === false}>
                      <input type="text" value={settings.guarantee_text || 'ضمان سنتين'} onChange={(e) => setSettings({ ...settings, guarantee_text: e.target.value })} className="w-48 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 text-gray-900 dark:text-white text-center font-bold text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40" />
                    </FeatureRow>
                  </div>

                  {/* Guarantee Product Selector */}
                  <div className={`mt-6 p-5 rounded-xl bg-amber-50 dark:bg-amber-500/5 border border-amber-200 dark:border-amber-500/15 space-y-4 transition-opacity ${settings.guarantee_badge_enabled === false ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div>
                      <h4 className="font-bold text-gray-900 dark:text-white text-sm mb-1">اختيار المنتجات</h4>
                      <p className="text-gray-500 dark:text-gray-400 text-xs">المنتجات المحددة بس هي اللي تظهر عليها شارة الضمان. اترك فارغاً لتطبيقها على الكل.</p>
                    </div>
                    <ProductSearchDropdown
                      query={guaranteeSearchQuery}
                      onChange={handleGuaranteeSearchChange}
                      results={guaranteeSearchResults}
                      showDrop={guaranteeShowResults}
                      loading={guaranteeSearching}
                      onSelect={addGuaranteeProduct}
                      selectedIds={guaranteeProductIds}
                    />
                    {guaranteeSelectedProducts.length > 0 ? (
                      <div>
                        <p className="text-sm font-bold text-gray-500 dark:text-gray-400 mb-2">المنتجات المختارة ({guaranteeSelectedProducts.length})</p>
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {guaranteeSelectedProducts.map((p) => <SelectedProductChip key={p.id} product={p} onRemove={() => removeGuaranteeProduct(p.id)} />)}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-4 text-gray-400 dark:text-gray-500 text-xs">لم يتم اختيار أي منتجات. الشارة هتظهر على كل المنتجات.</div>
                    )}
                  </div>
                </SettingSection>
              </div>
            )}

            {/* ════════════════ TAB: HOT DEALS ════════════════ */}
            {activeTab === 'hotdeals' && (
              <div className="animate-fade-in -my-8">
                <SettingSection title="العروض النارية" description="أبرز منتجات معينة باستخدام لافتة عروض نارية لزيادة مبيعاتها فوراً." icon="whatshot" iconColor="text-amber-400">
                  <div className="flex items-center justify-between mb-6 pb-6 border-b border-gray-200 dark:border-white/10">
                    <div>
                      <h4 className="font-bold text-gray-900 dark:text-white">تفعيل العروض النارية</h4>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">تشغيل أو إيقاف ظهور العروض النارية على المنتجات المختارة.</p>
                    </div>
                    <Toggle checked={hotDeals.active} onChange={(e) => setHotDeals({...hotDeals, active: e.target.checked})} color="amber" />
                  </div>

                  <div className={`space-y-5 transition-opacity ${!hotDeals.active ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <div>
                        <label className={labelCls}>نص اللفتة (Badge)</label>
                        <input type="text" value={hotDeals.badge_text} onChange={(e) => setHotDeals({...hotDeals, badge_text: e.target.value})} className={inputCls} placeholder="مثال: عرض ناري" />
                      </div>
                      <div>
                        <label className={labelCls}>تاريخ انتهاء العرض (اختياري)</label>
                        <input type="datetime-local" value={hotDeals.end_time} onChange={(e) => setHotDeals({...hotDeals, end_time: e.target.value})} className={inputCls} dir="ltr" />
                      </div>
                    </div>

                    <div className="mt-6">
                      <label className={labelCls}>اختيار المنتجات للعرض الناري</label>
                      <ProductSearchDropdown
                        query={searchQuery}
                        onChange={handleSearchChange}
                        results={searchResults}
                        showDrop={showResults}
                        loading={searching}
                        onSelect={(p) => addHotDealProduct(p.id)}
                        selectedIds={hotDeals.product_ids}
                      />
                    </div>

                    {hotDeals.product_ids.length > 0 && (
                      <div className="mt-4">
                        <p className="text-sm font-bold text-gray-500 dark:text-gray-400 mb-2">المنتجات المختارة ({hotDeals.product_ids.length})</p>
                        <div className="space-y-2 max-h-60 overflow-y-auto">
                          {selectedProductsList.map((p) => <SelectedProductChip key={p.id} product={p} onRemove={() => removeHotDealProduct(p.id)} />)}
                        </div>
                      </div>
                    )}

                    <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-4 rounded-xl flex gap-3 text-amber-600 dark:text-amber-400 mt-6">
                      <span className="material-symbols-outlined shrink-0">info</span>
                      <p className="text-sm">المنتجات المختارة ستظهر مع لافتة "<b>{hotDeals.badge_text || 'عرض ناري'}</b>" في الصفحة الرئيسية والكتالوج.</p>
                    </div>
                  </div>
                </SettingSection>
              </div>
            )}

            {/* ════════════════ TAB: DEVELOPER ════════════════ */}
            {activeTab === 'dev' && (
              <div className="animate-fade-in -my-8">
                <SettingSection title="خيارات المطورين" description="أدوات متقدمة لتصحيح الأخطاء ومراقبة حالة قاعدة البيانات." icon="developer_mode" iconColor="text-gray-400">
                  <FeatureRow icon="bug_report" iconColor="text-red-400" title="وضع تصحيح الأخطاء (Debug Mode)" description="عرض شاشة المطورين التفصيلية لمراقبة الأخطاء وحالة قاعدة البيانات">
                    <Toggle checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} color="red" />
                  </FeatureRow>

                  {/* Debug Panel */}
                  {showDebug && (
                    <div className="mt-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30 p-5 rounded-2xl text-left animate-fade-in" dir="ltr">
                      <h3 className="text-red-600 dark:text-red-400 font-bold mb-3 flex items-center gap-2 text-lg"><span className="material-symbols-outlined">bug_report</span> Debug Panel</h3>
                      {debugError && (
                        <div className="mb-4">
                          <span className="text-gray-700 dark:text-white text-sm font-bold block mb-1">Last Error:</span>
                          <pre className="text-red-600 dark:text-red-300 text-xs overflow-auto bg-red-100 dark:bg-black/30 p-3 rounded-xl">{debugError}</pre>
                        </div>
                      )}
                      <div className="mb-4">
                        <span className="text-gray-700 dark:text-white text-sm font-bold block mb-1">Authenticated Email:</span>
                        <pre className="text-blue-600 dark:text-blue-300 text-xs overflow-auto bg-blue-50 dark:bg-black/30 p-3 rounded-xl">{userEmail}</pre>
                      </div>
                      <div>
                        <span className="text-gray-700 dark:text-white text-sm font-bold block mb-1">Database Data:</span>
                        <pre className="text-green-600 dark:text-green-300 text-xs overflow-auto bg-green-50 dark:bg-black/30 p-3 rounded-xl max-h-60">
                          {dbData ? JSON.stringify(dbData, null, 2) : 'No data loaded'}
                        </pre>
                      </div>
                    </div>
                  )}
                </SettingSection>
              </div>
            )}

            {/* ─── Mobile Save Button ─── */}
            <div className="lg:hidden">
              <button
                type="submit"
                disabled={saving}
                className="w-full bg-primary text-white font-bold px-6 py-4 rounded-xl flex items-center justify-center gap-2 hover:brightness-110 transition-all shadow-lg shadow-primary/20 disabled:opacity-50 text-lg"
              >
                {saving ? (
                  <><span className="material-symbols-outlined animate-spin">progress_activity</span> جاري الحفظ...</>
                ) : (
                  <><span className="material-symbols-outlined">save</span> حفظ التغييرات</>
                )}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
