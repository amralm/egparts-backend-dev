import { useState, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../context/StoreContext';
import { supabase } from '../../lib/supabase';
import ImageCropper from '../../components/ImageCropper';
import { uploadFileToR2, deleteFileFromR2, getMediaUrl } from '../../utils/uploadHelper';

const ConfirmModal = ({ isOpen, title, onConfirm, onCancel }) => isOpen ? (
  <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4" dir="rtl">
    <div className="glass-panel p-6 rounded-xl border border-white/10 max-w-sm w-full shadow-[0_0_40px_rgba(0,0,0,0.8)]">
      <h3 className="text-xl font-bold text-white mb-6 text-right">{title}</h3>
      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="px-4 py-2 text-on-surface-variant hover:text-white transition-colors">إلغاء</button>
        <button onClick={onConfirm} className="px-4 py-2 bg-error text-white rounded-lg hover:bg-error/80 transition-colors">تأكيد الحذف</button>
      </div>
    </div>
  </div>
) : null;

const ProductModal = ({ isOpen, product, existingCategories = [], onSave, onCancel }) => {
  const [formData, setFormData] = useState({ 
    name: '', price: '', stock: 0, category: '', image: '',
    part_number: '', old_price: '', cost_price: '', is_original: true,
    is_active: true, specsString: '', compatibilityString: ''
  });
  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  
  const [galleryFiles, setGalleryFiles] = useState([]);
  const [galleryPreviewUrls, setGalleryPreviewUrls] = useState([]);
  const [existingGallery, setExistingGallery] = useState([]);

  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef(null);
  const galleryInputRef = useRef(null);

  const [showCropper, setShowCropper] = useState(false);
  const [cropImageUrl, setCropImageUrl] = useState('');
  const [pendingFileName, setPendingFileName] = useState('');

  useEffect(() => {
    if (product) {
      // Parse specs to string
      const specsStr = product.specs ? Object.entries(product.specs).map(([k,v]) => `${k}: ${v}`).join('\n') : '';
      const compStr = product.compatibility ? product.compatibility.join('\n') : '';

      setFormData({
        name: product.name || '',
        price: product.price || '',
        stock: product.stock_quantity !== undefined ? product.stock_quantity : (product.stock || 0),
        category: product.category || '',
        image: product.image || '',
        part_number: product.part_number || '',
        old_price: product.old_price || '',
        cost_price: product.cost_price || '',
        is_original: product.is_original !== false,
        is_active: product.is_active !== false,
        specsString: specsStr,
        compatibilityString: compStr
      });
      setPreviewUrl(product.image ? getMediaUrl(product.image) : '');
      setExistingGallery(product.gallery || []);
    } else {
      setFormData({ 
        name: '', price: '', stock: 0, category: '', image: '',
        part_number: '', old_price: '', cost_price: '', is_original: true,
        is_active: true, specsString: '', compatibilityString: ''
      });
      setPreviewUrl('');
      setExistingGallery([]);
    }
    setImageFile(null);
    setGalleryFiles([]);
    setGalleryPreviewUrls([]);
    setShowCropper(false);
    setCropImageUrl('');
    setPendingFileName('');
  }, [product, isOpen]);

  if (!isOpen) return null;

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setPendingFileName(file.name);
      setCropImageUrl(URL.createObjectURL(file));
      setShowCropper(true);
    }
    e.target.value = '';
  };

  const handleCropComplete = (blob) => {
    const file = new File([blob], pendingFileName, { type: 'image/jpeg' });
    setImageFile(file);
    setPreviewUrl(URL.createObjectURL(blob));
    setShowCropper(false);
    setCropImageUrl('');
  };

  const handleCropCancel = () => {
    setShowCropper(false);
    setCropImageUrl('');
  };

  const handleGalleryChange = (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      setGalleryFiles(prev => [...prev, ...files]);
      const urls = files.map(file => URL.createObjectURL(file));
      setGalleryPreviewUrls(prev => [...prev, ...urls]);
    }
  };

  const removeGalleryImage = (idx, isNew) => {
    if (isNew) {
      const newFiles = [...galleryFiles];
      newFiles.splice(idx, 1);
      setGalleryFiles(newFiles);
      
      const newUrls = [...galleryPreviewUrls];
      newUrls.splice(idx, 1);
      setGalleryPreviewUrls(newUrls);
    } else {
      const newExisting = [...existingGallery];
      newExisting.splice(idx, 1);
      setExistingGallery(newExisting);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    
    // Parse specs and compatibility
    const specsObj = {};
    if (formData.specsString) {
      formData.specsString.split('\n').forEach(line => {
        const [k, ...vParts] = line.split(':');
        const v = vParts.join(':');
        if(k && v) specsObj[k.trim()] = v.trim();
      });
    }

    const compArr = formData.compatibilityString 
      ? formData.compatibilityString.split('\n').map(s => s.trim()).filter(Boolean)
      : [];

    await onSave({
      ...formData,
      specs: specsObj,
      compatibility: compArr,
      existingGallery
    }, imageFile, galleryFiles);
    
    setIsSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4 overflow-y-auto">
      <div className="glass-panel p-6 rounded-xl border border-white/10 max-w-3xl w-full shadow-[0_0_40px_rgba(0,0,0,0.8)] my-8" dir="rtl">
        <h3 className="text-2xl font-bold text-white mb-6">{product ? 'تعديل المنتج' : 'إضافة منتج جديد'}</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column: Basic Info */}
          <div className="space-y-4">
            <div>
              <label className="block text-on-surface-variant text-sm mb-1 font-bold">اسم المنتج *</label>
              <input 
                type="text" 
                value={formData.name} 
                onChange={e => setFormData({...formData, name: e.target.value})} 
                className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                disabled={isSaving}
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-on-surface-variant text-sm mb-1 font-bold">رقم القطعة (Part Number)</label>
                <input 
                  type="text" 
                  value={formData.part_number} 
                  onChange={e => setFormData({...formData, part_number: e.target.value})} 
                  className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                  disabled={isSaving}
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-on-surface-variant text-sm mb-1 font-bold">القسم / الفئة *</label>
                <input 
                  type="text" 
                  list="category-suggestions"
                  value={formData.category} 
                  onChange={e => setFormData({...formData, category: e.target.value})} 
                  className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                  disabled={isSaving}
                />
                <datalist id="category-suggestions">
                  {existingCategories.map((cat, idx) => (
                    <option key={idx} value={cat} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className="block text-on-surface-variant text-sm mb-1 font-bold">السعر للعميل *</label>
                <input 
                  type="text" 
                  value={formData.price} 
                  onChange={e => setFormData({...formData, price: e.target.value})} 
                  className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                  disabled={isSaving}
                />
              </div>
              <div>
                <label className="block text-on-surface-variant text-sm mb-1 font-bold text-yellow-500">سعر التكلفة (مخفي)</label>
                <input 
                  type="text" 
                  value={formData.cost_price} 
                  onChange={e => setFormData({...formData, cost_price: e.target.value})} 
                  className="w-full bg-surface-container border border-yellow-500/30 focus:border-yellow-500 rounded-lg px-4 py-2 text-white focus:outline-none" 
                  disabled={isSaving}
                  placeholder="مثال: 100"
                />
              </div>
              <div>
                <label className="block text-on-surface-variant text-sm mb-1 font-bold">السعر القديم</label>
                <input 
                  type="text" 
                  value={formData.old_price} 
                  onChange={e => setFormData({...formData, old_price: e.target.value})} 
                  className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                  disabled={isSaving}
                />
              </div>
              <div>
                <label className="block text-on-surface-variant text-sm mb-1 font-bold">المخزون *</label>
                <input 
                  type="number" 
                  value={formData.stock} 
                  onChange={e => setFormData({...formData, stock: parseInt(e.target.value) || 0})} 
                  className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                  disabled={isSaving}
                />
              </div>
            </div>

            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer bg-surface-container border border-white/5 px-4 py-2 rounded-lg flex-1">
                <input 
                  type="checkbox" 
                  checked={formData.is_original} 
                  onChange={e => setFormData({...formData, is_original: e.target.checked})}
                  className="w-4 h-4 accent-primary"
                  disabled={isSaving}
                />
                <span className="text-on-surface font-bold text-sm">قطعة أصلية (OEM)</span>
              </label>

              <label className={`flex items-center gap-2 cursor-pointer border px-4 py-2 rounded-lg flex-1 transition-colors ${formData.is_active ? 'bg-green-500/10 border-green-500/30' : 'bg-surface-container border-white/5'}`}>
                <input 
                  type="checkbox" 
                  checked={formData.is_active} 
                  onChange={e => setFormData({...formData, is_active: e.target.checked})}
                  className="w-4 h-4 accent-green-500"
                  disabled={isSaving}
                />
                <span className="text-on-surface font-bold text-sm">مفعل (يظهر للعملاء)</span>
              </label>
            </div>

            <div>
              <label className="block text-on-surface-variant text-sm mb-1 font-bold">الموديلات المتوافقة (كل موديل في سطر جديد)</label>
              <textarea 
                value={formData.compatibilityString} 
                onChange={e => setFormData({...formData, compatibilityString: e.target.value})} 
                className="w-full h-24 bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                placeholder="LG GR-B502HLHU&#10;LG GR-F502HLHU"
                disabled={isSaving}
                dir="ltr"
              />
            </div>
            
            <div>
              <label className="block text-on-surface-variant text-sm mb-1 font-bold">المواصفات الفنية (الاسم: القيمة في كل سطر)</label>
              <textarea 
                value={formData.specsString} 
                onChange={e => setFormData({...formData, specsString: e.target.value})} 
                className="w-full h-24 bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary" 
                placeholder="Voltage: 220-240V&#10;Warranty: 1 Year Limited"
                disabled={isSaving}
                dir="ltr"
              />
            </div>
          </div>

          {/* Right Column: Images */}
          <div className="space-y-6">
            <div className="bg-surface-container-high/30 p-4 rounded-xl border border-white/5">
              <label className="block text-white text-md mb-3 font-bold border-b border-white/10 pb-2">الصورة الرئيسية (الغلاف)</label>
              <div className="flex flex-col items-center gap-4">
                <div className="w-full h-48 bg-surface-container rounded-lg border-2 border-dashed border-white/20 flex items-center justify-center overflow-hidden">
                  {previewUrl ? (
                    <img src={previewUrl} alt="Preview" className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-center text-on-surface-variant">
                      <span className="material-symbols-outlined text-4xl mb-2">image</span>
                      <p className="text-sm">لم يتم تحديد صورة</p>
                    </div>
                  )}
                </div>
                <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleImageChange} />
                <button 
                  onClick={() => fileInputRef.current?.click()} 
                  className="w-full bg-primary/20 hover:bg-primary/40 border border-primary/50 text-primary px-4 py-2 rounded-lg text-sm transition-colors font-bold"
                  disabled={isSaving}
                >
                  اختيار الغلاف
                </button>
              </div>
            </div>

            <div className="bg-surface-container-high/30 p-4 rounded-xl border border-white/5">
              <label className="block text-white text-md mb-3 font-bold border-b border-white/10 pb-2">معرض الصور الإضافية (Gallery)</label>
              <div className="grid grid-cols-4 gap-2 mb-4">
                {/* Existing Images */}
                {existingGallery.map((url, idx) => (
                  <div key={`ext-${idx}`} className="relative aspect-square bg-surface-container rounded-lg border border-white/10 overflow-hidden group">
                    <img src={getMediaUrl(url)} alt={`Gallery ${idx}`} className="w-full h-full object-cover" />
                    <button onClick={() => removeGalleryImage(idx, false)} className="absolute top-1 right-1 bg-error/80 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity" title="حذف">
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  </div>
                ))}
                
                {/* New Images */}
                {galleryPreviewUrls.map((url, idx) => (
                  <div key={`new-${idx}`} className="relative aspect-square bg-surface-container rounded-lg border border-primary/50 overflow-hidden group">
                    <img src={url} alt={`New Gallery ${idx}`} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-primary/20 pointer-events-none"></div>
                    <button onClick={() => removeGalleryImage(idx, true)} className="absolute top-1 right-1 bg-error/80 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity" title="حذف">
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  </div>
                ))}
              </div>
              
              <input type="file" accept="image/*" multiple ref={galleryInputRef} className="hidden" onChange={handleGalleryChange} />
              <button 
                onClick={() => galleryInputRef.current?.click()} 
                className="w-full bg-surface-container hover:bg-white/10 border border-white/20 text-white px-4 py-2 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
                disabled={isSaving}
              >
                <span className="material-symbols-outlined text-[18px]">add_photo_alternate</span>
                إضافة صور أخرى
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-8 pt-4 border-t border-white/10">
          <button onClick={onCancel} disabled={isSaving} className="px-6 py-2 text-on-surface-variant hover:text-white transition-colors disabled:opacity-50">إلغاء</button>
          <button onClick={handleSave} disabled={isSaving} className="px-8 py-2 bg-primary text-on-primary rounded-lg font-bold hover:bg-primary-fixed transition-colors shadow-[0_0_20px_rgba(255,153,0,0.4)] disabled:opacity-50 flex items-center gap-2 text-lg">
            {isSaving && <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>}
            {isSaving ? 'جاري الحفظ والرفع...' : 'حفظ المنتج بالكامل'}
          </button>
        </div>
      </div>

      {showCropper && (
        <ImageCropper
          imageUrl={cropImageUrl}
          onCrop={handleCropComplete}
          onCancel={handleCropCancel}
        />
      )}
    </div>
  );
};

export default function Products() {
  const { store } = useStore();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState(null);
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState('success');
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState(null);
  const [viewMode, setViewMode] = useState('active'); // 'active' or 'deleted'
  const [activeOrdersWarningModalOpen, setActiveOrdersWarningModalOpen] = useState(false);

  useEffect(() => {
    if (store?.id) {
      fetchProducts();
    }
  }, [viewMode, store?.id]);

  async function fetchProducts() {
    if (!store?.id) return;
    setLoading(true);
    let query = supabase
      .from('products')
      .select('*')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });
      
    if (viewMode === 'deleted') {
      query = query.eq('is_deleted', true);
    } else {
      query = query.neq('is_deleted', true);
    }

    const { data, error } = await query;

    if (!error && data) {
      // Fetch active orders to count them per product, scoped to store_id
      const { data: orderItems } = await supabase
        .from('order_items')
        .select('product_id, orders!inner(status, store_id)')
        .eq('orders.store_id', store.id)
        .in('orders.status', ['pending', 'confirmed', 'processing']);
      
      let activeCounts = {};
      if (orderItems) {
        orderItems.forEach(item => {
          activeCounts[item.product_id] = (activeCounts[item.product_id] || 0) + 1;
        });
      }

      const productsWithCounts = data.map(p => ({
        ...p,
        active_orders_count: activeCounts[p.id] || 0
      }));

      setProducts(productsWithCounts);
    } else if (error) {
      console.error('Error fetching products:', error);
      showToast(`خطأ في جلب البيانات: ${error.message}`, 'error');
    }
    setLoading(false);
  }

  const filteredProducts = useMemo(() => {
    return products.filter(p => 
      p.name?.toLowerCase().includes(searchQuery.toLowerCase()) || 
      p.category?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.part_number?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [products, searchQuery]);

  const existingCategories = useMemo(() => {
    const cats = products.map(p => p.category).filter(Boolean);
    return [...new Set(cats)];
  }, [products]);

  const handleSelectAll = (e) => {
    if (e.target.checked) setSelectedIds(filteredProducts.map(p => p.id));
    else setSelectedIds([]);
  };

  const handleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const showToast = (msg, type = 'success') => {
    setToastMessage(msg);
    setToastType(type);
    setTimeout(() => setToastMessage(''), 4000);
  };

  const executeDelete = async () => {
    const tryDelete = async (id) => {
      if (!store?.id) return;
      if (viewMode === 'deleted') {
        // Fetch product's image and gallery keys before hard deleting
        const { data: pData } = await supabase
          .from('products')
          .select('image, gallery')
          .eq('id', id)
          .eq('store_id', store.id)
          .single();

        // Hard delete from trash
        // 1. فك ارتباط المنتج بالطلبات القديمة حتى لا ينهار قاعدة البيانات (Soft disconnect)
        await supabase.from('order_items').update({ product_id: null }).eq('product_id', id);
        
        // 2. مسح حركات المخزون المرتبطة به
        await supabase.from('inventory_adjustments').delete().eq('product_id', id);

        // 3. حذف المنتج نهائياً
        const { error } = await supabase.from('products').delete().eq('id', id).eq('store_id', store.id);
        if (error) throw error;

        // Clean up R2 storage keys
        if (pData) {
          if (pData.image && !pData.image.startsWith('http://') && !pData.image.startsWith('https://')) {
            deleteFileFromR2(pData.image).catch(console.error);
          }
          if (Array.isArray(pData.gallery)) {
            pData.gallery.forEach(key => {
              if (key && !key.startsWith('http://') && !key.startsWith('https://')) {
                deleteFileFromR2(key).catch(console.error);
              }
            });
          }
        }

        return 'hard_deleted';
      } else {
        // Soft delete
        const { error } = await supabase.from('products').update({ 
          is_deleted: true, 
          is_active: false,
          deleted_at: new Date().toISOString()
        }).eq('id', id).eq('store_id', store.id);
        if (error) throw error;
        return 'soft_deleted';
      }
    };

    try {
      if (itemToDelete) {
        const result = await tryDelete(itemToDelete);
        if (result === 'soft_deleted') {
          setProducts(prev => prev.filter(p => p.id !== itemToDelete));
          showToast('تم إيقاف بيع المنتج وإخفاؤه', 'success');
        } else {
          setProducts(prev => prev.filter(p => p.id !== itemToDelete));
          showToast('تم حذف المنتج نهائياً', 'success');
        }
      } else if (selectedIds.length > 0) {
        let softDeleted = 0, hardDeleted = 0;
        await Promise.all(selectedIds.map(async (id) => {
          try {
            const r = await tryDelete(id);
            if (r === 'soft_deleted') softDeleted++;
            else hardDeleted++;
          } catch (err) {
            console.error('Error deleting ID:', id, err);
          }
        }));
        setProducts(prev => prev.filter(p => !selectedIds.includes(p.id)));
        setSelectedIds([]);
        const msgs = [];
        if (softDeleted > 0) msgs.push(`تم نقل ${softDeleted} منتج للمهملات`);
        if (hardDeleted > 0) msgs.push(`تم حذف ${hardDeleted} منتج نهائياً`);
        showToast(msgs.join('، '));
      }
    } catch (err) {
      console.error('Delete error:', err);
      if (err.code === '23503') {
        showToast('لا يمكن الحذف النهائي: المنتج مرتبط بطلبات سابقة.', 'error');
      } else {
        showToast(`فشل: ${err.message}`, 'error');
      }
    }
    setDeleteModalOpen(false);
    setActiveOrdersWarningModalOpen(false);
    setItemToDelete(null);
  };

  const confirmDelete = async () => {
    if (viewMode === 'active' && itemToDelete) {
      const product = products.find(p => p.id === itemToDelete);
      if (product && product.active_orders_count > 0) {
        setDeleteModalOpen(false);
        setActiveOrdersWarningModalOpen(true);
        return;
      }
    }
    executeDelete();
  };

  const handleRestore = async (id) => {
    if (!store?.id) return;
    try {
      const { error } = await supabase.from('products').update({ 
        is_deleted: false,
        deleted_at: null 
      }).eq('id', id).eq('store_id', store.id);
      if (error) throw error;
      setProducts(prev => prev.filter(p => p.id !== id));
      showToast('تم استرجاع المنتج بنجاح');
    } catch (err) {
      console.error('Restore error:', err);
      showToast(`فشل الاسترجاع: ${err.message}`, 'error');
    }
  };

  const uploadImage = async (file) => {
    return await uploadFileToR2({
      file,
      category: 'products'
    });
  };

  const handleSaveProduct = async (formData, imageFile, galleryFiles) => {
    try {
      let imageUrl = formData.image;
      
      // Replaced main image check
      const replacedMainImageKey = (imageFile && productToEdit?.image) ? productToEdit.image : null;
      
      // Removed gallery images check
      const removedGalleryKeys = productToEdit?.gallery
        ? productToEdit.gallery.filter(key => !formData.existingGallery.includes(key))
        : [];

      // Upload Main Image
      if (imageFile) {
        imageUrl = await uploadImage(imageFile);
      }

      // Upload Gallery Images
      const newGalleryUrls = [];
      for (const file of galleryFiles) {
        const url = await uploadImage(file);
        if (url) newGalleryUrls.push(url);
      }

      const finalGallery = [...formData.existingGallery, ...newGalleryUrls];

      const productPayload = {
        name: formData.name,
        price: formData.price,
        stock_quantity: formData.stock,
        category: formData.category,
        image: imageUrl,
        part_number: formData.part_number,
        old_price: formData.old_price,
        is_original: formData.is_original,
        is_active: formData.is_active,
        specs: formData.specs,
        compatibility: formData.compatibility,
        gallery: finalGallery,
        store_id: store.id
      };

      if (productToEdit) {
        // Update existing
        const { error } = await supabase
          .from('products')
          .update(productPayload)
          .eq('id', productToEdit.id)
          .eq('store_id', store.id);

        if (!error) {
          showToast('تم تعديل المنتج بنجاح');
          fetchProducts();
          // Clean up old files in R2 (GC)
          if (replacedMainImageKey) {
            deleteFileFromR2(replacedMainImageKey).catch(console.error);
          }
          removedGalleryKeys.forEach(key => {
            deleteFileFromR2(key).catch(console.error);
          });
        } else {
          console.error('Update Error:', error);
          showToast(`خطأ أثناء التعديل: ${error.message}`, 'error');
        }
      } else {
        // Insert new
        const { error } = await supabase
          .from('products')
          .insert([productPayload]);

        if (!error) {
          showToast('تم إضافة المنتج بنجاح');
          fetchProducts();
        } else {
          console.error('Insert Error:', error);
          showToast(`خطأ أثناء الإضافة: ${error.message}`, 'error');
        }
      }
      setProductModalOpen(false);
      setProductToEdit(null);
    } catch (err) {
      console.error('Unhandled Save Error:', err);
      showToast(`حدث خطأ غير متوقع أثناء الرفع: ${err.message}`, 'error');
    }
  };

  return (
    <div className="space-y-6 relative" dir="rtl">
      {/* Toast Notification */}
      {toastMessage && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[400] text-white px-6 py-3 rounded-lg flex items-center gap-2 shadow-xl animate-fade-in ${
          toastType === 'error' 
            ? 'bg-error shadow-[0_0_20px_rgba(255,84,73,0.5)]' 
            : 'bg-green-500 shadow-[0_0_20px_rgba(34,197,94,0.5)]'
        }`}>
          <span className="material-symbols-outlined">
            {toastType === 'error' ? 'error' : 'check_circle'}
          </span>
          {toastMessage}
        </div>
      )}

      {/* Header & Actions */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="font-headline-lg text-headline-lg text-on-surface">إدارة المنتجات المتقدمة</h2>
          <div className="flex bg-surface-container border border-white/10 rounded-lg p-1 w-max">
            <button 
              onClick={() => { setViewMode('active'); setSelectedIds([]); }}
              className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${viewMode === 'active' ? 'bg-primary text-white shadow-lg' : 'text-on-surface-variant hover:text-white'}`}
            >
              المنتجات النشطة
            </button>
            <button 
              onClick={() => { setViewMode('deleted'); setSelectedIds([]); }}
              className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all flex items-center gap-1 ${viewMode === 'deleted' ? 'bg-error text-white shadow-lg' : 'text-on-surface-variant hover:text-white'}`}
            >
              <span className="material-symbols-outlined text-[16px]">delete</span>
              سلة المهملات
            </button>
          </div>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-64">
            <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-[20px]">search</span>
            <input 
              type="text" 
              placeholder="بحث بالاسم أو رقم القطعة..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-10 pl-4 py-2 w-full bg-surface-container border border-white/10 rounded-lg text-white focus:outline-none focus:border-primary transition-colors"
            />
          </div>
          {viewMode === 'active' && (
            <button onClick={() => { setProductToEdit(null); setProductModalOpen(true); }} className="bg-primary hover:bg-primary-fixed transition-colors text-on-primary px-4 py-2 rounded-lg font-headline-md flex items-center gap-2 whitespace-nowrap shadow-[0_0_15px_rgba(255,153,0,0.3)]">
              <span className="material-symbols-outlined">add</span> إضافة
            </button>
          )}
        </div>
      </div>

      {/* Bulk Actions Toolbar */}
      {selectedIds.length > 0 && (
        <div className="bg-primary/10 border border-primary/30 p-3 rounded-lg flex justify-between items-center animate-fade-in">
          <span className="text-primary font-bold">تم تحديد {selectedIds.length} منتج</span>
          <button 
            onClick={() => { setItemToDelete(null); setDeleteModalOpen(true); }}
            className="text-error bg-error/10 hover:bg-error/20 px-3 py-1 rounded-md text-sm font-bold flex items-center gap-1 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span> {viewMode === 'active' ? 'نقل للمهملات' : 'حذف نهائي'}
          </button>
        </div>
      )}

      <div className="glass-panel rounded-xl overflow-hidden border border-white/10 shadow-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-white/5 border-b border-white/10">
                <th className="p-4 w-12 text-center">
                  <input type="checkbox" onChange={handleSelectAll} checked={selectedIds.length === filteredProducts.length && filteredProducts.length > 0} className="accent-primary w-4 h-4 cursor-pointer" />
                </th>
                <th className="p-4 font-label-sm text-on-surface-variant">المنتج / رقم القطعة</th>
                <th className="p-4 font-label-sm text-on-surface-variant">الفئة</th>
                <th className="p-4 font-label-sm text-on-surface-variant">السعر</th>
                <th className="p-4 font-label-sm text-on-surface-variant">حالة المخزون</th>
                <th className="p-4 font-label-sm text-on-surface-variant text-center">الطلبات النشطة</th>
                <th className="p-4 font-label-sm text-on-surface-variant text-left">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading ? (
                <tr>
                  <td colSpan="7" className="p-8 text-center text-primary">
                    جاري تحميل المنتجات من قاعدة البيانات...
                  </td>
                </tr>
              ) : filteredProducts.map(p => (
                <tr key={p.id} className="hover:bg-white/5 transition-colors">
                  <td className="p-4 text-center">
                    <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => handleSelect(p.id)} className="accent-primary w-4 h-4 cursor-pointer" />
                  </td>
                  <td className="p-4 text-on-surface font-headline-md flex items-center gap-3">
                    {p.image ? (
                      <img src={getMediaUrl(p.image)} className="w-12 h-12 rounded object-cover bg-surface-container" />
                    ) : (
                      <div className="w-12 h-12 rounded bg-surface-container flex items-center justify-center">
                        <span className="material-symbols-outlined text-on-surface-variant text-[24px]">image</span>
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        {p.name}
                        {!p.is_active && <span className="bg-surface-container-highest text-on-surface-variant text-[10px] px-2 py-0.5 rounded-full border border-white/10 font-bold">مخفي</span>}
                      </div>
                      <div className="text-xs text-on-surface-variant font-body-sm mt-1" dir="ltr">{p.part_number || 'N/A'}</div>
                    </div>
                  </td>
                  <td className="p-4 text-on-surface-variant">{p.category}</td>
                  <td className="p-4">
                    <div className="text-primary font-bold">{p.price}</div>
                    {p.old_price && <div className="text-xs text-on-surface-variant line-through">{p.old_price}</div>}
                    {p.cost_price && <div className="text-[10px] text-yellow-500 mt-1 font-mono bg-yellow-500/10 px-1 py-0.5 rounded w-max inline-block">تكلفة: {p.cost_price}</div>}
                  </td>
                  <td className="p-4">
                    <div className="flex flex-col gap-1 items-start">
                      <span className={`px-2 py-0.5 rounded text-xs border flex items-center gap-1 w-max ${p.stock_quantity > 10 ? 'bg-green-500/10 text-green-400 border-green-500/20' : p.stock_quantity > 0 ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' : 'bg-error/10 text-error border-error/20'}`}>
                        {p.stock_quantity > 0 ? p.stock_quantity + ' متوفر' : 'نفذت'}
                      </span>
                      {p.is_original && (
                        <span className="px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center gap-1 w-max">
                          <span className="material-symbols-outlined text-[12px]">verified</span> أصلية
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4 text-center">
                    {p.active_orders_count > 0 ? (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 inline-block w-max">
                        {p.active_orders_count} طلب
                      </span>
                    ) : (
                      <span className="text-on-surface-variant text-xs opacity-50">—</span>
                    )}
                  </td>
                  <td className="p-4 flex gap-2 justify-end">
                    {viewMode === 'active' ? (
                      <>
                        <button onClick={() => { setProductToEdit(p); setProductModalOpen(true); }} className="p-2 bg-blue-500/10 text-blue-400 rounded hover:bg-blue-500/20 transition-colors" title="تعديل">
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button onClick={() => { setItemToDelete(p.id); setDeleteModalOpen(true); }} className="p-2 bg-error/10 text-error rounded hover:bg-error/20 transition-colors" title="نقل للمهملات">
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => handleRestore(p.id)} className="p-2 bg-green-500/10 text-green-400 rounded hover:bg-green-500/20 transition-colors" title="استرجاع">
                          <span className="material-symbols-outlined text-[18px]">restore_from_trash</span>
                        </button>
                        <button onClick={() => { setItemToDelete(p.id); setDeleteModalOpen(true); }} className="p-2 bg-error/10 text-error rounded hover:bg-error/20 transition-colors" title="حذف نهائي">
                          <span className="material-symbols-outlined text-[18px]">delete_forever</span>
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filteredProducts.length === 0 && (
            <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
              <span className="material-symbols-outlined text-[48px] opacity-20">inventory_2</span>
              لا توجد منتجات مطابقة.
            </div>
          )}
        </div>
      </div>

      <ConfirmModal 
        isOpen={deleteModalOpen} 
        title={itemToDelete ? (viewMode === 'active' ? "نقل المنتج للمهملات؟" : "حذف المنتج نهائياً؟") : `تحديد ${selectedIds.length} منتجات؟`}
        message={viewMode === 'active' ? "سيتم نقل المنتجات إلى سلة المهملات ولن تظهر في المتجر." : "تحذير: سيتم حذف المنتجات نهائياً من قاعدة البيانات. هذه العملية لا يمكن التراجع عنها، وإذا كان المنتج مرتبطاً بطلبات سابقة ستفشل العملية."}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteModalOpen(false)}
      />

      <ProductModal
        isOpen={productModalOpen}
        product={productToEdit}
        existingCategories={existingCategories}
        onSave={handleSaveProduct}
        onCancel={() => { setProductModalOpen(false); setProductToEdit(null); }}
      />

      {activeOrdersWarningModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[400] flex items-center justify-center p-4" dir="rtl">
          <div className="glass-panel p-6 rounded-xl border border-yellow-500/30 max-w-md w-full shadow-[0_0_40px_rgba(0,0,0,0.8)] bg-surface-container">
            <div className="flex items-center gap-3 text-yellow-500 mb-4">
              <span className="material-symbols-outlined text-[32px]">warning</span>
              <h3 className="text-xl font-bold">تنبيه: طلبات نشطة!</h3>
            </div>
            <p className="text-white text-sm mb-6 leading-relaxed">
              هذا المنتج موجود حالياً في <strong className="text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded">{products.find(p => p.id === itemToDelete)?.active_orders_count} طلبات</strong> قيد التنفيذ. 
              <br/><br/>
              يمكنك متابعة الأرشفة لإيقاف بيعه فوراً، أو عرض الطلبات لمراجعتها.
            </p>
            <div className="flex flex-col gap-3">
              <a href={`/admin/wa-requests?productId=${itemToDelete}`} target="_blank" rel="noopener noreferrer" className="w-full px-4 py-3 bg-primary/10 text-primary border border-primary/20 rounded-lg font-bold text-center hover:bg-primary/20 transition-colors flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[18px]">list_alt</span>
                عرض الطلبات المرتبطة
              </a>
              <button onClick={executeDelete} className="w-full px-4 py-3 bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 rounded-lg font-bold hover:bg-yellow-500/20 transition-colors flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[18px]">archive</span>
                متابعة الأرشفة (إيقاف البيع)
              </button>
              <button onClick={() => setActiveOrdersWarningModalOpen(false)} className="w-full px-4 py-2 mt-2 text-on-surface-variant hover:text-white transition-colors">
                إلغاء والتراجع
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
