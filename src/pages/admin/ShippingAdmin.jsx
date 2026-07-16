import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useStore } from '../../context/StoreContext';

export default function ShippingAdmin() {
  const { store } = useStore();
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingZone, setEditingZone] = useState(null);
  
  // New zone form state
  const [newCityName, setNewCityName] = useState('');
  const [newFee, setNewFee] = useState('');

  useEffect(() => {
    if (store?.id) {
      fetchZones();
    }
  }, [store?.id]);

  const fetchZones = async () => {
    if (!store?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('shipping_zones')
      .select('*')
      .eq('store_id', store.id)
      .order('city_name', { ascending: true });
      
    if (data) setZones(data);
    setLoading(false);
  };

  const handleAddZone = async (e) => {
    e.preventDefault();
    if (!newCityName || !newFee || !store?.id) return;

    const { data, error } = await supabase
      .from('shipping_zones')
      .insert([{ city_name: newCityName, shipping_fee: parseFloat(newFee), store_id: store.id }])
      .select();

    if (error) {
      alert('خطأ في إضافة المحافظة');
    } else if (data) {
      setZones([...zones, data[0]].sort((a, b) => a.city_name.localeCompare(b.city_name)));
      setNewCityName('');
      setNewFee('');
    }
  };

  const handleUpdateZone = async (id, newFeeValue) => {
    if (!store?.id) return;
    const { error } = await supabase
      .from('shipping_zones')
      .update({ shipping_fee: parseFloat(newFeeValue) })
      .eq('id', id)
      .eq('store_id', store.id);

    if (error) {
      alert('خطأ في تحديث السعر');
    } else {
      setZones(zones.map(z => z.id === id ? { ...z, shipping_fee: parseFloat(newFeeValue) } : z));
      setEditingZone(null);
    }
  };

  const handleDeleteZone = async (id) => {
    if (!store?.id) return;
    if (!window.confirm('هل أنت متأكد من حذف هذه المحافظة؟')) return;
    
    const { error } = await supabase
      .from('shipping_zones')
      .delete()
      .eq('id', id)
      .eq('store_id', store.id);

    if (error) {
      alert('خطأ في الحذف');
    } else {
      setZones(zones.filter(z => z.id !== id));
    }
  };

  return (
    <div dir="rtl" className="max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">إدارة مناطق الشحن 🚚</h2>
          <p className="text-on-surface-variant">التحكم في أسعار الشحن ديناميكياً لكل محافظة.</p>
        </div>
      </div>

      {/* Add New Zone Form */}
      <div className="glass-panel p-6 rounded-xl border border-white/10 mb-8">
        <h3 className="text-lg font-bold text-white mb-4">إضافة محافظة جديدة</h3>
        <form onSubmit={handleAddZone} className="flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1 w-full">
            <label className="block text-sm font-bold text-on-surface-variant mb-2">اسم المحافظة</label>
            <input 
              type="text" 
              required
              value={newCityName}
              onChange={(e) => setNewCityName(e.target.value)}
              placeholder="مثال: الإسكندرية"
              className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-primary focus:outline-none transition-colors"
            />
          </div>
          <div className="flex-1 w-full">
            <label className="block text-sm font-bold text-on-surface-variant mb-2">تسعيرة الشحن (جنية مصري)</label>
            <input 
              type="number" 
              required
              min="0"
              step="any"
              value={newFee}
              onChange={(e) => setNewFee(e.target.value)}
              placeholder="مثال: 50"
              className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-primary focus:outline-none transition-colors"
            />
          </div>
          <button 
            type="submit"
            className="bg-primary hover:bg-primary-fixed text-on-primary font-bold px-6 py-2 rounded-lg transition-colors h-[42px] flex items-center justify-center gap-2 w-full md:w-auto"
          >
            <span className="material-symbols-outlined text-[20px]">add</span>
            إضافة
          </button>
        </form>
      </div>

      {/* Zones List */}
      <div className="glass-panel rounded-xl border border-white/10 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-primary animate-pulse">جاري التحميل...</div>
        ) : zones.length === 0 ? (
          <div className="p-8 text-center text-on-surface-variant">لم يتم إضافة أي مناطق شحن بعد.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right">
              <thead className="bg-surface-container-high/50 text-on-surface-variant">
                <tr>
                  <th className="p-4 font-bold w-1/3">المحافظة</th>
                  <th className="p-4 font-bold w-1/3">السعر (EGP)</th>
                  <th className="p-4 font-bold w-1/3 text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {zones.map((zone) => (
                  <tr key={zone.id} className="hover:bg-white/5 transition-colors group">
                    <td className="p-4 text-white font-bold">{zone.city_name}</td>
                    <td className="p-4" dir="ltr">
                      {editingZone === zone.id ? (
                        <input
                          type="number"
                          defaultValue={zone.shipping_fee}
                          className="w-24 bg-black/40 border border-primary rounded px-2 py-1 text-white focus:outline-none text-right"
                          onBlur={(e) => handleUpdateZone(zone.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleUpdateZone(zone.id, e.target.value);
                            if (e.key === 'Escape') setEditingZone(null);
                          }}
                          autoFocus
                        />
                      ) : (
                        <span className="text-green-400 font-mono bg-green-400/10 px-2 py-1 rounded inline-block">EGP {zone.shipping_fee}</span>
                      )}
                    </td>
                    <td className="p-4 text-left">
                      <div className="flex justify-end gap-2">
                        {editingZone === zone.id ? (
                          <button 
                            onClick={() => setEditingZone(null)}
                            className="text-on-surface-variant hover:text-white p-2 rounded-lg bg-surface-container transition-colors"
                            title="إلغاء التعديل"
                          >
                            <span className="material-symbols-outlined text-[18px]">close</span>
                          </button>
                        ) : (
                          <button 
                            onClick={() => setEditingZone(zone.id)}
                            className="text-blue-400 hover:text-blue-300 p-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 transition-colors"
                            title="تعديل السعر"
                          >
                            <span className="material-symbols-outlined text-[18px]">edit</span>
                          </button>
                        )}
                        <button 
                          onClick={() => handleDeleteZone(zone.id)}
                          className="text-error hover:text-red-400 p-2 rounded-lg bg-error/10 hover:bg-error/20 transition-colors"
                          title="حذف المحافظة"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
