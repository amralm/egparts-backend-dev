import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';

import { useSearchParams, Link } from 'react-router-dom';
import { useStore } from '../../context/StoreContext';

const COLUMNS = [
  { id: 'pending', title: 'قيد المراجعة', bg: 'bg-yellow-500/10', color: 'border-yellow-500/20', text: 'text-yellow-500', icon: 'hourglass_empty' },
  { id: 'confirmed', title: 'تم التأكيد', bg: 'bg-emerald-500/10', color: 'border-emerald-500/20', text: 'text-emerald-500', icon: 'check_circle' },
  { id: 'processing', title: 'جاري التجهيز', bg: 'bg-blue-500/10', color: 'border-blue-500/20', text: 'text-blue-500', icon: 'inventory_2' },
  { id: 'shipped', title: 'تم الشحن', bg: 'bg-purple-500/10', color: 'border-purple-500/20', text: 'text-purple-500', icon: 'local_shipping' },
  { id: 'delivered', title: 'تم التسليم', bg: 'bg-green-500/10', color: 'border-green-500/20', text: 'text-green-500', icon: 'checklist' },
  { id: 'cancelled', title: 'ملغي', bg: 'bg-red-500/10', color: 'border-red-500/20', text: 'text-red-500', icon: 'cancel' }
];

const TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: []
};

const STATUS_LABELS = {
  pending: 'قيد المراجعة', confirmed: 'تم التأكيد', processing: 'جاري التجهيز',
  shipped: 'تم الشحن', delivered: 'تم التسليم', cancelled: 'ملغي'
};

