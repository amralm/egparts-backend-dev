import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import ConfirmModal from '../../components/ConfirmModal';
import { useStore } from '../../context/StoreContext';
import { uploadFileToR2, deleteFileFromR2, getMediaUrl } from '../../utils/uploadHelper';

export default function ManageBanners() {
  const { store } = useStore();
  const [banners, setBanners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBanner, setEditingBanner] = useState(null);

  const [deleteConfirm, setDeleteConfirm] = useState({ show: false, id: null });
  const [uploading, setUploading] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [formData, setFormData] = useState({
    title: '',
    subtitle: '',
    image_url: '',
    link_url: '/catalog',
    is_active: true,
    order_index: 0,
    overlay_opacity: 40,
    blur_px: 6
  });

  useEffect(() => {
    if (store?.id) {
      fetchBanners();
    }
  }, [store?.id]);

  async function fetchBanners() {
    if (!store?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('banners')
      .select('*')
      .eq('store_id', store.id)
      .order('order_index', { ascending: true });
    if (error) console.error("Fetch banners error:", error);
    if (data) setBanners(data);
    setLoading(false);
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('نوع الملف غير مدعوم. الرجاء رفع صور فقط.');
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      alert('حجم الصورة يجب ألا يتجاوز 3 ميجابايت.');
      return;
    }

    setImageFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!store?.id) return;
    setLoading(true);

    try {
      let finalImageUrl = formData.image_url;
      const replacedImageKey = (imageFile && editingBanner?.image_url) ? editingBanner.image_url : null;

      if (imageFile) {
        setUploading(true);
        finalImageUrl = await uploadFileToR2({
          file: imageFile,
          category: 'banners'
        });
        setUploading(false);
      }

      let error;
      const payload = { ...formData, image_url: finalImageUrl };

      if (editingBanner) {
        const { id, store_id, created_at, ...updatePayload } = payload;
        const res = await supabase
          .from('banners')
          .update(updatePayload)
          .eq('id', editingBanner.id)
          .eq('store_id', store.id);
        error = res.error;
      } else {
        const res = await supabase.from('banners').insert([{ ...payload, store_id: store.id }]);
        error = res.error;
      }

      if (error) throw error;

      if (replacedImageKey) {
        deleteFileFromR2(replacedImageKey).catch(console.error);
      }

      setFormData({ title: '', subtitle: '', image_url: '', link_url: '/catalog', is_active: true, order_index: 0, overlay_opacity: 40, blur_px: 6 });
      setEditingBanner(null);
      setImageFile(null);
      setPreviewUrl('');
      setIsModalOpen(false);
      fetchBanners();
    } catch (error) {
      console.error(error);
      alert('فشلت العملية: ' + error.message);
    } finally {
      setUploading(false);
      setLoading(false);
    }
  };

  const deleteBanner = async (id) => {
    setDeleteConfirm({ show: true, id });
  };

  const toggleBannerStatus = async (banner) => {
    if (!store?.id) return;
    const { error } = await supabase
      .from('banners')
      .update({ is_active: !banner.is_active })
      .eq('id', banner.id)
      .eq('store_id', store.id);
    if (error) { alert('فشل التحديث: ' + error.message); return; }
    fetchBanners();
  };

  return (
    <div className="space-y-8" dir="rtl">
      <div className="flex justify-between items-center bg-white/[0.02] p-8 rounded-[2.5rem] border border-white/5 backdrop-blur-md">
        <div>
          <h1 className="text-4xl font-black text-white flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[40px]">gallery_thumbnail</span>
            إدارة الواجهة 🖼️
          </h1>
          <p className="text-on-surface-variant mt-2 text-lg">تحكم في العروض الترويجية والبنرات التي تظهر للعملاء.</p>
        </div>
        <button 
          onClick={() => { setEditingBanner(null); setFormData({ title: '', subtitle: '', image_url: '', link_url: '/catalog', is_active: true, order_index: 0, overlay_opacity: 40, blur_px: 6 }); setImageFile(null); setPreviewUrl(''); setIsModalOpen(true); }}
          className="bg-primary text-on-primary px-8 py-4 rounded-2xl font-black flex items-center gap-2 hover:scale-105 active:scale-95 transition-all shadow-xl shadow-primary/20"
        >
          <span className="material-symbols-outlined font-bold">add</span> إضافة عرض جديد
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {banners.map(banner => (
          <motion.div 
            layout
            key={banner.id} 
            className={`bg-surface-container-low border ${banner.is_active ? 'border-white/10' : 'border-error/20 grayscale opacity-70'} rounded-[2.5rem] overflow-hidden group hover:border-primary/30 transition-all duration-500 shadow-2xl shadow-black/40`}
          >
            <div className="h-56 bg-cover bg-center relative group-hover:scale-105 transition-transform duration-700" style={{ backgroundImage: `url(${getMediaUrl(banner.image_url)})` }}>
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
              
              <div className="absolute top-4 left-4 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-all translate-x-4 group-hover:translate-x-0">
                <button onClick={() => { setEditingBanner(banner); setFormData(banner); setImageFile(null); setPreviewUrl(''); setIsModalOpen(true); }} className="w-12 h-12 bg-white/10 backdrop-blur-xl rounded-2xl flex items-center justify-center text-white hover:bg-primary transition-all border border-white/10">
                  <span className="material-symbols-outlined text-[22px]">edit</span>
                </button>
                <button onClick={() => deleteBanner(banner.id)} className="w-12 h-12 bg-white/10 backdrop-blur-xl rounded-2xl flex items-center justify-center text-white hover:bg-error transition-all border border-white/10">
                  <span className="material-symbols-outlined text-[22px]">delete</span>
                </button>
              </div>

              <div className="absolute bottom-4 right-4 left-4">
                <span className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest ${banner.is_active ? 'bg-green-500 text-white shadow-lg shadow-green-500/30' : 'bg-error text-white'}`}>
                  {banner.is_active ? 'نشط الآن' : 'متوقف'}
                </span>
              </div>
            </div>
            
            <div className="p-8 space-y-4">
              <div>
                <h3 className="text-xl font-black text-white line-clamp-1">{banner.title || 'بدون عنوان'}</h3>
                <p className="text-sm text-on-surface-variant font-medium mt-1 line-clamp-2">{banner.subtitle || 'لا يوجد وصف للعرض'}</p>
              </div>
              
              <div className="flex items-center justify-between pt-4 border-t border-white/5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-white/40 font-black uppercase">الترتيب</span>
                  <span className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-primary font-black text-sm">{banner.order_index}</span>
                </div>
                <button 
                  onClick={() => toggleBannerStatus(banner)}
                  className={`text-xs font-black px-4 py-2 rounded-xl transition-all ${banner.is_active ? 'bg-error/10 text-error hover:bg-error/20' : 'bg-green-500/10 text-green-500 hover:bg-green-500/20'}`}
                >
                  {banner.is_active ? 'تعطيل' : 'تفعيل'}
                </button>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-surface-container-lowest border border-white/10 rounded-[3rem] w-full max-w-2xl p-10 shadow-3xl overflow-y-auto max-h-[90vh]"
            >
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-3xl font-black text-white">{editingBanner ? 'تعديل العرض' : 'إضافة عرض جديد'}</h2>
                <button onClick={() => setIsModalOpen(false)} className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center text-white hover:bg-white/10 transition-all">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">العنوان الرئيسي</label>
                    <input 
                      className="w-full bg-surface border border-outline rounded-2xl p-4 text-on-surface outline-none focus:border-primary transition-all font-bold" 
                      placeholder="أدخل عنوان العرض..." 
                      value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">العنوان الفرعي</label>
                    <input 
                      className="w-full bg-surface border border-outline rounded-2xl p-4 text-on-surface outline-none focus:border-primary transition-all" 
                      placeholder="وصف مختصر..." 
                      value={formData.subtitle} onChange={e => setFormData({...formData, subtitle: e.target.value})}
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">صورة العرض</label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="relative group border-2 border-dashed border-white/10 rounded-3xl p-4 hover:border-primary/50 transition-all flex flex-col items-center justify-center gap-3 min-h-[160px]">
                      <input 
                        type="file" accept="image/*" onChange={handleFileUpload}
                        className="absolute inset-0 opacity-0 cursor-pointer z-10"
                      />
                      {uploading ? (
                        <span className="material-symbols-outlined animate-spin text-primary text-[40px]">progress_activity</span>
                      ) : (
                        <>
                          <span className="material-symbols-outlined text-[40px] text-on-surface-variant group-hover:text-primary transition-all">cloud_upload</span>
                          <p className="text-sm font-bold text-on-surface-variant">ارفع صورة من ملفاتك</p>
                        </>
                      )}
                    </div>
                    <div className="space-y-4">
                      <input 
                        className="w-full bg-surface border border-outline rounded-2xl p-4 text-on-surface outline-none focus:border-primary transition-all text-sm" 
                        placeholder="أو ضع رابط صورة مباشر..." 
                        value={formData.image_url} onChange={e => setFormData({...formData, image_url: e.target.value})}
                      />
                      {(previewUrl || formData.image_url) && (
                        <div className="h-20 w-full rounded-xl overflow-hidden border border-white/10">
                          <img src={previewUrl || getMediaUrl(formData.image_url)} alt="Preview" className="w-full h-full object-cover" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Overlay Controls */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <label className="flex items-center justify-between text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">
                      <span>عتامة التدرج الخلفي</span>
                      <span className="text-white text-sm font-black ltr">{formData.overlay_opacity}%</span>
                    </label>
                    <div className="relative">
                      <div className="absolute -bottom-1 left-0 right-0 h-1 rounded-full bg-white/5" style={{ background: `linear-gradient(to right, transparent, rgba(0,0,0,${formData.overlay_opacity / 100}) 80%)` }}></div>
                      <input type="range" min="0" max="100" value={formData.overlay_opacity}
                        onChange={e => setFormData({...formData, overlay_opacity: parseInt(e.target.value)})}
                        className="w-full h-2 rounded-full appearance-none cursor-pointer bg-white/10 accent-primary [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-primary/40 [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-125"
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-white/30 px-1">
                      <span>شفاف</span>
                      <span>داكن</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <label className="flex items-center justify-between text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">
                      <span>ضباب الخلفية</span>
                      <span className="text-white text-sm font-black ltr">{formData.blur_px}px</span>
                    </label>
                    <input type="range" min="0" max="24" value={formData.blur_px}
                      onChange={e => setFormData({...formData, blur_px: parseInt(e.target.value)})}
                      className="w-full h-2 rounded-full appearance-none cursor-pointer bg-white/10 accent-primary [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-primary/40 [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-125"
                    />
                    <div className="flex justify-between text-[10px] text-white/30 px-1">
                      <span>واضح</span>
                      <span>ضبابي</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">رابط التوجيه (اختياري)</label>
                    <input 
                      className="w-full bg-surface border border-outline rounded-2xl p-4 text-on-surface outline-none focus:border-primary transition-all font-mono text-sm" 
                      placeholder="/catalog" 
                      value={formData.link_url} onChange={e => setFormData({...formData, link_url: e.target.value})}
                    />
                  </div>
                  <div className="flex gap-4 items-end">
                    <div className="flex-1 space-y-2">
                      <label className="text-xs font-black text-on-surface-variant uppercase tracking-widest mr-2">الترتيب</label>
                      <input 
                        type="number"
                        className="w-full bg-surface border border-outline rounded-2xl p-4 text-on-surface outline-none focus:border-primary transition-all font-black" 
                        value={formData.order_index} onChange={e => setFormData({...formData, order_index: parseInt(e.target.value)})}
                      />
                    </div>
                    <label className="flex-1 flex items-center justify-center gap-3 bg-surface border border-outline rounded-2xl p-4 cursor-pointer hover:bg-surface-container transition-all h-[56px]">
                      <input 
                        type="checkbox" checked={formData.is_active} 
                        onChange={e => setFormData({...formData, is_active: e.target.checked})}
                        className="w-5 h-5 rounded accent-primary"
                      />
                      <span className="text-on-surface text-sm font-bold">تفعيل العرض</span>
                    </label>
                  </div>
                </div>

                <div className="flex gap-4 pt-8">
                  <button type="submit" disabled={uploading} className="flex-1 bg-primary text-on-primary py-5 rounded-[1.5rem] font-black text-lg hover:bg-primary-fixed transition-all shadow-xl shadow-primary/20 disabled:opacity-50">
                    {editingBanner ? 'تحديث العرض' : 'إضافة الآن'}
                  </button>
                  <button type="button" onClick={() => setIsModalOpen(false)} className="px-10 py-5 bg-white/5 text-white rounded-[1.5rem] hover:bg-white/10 transition-all font-bold border border-white/10">إلغاء</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ConfirmModal
        isOpen={deleteConfirm.show}
        onClose={() => setDeleteConfirm({ show: false, id: null })}
        onConfirm={async () => {
          if (!store?.id) return;
          const bannerToDelete = banners.find(b => b.id === deleteConfirm.id);
          const oldImageKey = bannerToDelete?.image_url;
          const { error } = await supabase.from('banners').delete().eq('id', deleteConfirm.id).eq('store_id', store.id);
          if (error) {
            alert('فشل الحذف: ' + error.message);
          } else {
            if (oldImageKey) {
              deleteFileFromR2(oldImageKey).catch(console.error);
            }
          }
          setDeleteConfirm({ show: false, id: null });
          fetchBanners();
        }}
        title="حذف البنر"
        message="هل أنت متأكد من حذف هذا البنر؟ لا يمكن التراجع عن هذا الإجراء."
        confirmText="حذف"
        cancelText="إلغاء"
        type="danger"
      />
    </div>
  );
}
