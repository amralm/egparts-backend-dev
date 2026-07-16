import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useStore } from '../../context/StoreContext';

export default function Coupons() {
  const { store } = useStore();
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  
  const [formData, setFormData] = useState({
    code: '', discount_percentage: 0, discount_amount: 0,
    min_order_value: 0, max_uses: 100, is_active: true
  });

  const openModalForAdd = () => {
    setEditingId(null);
    setFormData({ code: '', discount_percentage: 0, discount_amount: 0, min_order_value: 0, max_uses: 100, is_active: true });
    setIsModalOpen(true);
  };

  const openModalForEdit = (coupon) => {
    setEditingId(coupon.id);
    setFormData({
      code: coupon.code,
      discount_percentage: coupon.discount_percentage || 0,
      discount_amount: coupon.discount_amount || 0,
      min_order_value: coupon.min_order_value || 0,
      max_uses: coupon.max_uses || 100,
      is_active: coupon.is_active
    });
    setIsModalOpen(true);
  };

  useEffect(() => {
    if (store?.id) {
      fetchCoupons();
    }
  }, [store?.id]);

  async function fetchCoupons() {
    if (!store?.id) return;
    setLoading(true);
    const { data } = await supabase
      .from('coupons')
      .select('*')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });
    if (data) setCoupons(data);
    setLoading(false);
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!store?.id) return;
    const payload = {
      code: formData.code.toUpperCase(),
      discount_percentage: formData.discount_percentage,
      discount_amount: formData.discount_amount,
      min_order_value: formData.min_order_value,
      max_uses: formData.max_uses,
      is_active: formData.is_active,
      store_id: store.id
    };

    let error;
    if (editingId) {
      const { id, store_id, created_at, ...updatePayload } = payload;
      const res = await supabase
        .from('coupons')
        .update(updatePayload)
        .eq('id', editingId)
        .eq('store_id', store.id);
      error = res.error;
    } else {
      const res = await supabase.from('coupons').insert([payload]);
      error = res.error;
    }

    if (!error) {
      setIsModalOpen(false);
      fetchCoupons();
    } else {
      alert("حدث خطأ، ربما الكود مستخدم مسبقاً أو لا توجد صلاحيات");
    }
  }

  async function toggleStatus(id, currentStatus) {
    if (!store?.id) return;
    await supabase
      .from('coupons')
      .update({ is_active: !currentStatus })
      .eq('id', id)
      .eq('store_id', store.id);
    fetchCoupons();
  }

  async function deleteCoupon(id) {
    if (!store?.id) return;
    if(confirm('هل أنت متأكد من الحذف؟')) {
      await supabase
        .from('coupons')
        .delete()
        .eq('id', id)
        .eq('store_id', store.id);
      fetchCoupons();
    }
  }

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex justify-between items-center bg-surface-container border border-white/10 p-6 rounded-2xl shadow-lg">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">كوبونات الخصم</h2>
          <p className="text-on-surface-variant text-sm">إدارة العروض والخصومات لتشجيع المبيعات</p>
        </div>
        <button 
          onClick={openModalForAdd}
          className="bg-primary hover:bg-primary-fixed text-on-primary px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all shadow-[0_0_20px_rgba(255,153,0,0.2)]"
        >
          <span className="material-symbols-outlined">add_box</span> كوبون جديد
        </button>
      </div>

      <div className="glass-panel rounded-xl overflow-hidden border border-white/10">
        <table className="w-full text-right border-collapse">
          <thead>
            <tr className="bg-white/5 border-b border-white/10">
              <th className="p-4 font-bold text-on-surface-variant">الكود</th>
              <th className="p-4 font-bold text-on-surface-variant">الخصم</th>
              <th className="p-4 font-bold text-on-surface-variant">حد أدنى للطلب</th>
              <th className="p-4 font-bold text-on-surface-variant">الاستخدام</th>
              <th className="p-4 font-bold text-on-surface-variant">الحالة</th>
              <th className="p-4 font-bold text-on-surface-variant">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan="6" className="p-8 text-center text-primary">جاري التحميل...</td></tr>
            ) : coupons.length === 0 ? (
              <tr><td colSpan="6" className="p-8 text-center text-on-surface-variant">لا توجد كوبونات مسجلة.</td></tr>
            ) : coupons.map(c => (
              <tr key={c.id} className="hover:bg-white/5 transition-colors">
                <td className="p-4 font-mono font-bold text-primary tracking-widest bg-primary/10 rounded my-2 mx-4 inline-block">{c.code}</td>
                <td className="p-4">
                  {c.discount_percentage > 0 ? `${c.discount_percentage}% نسبة` : `EGP ${c.discount_amount} ثابت`}
                </td>
                <td className="p-4 text-on-surface-variant">{c.min_order_value} EGP</td>
                <td className="p-4 text-on-surface-variant">
                  <div className="flex flex-col gap-1 w-full max-w-[150px]">
                    <div className="flex justify-between text-[11px] font-bold">
                      <span className="text-primary">{c.used_count} مستخدم</span>
                      <span className="text-on-surface-variant/70">الحد: {c.max_uses}</span>
                    </div>
                    <div className="w-full bg-surface-variant rounded-full h-1.5 overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${c.used_count >= c.max_uses ? 'bg-error' : 'bg-primary'}`} 
                        style={{ width: `${Math.min(100, (c.used_count / c.max_uses) * 100)}%` }}
                      ></div>
                    </div>
                  </div>
                </td>
                <td className="p-4">
                  <button 
                    onClick={() => toggleStatus(c.id, c.is_active)}
                    className={`px-3 py-1 text-xs rounded-full border font-bold flex items-center justify-center gap-1 w-24 ${c.is_active ? 'bg-green-500/10 border-green-500/30 text-green-500 hover:bg-green-500/20' : 'bg-surface-container border-white/10 text-on-surface-variant hover:bg-white/5'}`}
                  >
                    <span className="material-symbols-outlined text-[14px]">{c.is_active ? 'check_circle' : 'cancel'}</span>
                    {c.is_active ? 'فعال' : 'معطل'}
                  </button>
                </td>
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    <button onClick={() => openModalForEdit(c)} className="p-2 bg-blue-500/10 text-blue-400 rounded hover:bg-blue-500/20 transition-colors" title="تعديل">
                      <span className="material-symbols-outlined text-[18px]">edit</span>
                    </button>
                    <button onClick={() => deleteCoupon(c.id)} className="p-2 bg-error/10 text-error rounded hover:bg-error/20 transition-colors" title="حذف">
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className="glass-panel p-6 rounded-xl border border-white/10 max-w-md w-full animate-fade-in">
            <div className="flex justify-between items-center mb-6 border-b border-white/5 pb-4">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">{editingId ? 'edit' : 'add_box'}</span>
                {editingId ? 'تعديل الكوبون' : 'إضافة كوبون جديد'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-on-surface-variant hover:text-white">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm mb-1 text-on-surface-variant">كود الخصم (انجليزي فقط)</label>
                <input required type="text" value={formData.code} onChange={e => setFormData({...formData, code: e.target.value.toUpperCase()})} className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white font-mono dir-ltr focus:border-primary focus:outline-none" placeholder="EGYPARTS10" dir="ltr" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1 text-on-surface-variant">نسبة الخصم (%)</label>
                  <input type="number" min="0" max="100" value={formData.discount_percentage} onChange={e => setFormData({...formData, discount_percentage: Number(e.target.value)})} className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:border-primary focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm mb-1 text-on-surface-variant">مبلغ ثابت (EGP)</label>
                  <input type="number" min="0" value={formData.discount_amount} onChange={e => setFormData({...formData, discount_amount: Number(e.target.value)})} className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:border-primary focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1 text-on-surface-variant">الحد الأدنى للطلب</label>
                  <input type="number" min="0" value={formData.min_order_value} onChange={e => setFormData({...formData, min_order_value: Number(e.target.value)})} className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:border-primary focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm mb-1 text-on-surface-variant">أقصى عدد للاستخدام</label>
                  <input type="number" min="1" value={formData.max_uses} onChange={e => setFormData({...formData, max_uses: Number(e.target.value)})} className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 text-white focus:border-primary focus:outline-none" />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/5">
                <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-on-surface-variant hover:text-white font-bold">إلغاء</button>
                <button type="submit" className="px-6 py-2 bg-primary text-on-primary font-bold rounded-lg hover:bg-primary-fixed shadow-[0_0_15px_rgba(255,153,0,0.3)] transition-all">
                  {editingId ? 'حفظ التعديلات' : 'حفظ وتفعيل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