export default function WARequests() {
  const { store } = useStore();
  const [searchParams] = useSearchParams();
  const filterProductId = searchParams.get('productId');
  const [filterProductData, setFilterProductData] = useState(null);

  const [requests, setRequests] = useState([]);
  const [viewMode, setViewMode] = useState(() => window.innerWidth < 768 ? 'list' : 'kanban');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });

  useEffect(() => {
    if (store?.id) {
      fetchRequests();
    }
    const handleResize = () => {
      if (window.innerWidth < 768 && viewMode === 'kanban') setViewMode('list');
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [store?.id]);

  const filteredRequests = requests.filter(r => {
    const matchSearch = !searchTerm.trim() ||
      `${r.order_number || ''}`.includes(searchTerm.trim()) ||
      (r.phone || '').includes(searchTerm.trim()) ||
      (r.city || '').toLowerCase().includes(searchTerm.trim().toLowerCase());
    const matchStatus = statusFilter === 'all' || r.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const stats = COLUMNS.reduce((acc, c) => ({ ...acc, [c.id]: requests.filter(r => r.status === c.id).length }), { total: requests.length });

  const fetchRequests = async () => {
    if (!store?.id) return;
    setLoading(true);
    try {
      if (filterProductId) {
        const { data: pData } = await supabase.from('products').select('id, name, image').eq('id', filterProductId).eq('store_id', store.id).single();
        if (pData) setFilterProductData(pData);
      }

      const { data, error } = await supabase.from('orders').select('*').eq('store_id', store.id).order('created_at', { ascending: false });
      if (error) throw error;
      
      let finalData = data || [];
      if (filterProductId) {
        finalData = finalData.filter(order => order.items && order.items.some(i => i.id === filterProductId));
      }

      setRequests(finalData);
    } catch (err) {
      console.error(err);
      showToast('خطأ في تحميل الطلبات', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleStatusUpdate = async (orderId, currentStatus, newStatus) => {
    if (currentStatus === newStatus || !store?.id) return;
    const allowed = TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      showToast('❌ انتقال غير مسموح به لهذه الحالة', 'error');
      return;
    }

    setActionLoading(orderId);
    const order = requests.find(r => r.id === orderId);

    // Auto-update payment status to 'paid' if delivered (for cash orders)
    let newPaymentStatus = order.payment_status;
    if (newStatus === 'delivered' && order.payment_status !== 'paid') {
      newPaymentStatus = 'paid';
    }

    setRequests(prev => prev.map(r => r.id === orderId ? { ...r, status: newStatus, payment_status: newPaymentStatus } : r));
    if (selectedOrder?.id === orderId) setSelectedOrder(prev => ({ ...prev, status: newStatus, payment_status: newPaymentStatus }));

    try {
      const { error: updateError } = await supabase.from('orders').update({ status: newStatus, payment_status: newPaymentStatus }).eq('id', orderId).eq('store_id', store.id);
      if (updateError) throw updateError;

      await supabase.from('order_logs').insert([{
        order_id: orderId,
        admin_id: (await supabase.auth.getUser()).data.user?.id,
        old_status: currentStatus,
        new_status: newStatus,
        note: `Status updated via Admin: ${currentStatus} -> ${newStatus}`
      }]);

      if (order?.user_id) {
        await supabase.from('user_notifications').insert([{
          user_id: order.user_id,
          store_id: store.id,
          title: '📦 تم تحديث حالة طلبك',
          message: `طلب EG-${order.order_number || order.id.split('-')[0]} تم نقله إلى: ${STATUS_LABELS[newStatus]}`,
          type: 'order_update',
          order_id: orderId,
          is_read: false
        }]);
      }

      if (order?.phone) {
        await supabase.from('notification_queue').insert([{
          recipient: order.phone,
          store_id: store.id,
          payload: { message: `إشعار تحديث الطلب EG-${order.order_number || order.id.split('-')[0]}\n\nتم تحديث حالة طلبكم لتصبح: ${STATUS_LABELS[newStatus]}\nنشكركم لاختياركم EG-PARTS.` },
          type: 'whatsapp',
          status: 'pending',
          order_id: orderId
        }]);
      }

      showToast(`✅ تم نقل الطلب إلى "${STATUS_LABELS[newStatus]}"`, 'success');
    } catch (err) {
      console.error(err);
      showToast('❌ ' + (err.message || 'فشل في تحديث الحالة'), 'error');
      fetchRequests();
    } finally {
      setActionLoading(null);
    }
  };

  const handlePaymentStatusUpdate = async (orderId, newPaymentStatus) => {
    if (!store?.id) return;
    setActionLoading(orderId);
    
    setRequests(prev => prev.map(r => r.id === orderId ? { ...r, payment_status: newPaymentStatus } : r));
    if (selectedOrder?.id === orderId) setSelectedOrder(prev => ({ ...prev, payment_status: newPaymentStatus }));

    try {
      const { error: updateError } = await supabase.from('orders').update({ payment_status: newPaymentStatus }).eq('id', orderId).eq('store_id', store.id);
      if (updateError) throw updateError;

      await supabase.from('order_logs').insert([{
        order_id: orderId,
        admin_id: (await supabase.auth.getUser()).data.user?.id,
        old_status: 'payment update',
        new_status: newPaymentStatus,
        note: `Payment status updated via Admin: ${newPaymentStatus}`
      }]);

      showToast(`✅ تم تحديث حالة الدفع إلى "${newPaymentStatus === 'paid' ? 'مدفوع' : newPaymentStatus === 'unpaid' ? 'غير مدفوع' : 'فشل'}"`, 'success');
    } catch (err) {
      console.error(err);
      showToast('❌ فشل في تحديث حالة الدفع', 'error');
      fetchRequests();
    } finally {
      setActionLoading(null);
    }
  };

  const handleDragStart = (e, id, currentStatus) => {
    e.dataTransfer.setData('orderId', id);
    e.dataTransfer.setData('currentStatus', currentStatus);
  };

  const handleDrop = (e, newStatus) => {
    e.preventDefault();
    handleStatusUpdate(e.dataTransfer.getData('orderId'), e.dataTransfer.getData('currentStatus'), newStatus);
  };

  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: 'success' }), 3000);
  };

  return (
    <div className="p-4 md:p-8 min-h-screen bg-background" dir="rtl">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-primary/20 rounded-2xl flex items-center justify-center border border-primary/30">
            <span className="material-symbols-outlined text-primary text-2xl">orders</span>
          </div>
          <div>
            <h2 className="font-headline-lg text-2xl font-bold text-gray-900 dark:text-white">إدارة الطلبات</h2>
            <p className="text-gray-500 dark:text-on-surface-variant mt-1 text-sm">نظام تتبع ومعالجة الطلبات الذكي</p>
          </div>
        </div>
        <div className="flex bg-gray-100 dark:bg-surface-container p-1 rounded-xl border border-gray-200 dark:border-white/10 self-end md:self-auto">
          <button onClick={() => setViewMode('kanban')}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-all ${viewMode === 'kanban' ? 'bg-primary text-white font-bold shadow-lg' : 'text-gray-600 dark:text-on-surface-variant hover:text-gray-900 dark:hover:text-white'}`}>
            <span className="material-symbols-outlined text-[18px]">view_kanban</span>
            <span className="text-xs">Kanban</span>
          </button>
          <button onClick={() => setViewMode('list')}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-all ${viewMode === 'list' ? 'bg-primary text-white font-bold shadow-lg' : 'text-gray-600 dark:text-on-surface-variant hover:text-gray-900 dark:hover:text-white'}`}>
            <span className="material-symbols-outlined text-[18px]">view_list</span>
            <span className="text-xs">قائمة</span>
          </button>
        </div>
      </div>

      {filterProductData && (
        <div className="bg-gray-50 dark:bg-surface-container-high border border-gray-200 dark:border-primary/30 rounded-2xl p-4 mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-lg shadow-primary/5">
          <div className="flex items-center gap-4">
            {filterProductData.image ? (
              <img src={filterProductData.image} alt={filterProductData.name} className="w-16 h-16 rounded-xl object-cover border border-gray-200 dark:border-white/10" />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-gray-100 dark:bg-surface-container flex items-center justify-center border border-gray-200 dark:border-white/10">
                <span className="material-symbols-outlined text-gray-400 dark:text-on-surface-variant">inventory_2</span>
              </div>
            )}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary text-[20px]">filter_alt</span>
                <h3 className="font-bold text-gray-900 dark:text-white">الطلبات المرتبطة بالمنتج</h3>
              </div>
              <p className="text-sm text-gray-500 dark:text-on-surface-variant">{filterProductData.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="bg-white dark:bg-surface-container px-4 py-2 rounded-lg border border-gray-200 dark:border-white/5 text-center flex-1 md:flex-none">
              <span className="block text-xl font-black text-gray-900 dark:text-white">{requests.length}</span>
              <span className="text-[10px] text-gray-500 dark:text-on-surface-variant font-bold">طلب معروض</span>
            </div>
            <Link to="/admin/wa-requests" className="px-4 py-3 bg-error/10 hover:bg-error/20 text-error rounded-lg transition-colors border border-error/20 flex items-center justify-center font-bold text-sm">
              إلغاء الفلتر
            </Link>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        {COLUMNS.map(col => (
          <div key={col.id} className={`${col.bg} border ${col.color} rounded-xl p-3 text-center`}>
            <p className="text-2xl font-black text-gray-900 dark:text-white">{stats[col.id] || 0}</p>
            <p className={`text-[10px] font-bold ${col.text} mt-1`}>{col.title}</p>
          </div>
        ))}
        <div className="bg-gray-100 dark:bg-surface-container border border-gray-200 dark:border-white/10 rounded-xl p-3 text-center">
          <p className="text-2xl font-black text-primary">{stats.total || 0}</p>
          <p className="text-[10px] font-bold text-gray-500 dark:text-on-surface-variant mt-1">الكل</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 dark:text-on-surface-variant text-[18px]">search</span>
          <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            placeholder="ابحث برقم الطلب أو التليفون..." dir="rtl"
            className="w-full bg-white dark:bg-surface-container border border-gray-300 dark:border-white/10 rounded-xl py-3 pr-12 pl-4 text-gray-900 dark:text-white text-sm placeholder:text-gray-400 dark:placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50 transition-all" />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button onClick={() => setStatusFilter('all')}
            className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${statusFilter === 'all' ? 'bg-primary text-white border-primary shadow-lg' : 'bg-white dark:bg-surface-container text-gray-600 dark:text-on-surface-variant border-gray-200 dark:border-white/10 hover:text-gray-900 dark:hover:text-white'}`}>
            الكل ({requests.length})
          </button>
          {COLUMNS.map(col => (
            <button key={col.id} onClick={() => setStatusFilter(col.id)}
              className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${statusFilter === col.id ? `${col.bg} ${col.text} ${col.color} shadow-lg` : 'bg-white dark:bg-surface-container text-gray-600 dark:text-on-surface-variant border-gray-200 dark:border-white/10 hover:text-gray-900 dark:hover:text-white'}`}>
              {col.title} ({stats[col.id] || 0})
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex justify-center items-center h-64">
            <span className="material-symbols-outlined animate-spin text-4xl text-primary">progress_activity</span>
          </motion.div>
        ) : filteredRequests.length === 0 ? (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-on-surface-variant">
            <span className="material-symbols-outlined text-6xl mb-4">search_off</span>
            <p className="font-bold">لا توجد طلبات مطابقة</p>
          </motion.div>
        ) : viewMode === 'kanban' ? (
          <KanbanView key="kanban" requests={filteredRequests} onDragStart={handleDragStart} onDrop={handleDrop}
            onSelectOrder={setSelectedOrder} actionLoading={actionLoading} />
        ) : (
          <ListView key="list" requests={filteredRequests} onStatusUpdate={handleStatusUpdate}
            onSelectOrder={setSelectedOrder} actionLoading={actionLoading} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectedOrder && (
          <OrderDetailModal order={selectedOrder} onClose={() => setSelectedOrder(null)}
            onStatusUpdate={handleStatusUpdate} onPaymentStatusUpdate={handlePaymentStatusUpdate} actionLoading={actionLoading} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast.show && (
          <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }}
            className={`fixed bottom-10 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full shadow-2xl border z-[100] font-bold flex items-center gap-2 ${
              toast.type === 'success' ? 'bg-emerald-500/90 text-white border-emerald-400/30' : 'bg-red-500/90 text-white border-red-400/30'
            }`}>
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function KanbanView({ requests, onDragStart, onDrop, onSelectOrder, actionLoading }) {
  return (
    <div className="w-full overflow-x-auto pb-6 snap-x snap-mandatory kanban-scrollbar custom-scrollbar-horizontal">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
        className="flex gap-6 min-h-[600px] w-max px-2">
        {COLUMNS.map(column => (
          <div key={column.id}
            className="flex-none w-[320px] snap-center bg-surface-container-low border border-outline/50 rounded-2xl p-4 flex flex-col self-start shadow-sm"
          onDragOver={e => e.preventDefault()}
          onDrop={e => onDrop(e, column.id)}>
          <div className={`px-4 py-3 rounded-xl mb-4 flex justify-between items-center ${column.bg} border ${column.color}`}>
            <span className="material-symbols-outlined text-[18px] ml-2">{column.icon}</span>
            <h3 className="font-bold text-gray-900 dark:text-white text-lg flex-1">{column.title}</h3>
            <span className="bg-black/10 dark:bg-black/40 text-gray-700 dark:text-white px-2 py-0.5 rounded-full text-xs font-bold border border-gray-300 dark:border-white/10">
              {requests.filter(r => r.status === column.id).length}
            </span>
          </div>
          <div className="flex-1 space-y-4">
            {requests.filter(r => r.status === column.id).map(req => (
              <OrderCard key={req.id} req={req} onClick={() => onSelectOrder(req)}
                onDragStart={onDragStart} isUpdating={actionLoading === req.id} />
            ))}
          </div>
          </div>
        ))}
      </motion.div>
    </div>
  );
}

function ListView({ requests, onStatusUpdate, onSelectOrder, actionLoading }) {
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
      className="space-y-4">
      {requests.map(req => (
        <OrderListItem key={req.id} req={req} onClick={() => onSelectOrder(req)}
          onStatusUpdate={onStatusUpdate} isUpdating={actionLoading === req.id} />
      ))}
    </motion.div>
  );
}

function OrderCard({ req, onClick, onDragStart, isUpdating }) {
  const statusCol = COLUMNS.find(c => c.id === req.status) || COLUMNS[0];
  const totalQty = req.items?.reduce((s, i) => s + (i.qty || 0), 0) || 0;
  const orderLabel = req.order_number ? `EG-${req.order_number}` : `#${req.id?.split('-')[0]}`;

  return (
    <div draggable onDragStart={e => onDragStart(e, req.id, req.status)}
      onClick={onClick}
      className="bg-white dark:bg-surface-container border border-gray-200 dark:border-white/10 p-4 rounded-xl cursor-grab active:cursor-grabbing hover:border-primary/50 transition-all flex flex-col gap-3 group relative">
      {isUpdating && (
        <div className="absolute inset-0 bg-black/40 rounded-xl flex items-center justify-center z-10">
          <span className="material-symbols-outlined animate-spin text-primary text-2xl">progress_activity</span>
        </div>
      )}
      <div className="flex justify-between items-start">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-on-surface-variant font-mono bg-gray-100 dark:bg-black/40 px-2 py-1 rounded inline-block w-fit">
              {orderLabel}
            </span>
            {req.idempotency_key && <span className="material-symbols-outlined text-green-500 text-[14px]">verified</span>}
          </div>
          <div className="flex gap-1 mt-1 flex-wrap">
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/40">
              {req.auth_source === 'google' ? 'جوجل' : req.auth_source === 'email' ? 'إيميل' : req.auth_source === 'otp' ? 'واتساب OTP' : 'واتساب'}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${req.payment_method === 'card' ? 'bg-primary/20 text-primary' : 'bg-gray-100 dark:bg-surface-variant text-gray-600 dark:text-on-surface-variant'}`}>
              {req.payment_method === 'card' ? 'فيزا' : 'كاش'}
            </span>
            {req.payment_status === 'paid' && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-500">مدفوع</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[10px] text-gray-400 dark:text-secondary-fixed-dim">
            {new Date(req.created_at).toLocaleDateString('ar-EG')}
          </span>
          <span className="text-xs font-bold text-primary">EGP {req.total?.toLocaleString()}</span>
        </div>
      </div>
      {req.phone && (
        <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-on-surface-variant">
          <span className="material-symbols-outlined text-[14px]">call</span>
          <span className="font-mono" dir="ltr">{req.phone}</span>
          {req.city && <span className="mr-auto">{req.city}</span>}
        </div>
      )}
      <div className="space-y-1">
        {req.items?.slice(0, 2).map((item, i) => (
          <div key={i} className="flex justify-between items-center text-xs">
            <span className="text-gray-900 dark:text-white line-clamp-1 flex-1">{item.title || item.name}</span>
            <span className="text-primary font-bold mr-2">x{item.qty}</span>
          </div>
        ))}
        {req.items?.length > 2 && <p className="text-[10px] text-gray-500 dark:text-on-surface-variant">+{req.items.length - 2} منتجات أخرى (إجمالي {totalQty} قطعة)</p>}
        {req.items?.length <= 2 && totalQty > 0 && <p className="text-[10px] text-gray-500 dark:text-on-surface-variant">إجمالي {totalQty} قطعة</p>}
      </div>
      <div className={`absolute top-2 left-2 w-2 h-2 rounded-full ${statusCol.bg} border ${statusCol.color}`} />
    </div>
  );
}

function OrderListItem({ req, onClick, onStatusUpdate, isUpdating }) {
  const currentStatusObj = COLUMNS.find(c => c.id === req.status) || COLUMNS[0];
  const allowed = TRANSITIONS[req.status] || [];
  const orderLabel = req.order_number ? `EG-${req.order_number}` : `#${req.id?.split('-')[0]}`;
  const totalQty = req.items?.reduce((s, i) => s + (i.qty || 0), 0) || 0;

  return (
    <div onClick={onClick}
      className="glass-panel p-4 rounded-2xl border border-gray-200 dark:border-white/10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors cursor-pointer relative">
      {isUpdating && (
        <div className="absolute inset-0 bg-black/30 rounded-2xl flex items-center justify-center z-10">
          <span className="material-symbols-outlined animate-spin text-primary text-2xl">progress_activity</span>
        </div>
      )}
      <div className="flex items-center gap-4 w-full md:w-auto">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${currentStatusObj.bg} ${currentStatusObj.text} border ${currentStatusObj.color}`}>
          <span className="material-symbols-outlined text-[18px]">{currentStatusObj.icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-gray-900 dark:text-white font-bold text-sm">{orderLabel}</h4>
          <p className="text-gray-500 dark:text-on-surface-variant text-[10px]">{new Date(req.created_at).toLocaleString('ar-EG')}</p>
          <div className="flex gap-2 mt-1 flex-wrap">
            {req.phone && <span className="text-[10px] text-gray-500 dark:text-on-surface-variant font-mono" dir="ltr">📞 {req.phone}</span>}
            {req.city && <span className="text-[10px] text-gray-500 dark:text-on-surface-variant">📍 {req.city}</span>}
          </div>
          {req.items?.length > 0 && (
            <p className="text-[10px] text-gray-500 dark:text-on-surface-variant mt-1">
              {req.items.length} منتج • {totalQty} قطعة
            </p>
          )}
        </div>
        <div className="text-right hidden md:block">
          <p className="text-primary font-black text-sm">EGP {req.total?.toLocaleString()}</p>
          <span className={`text-[10px] font-bold ${currentStatusObj.text}`}>{currentStatusObj.title}</span>
          <div className="flex gap-1 mt-1 justify-end">
            <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${req.payment_method === 'card' ? 'bg-primary/20 text-primary' : 'bg-gray-100 dark:bg-surface-variant text-gray-600 dark:text-on-surface-variant'}`}>
              {req.payment_method === 'card' ? 'فيزا' : 'كاش'}
            </span>
            {req.payment_status === 'paid' && (
              <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-emerald-500/20 text-emerald-500">مدفوع</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-2 w-full md:w-auto overflow-x-auto pb-2 md:pb-0 scrollbar-hide" onClick={e => e.stopPropagation()}>
        {allowed.map(statusId => {
          const target = COLUMNS.find(c => c.id === statusId);
          return (
            <button key={statusId} onClick={() => onStatusUpdate(req.id, req.status, statusId)}
              disabled={isUpdating}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-bold whitespace-nowrap transition-colors border ${target.color} ${target.bg} ${target.text} disabled:opacity-50 disabled:cursor-not-allowed`}>
              نقل إلى {target.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrderDetailModal({ order, onClose, onStatusUpdate, onPaymentStatusUpdate, actionLoading }) {
  const statusCol = COLUMNS.find(c => c.id === order.status) || COLUMNS[0];
  const allowed = TRANSITIONS[order.status] || [];
  const orderLabel = order.order_number ? `EG-${order.order_number}` : `#${order.id?.split('-')[0]}`;
  const totalQty = order.items?.reduce((s, i) => s + (i.qty || 0), 0) || 0;

  // Prefer the customer's saved default address over the order's address.
  // The order address is only used as a fallback (e.g. guest orders or when
  // the customer hasn't set up an address in their account).
  const [savedAddress, setSavedAddress] = useState(null);

  useEffect(() => {
    let active = true;
    if (!order.user_id) {
      setSavedAddress(null);
      return;
    }
    (async () => {
      try {
        // Try the flagged default address first, then fall back to the most recent one
        let { data } = await supabase
          .from('user_addresses')
          .select('title, phone, city, address, is_default')
          .eq('user_id', order.user_id)
          .eq('is_default', true)
          .limit(1);

        if (!data || data.length === 0) {
          ({ data } = await supabase
            .from('user_addresses')
            .select('title, phone, city, address, is_default')
            .eq('user_id', order.user_id)
            .order('created_at', { ascending: false })
            .limit(1));
        }
        if (active) setSavedAddress(data && data[0] ? data[0] : null);
      } catch (err) {
        console.error(err);
        if (active) setSavedAddress(null);
      }
    })();
    return () => { active = false; };
  }, [order.user_id, order.id]);

  // Resolve which address/phone/city to show (saved default → order → none)
  const displayPhone = savedAddress?.phone || order.phone || '';
  const displayCity = savedAddress?.city || order.city || '';
  const displayAddress = savedAddress?.address || order.address || '';
  const usingSavedAddress = Boolean(savedAddress);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="relative bg-surface-container-high dark:bg-surface-container-high border border-gray-200 dark:border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-surface-container-high border-b border-gray-200 dark:border-white/10 p-4 flex justify-between items-center z-10">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${statusCol.bg} ${statusCol.text} border ${statusCol.color}`}>
              <span className="material-symbols-outlined">{statusCol.icon}</span>
            </div>
            <div>
              <h3 className="font-bold text-gray-900 dark:text-white text-lg">{orderLabel}</h3>
              <span className={`text-xs font-bold ${statusCol.text}`}>{statusCol.title}</span>
            </div>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 flex items-center justify-center transition-all text-gray-700 dark:text-white">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Customer Info */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-gray-50 dark:bg-surface-container border border-gray-200 dark:border-white/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="material-symbols-outlined text-primary text-[18px]">person</span>
                <h4 className="font-bold text-gray-900 dark:text-white text-sm">بيانات العميل</h4>
                {usingSavedAddress && (
                  <span className="mr-auto px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[12px]">bookmark</span> العنوان المحفوظ
                  </span>
                )}
              </div>
              <div className="space-y-2 text-sm">
                {displayPhone && (
                  <div className="flex justify-between">
                    <span className="text-gray-500 dark:text-on-surface-variant">التليفون</span>
                    <span className="text-gray-900 dark:text-white font-mono" dir="ltr">{displayPhone}</span>
                  </div>
                )}
                {displayCity && (
                  <div className="flex justify-between">
                    <span className="text-gray-500 dark:text-on-surface-variant">المدينة</span>
                    <span className="text-gray-900 dark:text-white">{displayCity}</span>
                  </div>
                )}
                {displayAddress && (
                  <div className="flex justify-between">
                    <span className="text-gray-500 dark:text-on-surface-variant">العنوان</span>
                    <span className="text-gray-900 dark:text-white text-left max-w-[60%]">{displayAddress}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-on-surface-variant">تسجيل الدخول</span>
                  <span className="text-gray-900 dark:text-white">{order.auth_source === 'google' ? 'جوجل' : order.auth_source === 'email' ? 'إيميل' : order.auth_source === 'otp' ? 'واتساب OTP' : 'واتساب'}</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 dark:bg-surface-container border border-gray-200 dark:border-white/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined text-primary text-[18px]">payments</span>
                <h4 className="font-bold text-gray-900 dark:text-white text-sm">الدفع</h4>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-on-surface-variant">الطريقة</span>
                  <span className="text-gray-900 dark:text-white">{order.payment_method === 'card' ? 'فيزا / كارد' : 'كاش'}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500 dark:text-on-surface-variant">حالة الدفع</span>
                  <select
                    value={order.payment_status || 'unpaid'}
                    onChange={(e) => onPaymentStatusUpdate(order.id, e.target.value)}
                    className={`bg-white dark:bg-surface-container border border-gray-300 dark:border-white/10 rounded-lg px-2 py-1 text-sm font-bold focus:outline-none focus:border-primary ${order.payment_status === 'paid' ? 'text-emerald-600 dark:text-emerald-400' : order.payment_status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}`}
                  >
                    <option value="unpaid">غير مدفوع</option>
                    <option value="paid">مدفوع</option>
                    <option value="failed">فشل</option>
                  </select>
                </div>
                <div className="border-t border-gray-200 dark:border-white/5 my-2" />
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-on-surface-variant">subtotal</span>
                  <span className="text-gray-900 dark:text-white">EGP {order.subtotal?.toLocaleString()}</span>
                </div>
                {order.discount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500 dark:text-on-surface-variant">الخصم</span>
                    <span className="text-emerald-600 dark:text-emerald-400">-EGP {order.discount?.toLocaleString()}</span>
                  </div>
                )}
                {order.shipping_fee > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500 dark:text-on-surface-variant">الشحن</span>
                    <span className="text-gray-900 dark:text-white">EGP {order.shipping_fee?.toLocaleString()}</span>
                  </div>
                )}
                <div className="border-t border-gray-200 dark:border-white/5 my-2" />
                <div className="flex justify-between text-lg">
                  <span className="text-primary font-black">الإجمالي</span>
                  <span className="text-primary font-black">EGP {order.total?.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Order Items */}
          <div className="bg-gray-50 dark:bg-surface-container border border-gray-200 dark:border-white/5 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-primary text-[18px]">shopping_bag</span>
              <h4 className="font-bold text-gray-900 dark:text-white text-sm">المنتجات ({order.items?.length || 0})</h4>
              <span className="text-gray-500 dark:text-on-surface-variant text-xs">| {totalQty} قطعة</span>
            </div>
            <div className="space-y-2">
              {order.items?.map((item, i) => (
                <div key={i} className="flex justify-between items-center bg-white dark:bg-white/5 border border-gray-200 dark:border-transparent rounded-lg px-3 py-2">
                  <div className="flex items-center gap-3">
                    <span className="text-gray-900 dark:text-white text-sm font-bold">{item.title || item.name}</span>
                    {item.size && <span className="text-gray-500 dark:text-on-surface-variant text-[10px]">مقاس: {item.size}</span>}
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-gray-500 dark:text-on-surface-variant text-xs">x{item.qty}</span>
                    {item.price && <span className="text-primary font-bold text-sm">EGP {(item.price * item.qty).toLocaleString()}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Customer Note */}
          {order.customer_note && (
            <div className="bg-gray-50 dark:bg-surface-container border border-gray-200 dark:border-white/5 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined text-primary text-[18px]">notes</span>
                <h4 className="font-bold text-gray-900 dark:text-white text-sm">ملاحظات العميل</h4>
              </div>
              <p className="text-gray-700 dark:text-white/80 text-sm bg-white dark:bg-black/20 border border-gray-200 dark:border-transparent rounded-lg p-3">{order.customer_note}</p>
            </div>
          )}

          {/* Order Meta */}
          <div className="bg-gray-50 dark:bg-surface-container border border-gray-200 dark:border-white/5 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-primary text-[18px]">info</span>
              <h4 className="font-bold text-gray-900 dark:text-white text-sm">معلومات الطلب</h4>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex justify-between bg-white dark:bg-white/5 border border-gray-200 dark:border-transparent rounded-lg px-3 py-2">
                <span className="text-gray-500 dark:text-on-surface-variant">رقم الطلب</span>
                <span className="text-gray-900 dark:text-white font-mono">{orderLabel}</span>
              </div>
              <div className="flex justify-between bg-white dark:bg-white/5 border border-gray-200 dark:border-transparent rounded-lg px-3 py-2">
                <span className="text-gray-500 dark:text-on-surface-variant">التاريخ</span>
                <span className="text-gray-900 dark:text-white">{new Date(order.created_at).toLocaleString('ar-EG')}</span>
              </div>
              {order.idempotency_key && (
                <div className="flex justify-between bg-white dark:bg-white/5 border border-gray-200 dark:border-transparent rounded-lg px-3 py-2">
                  <span className="text-gray-500 dark:text-on-surface-variant">Idempotency</span>
                  <span className="text-emerald-600 dark:text-green-400 font-mono">مؤمن ✓</span>
                </div>
              )}
            </div>
          </div>

          {/* Status Actions */}
          <div className="bg-gray-50 dark:bg-surface-container border border-gray-200 dark:border-white/5 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-primary text-[18px]">swap_horiz</span>
              <h4 className="font-bold text-gray-900 dark:text-white text-sm">تغيير الحالة</h4>
            </div>
            <div className="flex flex-wrap gap-2">
              {allowed.length === 0 ? (
                <p className="text-gray-500 dark:text-on-surface-variant text-sm">لا يمكن تغيير الحالة من هذه المرحلة</p>
              ) : (
                allowed.map(statusId => {
                  const target = COLUMNS.find(c => c.id === statusId);
                  return (
                    <button key={statusId} onClick={() => onStatusUpdate(order.id, order.status, statusId)}
                      disabled={actionLoading === order.id}
                      className={`px-4 py-2 rounded-xl text-sm font-bold transition-all border ${target.color} ${target.bg} ${target.text} hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2`}>
                      <span className="material-symbols-outlined text-[16px]">{target.icon}</span>
                      نقل إلى {target.title}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
