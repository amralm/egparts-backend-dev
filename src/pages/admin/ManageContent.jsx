import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import GeneralTab from './manage-content-tabs/GeneralTab';
import HeroTab from './manage-content-tabs/HeroTab';
import FeaturesTab from './manage-content-tabs/FeaturesTab';
import CategoriesTab from './manage-content-tabs/CategoriesTab';
import { useStore } from '../../context/StoreContext';
import { uploadFileToR2, deleteFileFromR2 } from '../../utils/uploadHelper';

const defaultContent = {
  site_name: 'سوق قطع غيار الأجهزة المنزلية',
  hero: {
    title1: 'سوق قطع غيار ',
    title2: 'الأجهزة المنزلية',
    subtitle: 'نوفر لك جميع قطع الغيار الأصلية بأفضل الأسعار في مصر',
    cta: 'تسوق الآن',
    community: 'انضم لمجتمعنا',
  },
  seo: {
    title: 'الرئيسية',
    description: 'سوق قطع غيار الأجهزة المنزلية الأول في مصر. تصفح أحدث القطع وأفضل العروض.',
  },
  features: [
    { icon: 'verified', title: 'قطع أصلية (OEM)', desc: 'جميع القطع لدينا أصلية ومعتمدة لضمان أطول عمر افتراضي للأجهزة.' },
    { icon: 'support_agent', title: 'دعم فني متواصل', desc: 'فريق كامل لخدمة الفنيين، نساعدك في اختيار القطعة البديلة المناسبة بدقة.' },
    { icon: 'local_shipping', title: 'شحن سريع ومرن', desc: 'توصيل سريع لجميع المحافظات خلال 24-48 ساعة لضمان استمرار عملك.' },
  ],
  categories: {
    heading: 'تسوق حسب القسم',
    subtitle: 'اكتشف مجموعتنا الواسعة من قطع الغيار الأصلية',
    items: [
      { id: '1', name: 'غسالات', desc: 'كارتات، موتور، طلمبات', icon: 'washing_machine', image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuC7fPOxPfV29idTA3jowmYS4uuZv_wYZpsNuyyorBNilh8YbK1SHJsrIo6gIhrifqF0d8N-uPXDEj7LppM9JPlgazUj3CVp6di73DRu3HFkjol5w5r4AxFE2MffrKwlPXxdfYpQQTwDp4NODrq3aFKM4TCBsVvZTC6BB_2VNOYtub-9PvsMA5tRG7y5vM7xCr6Oa6vjBAzmAU7PYaRYPTV77EWOE8lrMOXQ9iUNz3g0gbMMtIyjdIpR0cbzicP0JovjaHJpKbJlhZs', template: 'templateA', is_visible: true, category_link: 'غسالات' },
      { id: '2', name: 'ثلاجات', desc: 'كمبروسر، ثرموستات', icon: 'kitchen', image: '', template: 'templateB', is_visible: true, category_link: 'ثلاجات' },
      { id: '3', name: 'تكييفات', desc: 'كباسات، كباستور', icon: 'ac_unit', image: '', template: 'templateB', is_visible: true, category_link: 'تكييفات' },
      { id: '4', name: 'أفران وميكروويف', desc: 'ماجنترون، لوحات تحكم', icon: 'microwave', image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAQFwzrE7xBVCsSXR3q7nA81Y1bz5oVamzEz36qo9djsb8GDeI8KK_Is2Y85GvCQr3HOC3K7Aal5xCHz0DP6SUjeqnNT2RbqO5cOldB7U2rI5GxSMQo20tGAy33QTpf1LBmTlrFHTe1zobCTYgGBEpbIc9so84w3SCmSPfaeStDSLyXAlA73jp73Fb0jpnTBPC1-ShOZkhEq9KtjbSmh3lRBUcKE04jTjVEO70uk7jMH15IpZyt94Dr1hxIFeObd1X_Kwgb2XKb6dk', template: 'templateC', is_visible: true, category_link: 'أفران وميكروويف' },
    ],
  },
  sections: {
    latest: { heading: 'وصل حديثاً', subtitle: 'أحدث القطع المضافة للكتالوج' },
    trending: { heading: 'الأكثر مبيعاً هذا الأسبوع', subtitle: 'القطع التي يطلبها الفنيون بكثرة' },
  },
  product_card: {
    add_to_cart: 'أضف للسلة',
    in_cart: 'في السلة',
    out_of_stock: 'نفذت الكمية',
    in_stock: 'متوفر في المخزن',
    low_stock: 'قرب يخلص',
    savings: 'توفير',
    view_all: 'عرض الكل',
  },
};

export default function ManageContent() {
  const { store } = useStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || localStorage.getItem('manageContentTab') || 'general';
  
  const [activeTab, setActiveTab] = useState(initialTab);
  const [visitedTabs, setVisitedTabs] = useState(new Set([initialTab]));

  const [initialContent, setInitialContent] = useState(null);
  const [content, setContent] = useState(defaultContent);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [availableCategories, setAvailableCategories] = useState([]);
  const [uploadingCategoryIdx, setUploadingCategoryIdx] = useState(null);
  const [pendingDeletes, setPendingDeletes] = useState([]);

  // Sync tab state with URL and LocalStorage
  useEffect(() => {
    localStorage.setItem('manageContentTab', activeTab);
    setSearchParams({ tab: activeTab }, { replace: true });
    setVisitedTabs(prev => new Set(prev).add(activeTab));
  }, [activeTab, setSearchParams]);

  useEffect(() => {
    if (store?.id) {
      fetchContent();
      fetchCategories();
    }
  }, [store?.id]);

  async function fetchCategories() {
    if (!store?.id) return;
    const { data } = await supabase.from('products').select('category').eq('store_id', store.id).neq('category', null);
    if (data) {
      const uniqueCats = [...new Set(data.map(p => p.category))];
      setAvailableCategories(uniqueCats);
    }
  }

  async function fetchContent() {
    if (!store?.id) return;
    setLoading(true);
    const { data } = await supabase.from('site_settings').select('content').eq('store_id', store.id).single();
    if (data?.content) {
      if (data.content.categories?.items) {
        data.content.categories.items = data.content.categories.items.map((item, idx) => ({
          id: item.id || Math.random().toString(36).substr(2, 9),
          name: item.name || '',
          desc: item.desc || '',
          icon: item.icon || '',
          image: item.image || '',
          template: item.template || (idx === 0 ? 'templateA' : idx === 3 ? 'templateC' : 'templateB'),
          is_visible: item.is_visible !== false,
          category_link: item.category_link || item.name || '',
          ...item
        }));
      }
      const mergedContent = deepMerge(defaultContent, data.content);
      setContent(mergedContent);
      setInitialContent(JSON.parse(JSON.stringify(mergedContent)));
    }
    setLoading(false);
  }

  function deepMerge(base, override) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      if (typeof override[key] === 'object' && !Array.isArray(override[key]) && override[key] !== null) {
        result[key] = deepMerge(base[key] || {}, override[key]);
      } else {
        result[key] = override[key];
      }
    }
    return result;
  }

  const hasChanges = useMemo(() => {
    if (!initialContent) return false;
    return JSON.stringify(content) !== JSON.stringify(initialContent);
  }, [content, initialContent]);

  function update(path, value) {
    setContent(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = copy;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = value;
      return copy;
    });
  }

  function updateFeature(idx, field, value) {
    setContent(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy.features[idx][field] = value;
      return copy;
    });
  }

  function updateCategory(idx, field, value) {
    setContent(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy.categories.items[idx][field] = value;
      return copy;
    });
  }

  function moveCategory(idx, direction) {
    setContent(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      const items = copy.categories.items;
      if (direction === 'up' && idx > 0) {
        [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
      } else if (direction === 'down' && idx < items.length - 1) {
        [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
      }
      return copy;
    });
  }

  function addCategory() {
    setContent(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy.categories.items.push({
        id: Math.random().toString(36).substr(2, 9),
        name: 'قسم جديد', desc: 'وصف القسم', icon: 'category', image: '', template: 'templateB', is_visible: true, category_link: ''
      });
      return copy;
    });
  }

  function removeCategory(idx) {
    if(!confirm('هل أنت متأكد من حذف هذا القسم؟')) return;
    setContent(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy.categories.items.splice(idx, 1);
      return copy;
    });
  }

  const handleCategoryFileUpload = async (e, idx) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadingCategoryIdx(idx);
    try {
      const newKey = await uploadFileToR2({ file, category: 'categories' });
      const oldKey = content.categories.items[idx].image;
      if (oldKey && !oldKey.startsWith('http://') && !oldKey.startsWith('https://')) {
        setPendingDeletes(prev => [...prev, oldKey]);
      }
      updateCategory(idx, 'image', newKey);
      showToast('تم رفع الصورة بنجاح');
    } catch (error) {
      console.error('Error uploading category image:', error);
      showToast(error.message || 'فشل رفع الصورة.');
    } finally {
      setUploadingCategoryIdx(null);
    }
  };

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  async function handleSave() {
    if (!store?.id) return;
    setSaving(true);
    const { error } = await supabase.from('site_settings').update({ content }).eq('store_id', store.id);
    if (error) { showToast('خطأ: ' + error.message); setSaving(false); return; }
    
    // Clean up old files from R2 only if DB save succeeded
    if (pendingDeletes.length > 0) {
      Promise.all(pendingDeletes.map(key => deleteFileFromR2(key)))
        .catch(console.error);
      setPendingDeletes([]);
    }

    setInitialContent(JSON.parse(JSON.stringify(content)));
    showToast('تم حفظ التغييرات بنجاح');
    setSaving(false);
  }

  async function handleReset() {
    if (!confirm('هل أنت متأكد من التراجع عن جميع التعديلات والعودة للنسخة المحفوظة؟')) return;
    setContent(JSON.parse(JSON.stringify(initialContent)));
    setPendingDeletes([]);
    showToast('تم التراجع عن التعديلات');
  }

  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const mainEl = document.getElementById('admin-main-scroll');
    if (!mainEl) return;
    const handleScroll = () => setIsScrolled(mainEl.scrollTop > 10);
    mainEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => mainEl.removeEventListener('scroll', handleScroll);
  }, []);

  if (loading) return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-primary"></div>
      <p className="text-on-surface-variant text-sm font-bold animate-pulse">جاري تحميل المحتوى...</p>
    </div>
  );

  const inputClass = "w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-primary transition-all";
  const labelClass = "block text-xs font-black text-on-surface-variant mb-2";
  const sectionClass = "bg-surface-container-low border border-white/10 rounded-[2.5rem] p-8";

  const tabs = [
    { id: 'general', name: 'عام', icon: 'settings' },
    { id: 'hero', name: 'القسم العلوي', icon: 'palette' },
    { id: 'features', name: 'المميزات', icon: 'star' },
    { id: 'categories', name: 'الأقسام', icon: 'category' },
  ];

  return (
    <div className="space-y-6 relative" dir="rtl">
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-green-500 text-white px-6 py-3 rounded-xl font-bold shadow-xl animate-in fade-in slide-in-from-top-4">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-center bg-white/[0.02] p-8 rounded-[2.5rem] border border-white/5 backdrop-blur-md gap-6">
        <div>
          <h1 className="text-4xl font-black text-white flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[40px]">edit_note</span>
            إدارة المحتوى
          </h1>
          <p className="text-on-surface-variant mt-2 text-lg">تحكم في كل النصوص الثابتة والأقسام في الموقع.</p>
        </div>
        <div className="flex gap-3">
          {hasChanges && (
            <button onClick={handleReset} className="px-6 py-3 rounded-xl bg-error/10 text-error hover:bg-error hover:text-white font-bold text-sm transition-all flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">undo</span>
              تراجع
            </button>
          )}
          <button onClick={handleSave} disabled={saving || !hasChanges}
            className="px-8 py-3 rounded-xl bg-primary text-on-primary hover:bg-primary-fixed font-black transition-all disabled:opacity-50 disabled:grayscale flex items-center gap-2 relative"
          >
            {hasChanges && !saving && (
              <span className="absolute -top-2 -right-2 flex h-4 w-4">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75"></span>
                <span className="relative inline-flex rounded-full h-4 w-4 bg-error text-[8px] items-center justify-center text-white font-bold">!</span>
              </span>
            )}
            <span className="material-symbols-outlined">{saving ? 'hourglass_empty' : 'save'}</span>
            {saving ? 'جاري الحفظ...' : 'حفظ التغييرات'}
          </button>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div 
        className={`sticky z-40 transition-shadow duration-300 bg-background/95 ${isScrolled ? 'shadow-sm shadow-black/5 border-b border-outline/20' : ''}`}
        style={{ 
          top: 'calc(var(--admin-pad-y) * -1)', 
          marginInline: 'calc(var(--admin-pad-x) * -1)', 
          paddingInline: 'var(--admin-pad-x)', 
          paddingTop: 'var(--admin-pad-y)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)'
        }}
      >
        <div className="flex overflow-x-auto hide-scrollbar gap-2 pb-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-6 py-3 rounded-full font-bold transition-all whitespace-nowrap ${
                activeTab === tab.id 
                  ? 'bg-primary text-on-primary shadow-lg shadow-primary/20' 
                  : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">{tab.icon}</span>
              {tab.name}
              {hasChanges && activeTab !== tab.id && (
                <span className="w-2 h-2 rounded-full bg-error ml-2"></span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs Content */}
      <div className="pt-2">
        {visitedTabs.has('general') && (
          <div className={activeTab === 'general' ? 'block' : 'hidden'}>
            <GeneralTab content={content} update={update} inputClass={inputClass} labelClass={labelClass} sectionClass={sectionClass} />
          </div>
        )}
        
        {visitedTabs.has('hero') && (
          <div className={activeTab === 'hero' ? 'block' : 'hidden'}>
            <HeroTab content={content} update={update} inputClass={inputClass} labelClass={labelClass} sectionClass={sectionClass} />
          </div>
        )}
        
        {visitedTabs.has('features') && (
          <div className={activeTab === 'features' ? 'block' : 'hidden'}>
            <FeaturesTab content={content} updateFeature={updateFeature} inputClass={inputClass} labelClass={labelClass} sectionClass={sectionClass} />
          </div>
        )}
        
        {visitedTabs.has('categories') && (
          <div className={activeTab === 'categories' ? 'block' : 'hidden'}>
            <CategoriesTab 
              content={content} 
              update={update} 
              updateCategory={updateCategory} 
              moveCategory={moveCategory} 
              addCategory={addCategory} 
              removeCategory={removeCategory} 
              handleCategoryFileUpload={handleCategoryFileUpload} 
              uploadingCategoryIdx={uploadingCategoryIdx} 
              availableCategories={availableCategories} 
              inputClass={inputClass} 
              labelClass={labelClass} 
              sectionClass={sectionClass} 
            />
          </div>
        )}
      </div>
    </div>
  );
}
