import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Link } from 'react-router-dom';
import { useStore } from '../../context/StoreContext';

export default function Dashboard() {
  const { store } = useStore();
  const [stats, setStats] = useState({
    products: 0,
    lowStock: 0,
    outOfStock: 0,
    orders: 0,
    totalValue: 0,
    revenue: 0,
    users: 0
  });
  const [loading, setLoading] = useState(true);
  const [recentOrders, setRecentOrders] = useState([]);
  const [topProducts, setTopProducts] = useState([]);
  const [lowStockItems, setLowStockItems] = useState([]);

  const getStatusText = (status) => {
    switch(status) {
      case 'pending': return 'قيد المراجعة';
      case 'processing': return 'جاري التجهيز';
      case 'shipped': return 'تم الشحن';
      case 'delivered': return 'تم التوصيل';
      case 'cancelled': return 'ملغي';
      default: return status || 'غير معروف';
    }
  };

  useEffect(() => {
    if (store?.id) {
      fetchDashboardData();
    }
  }, [store?.id]);

  async function fetchDashboardData() {
    if (!store?.id) return;
    try {
      setLoading(true);

      // Fetch Products (only necessary fields to reduce payload)
      const { data: productsData } = await supabase
        .from('products')
        .select('id, name, image, price, stock_quantity, low_stock_threshold')
        .eq('store_id', store.id);

      // Fetch Orders (only recent or needed fields).
      const { data: ordersData } = await supabase
        .from('orders')
        .select('id, total, status, items, user_id, created_at, phone')
        .eq('store_id', store.id)
        .order('created_at', { ascending: false })
        .limit(1000);

      // Fetch real user count from profiles (not just users who placed orders)
      let userCount = 0;
      const { count: profilesCount } = await supabase
        .from('user_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('store_id', store.id);
      if (profilesCount !== null) {
        userCount = profilesCount;
      } else {
        userCount = new Set(ordersData?.map(o => o.user_id).filter(Boolean)).size;
      }

      if (productsData) {
        let low = 0;
        let out = 0;
        let val = 0;
        const lowItems = [];

        productsData.forEach(p => {
          const stock = p.stock_quantity || 0;
          const threshold = p.low_stock_threshold || 5;
          if (stock <= 0) out++;
          else if (stock <= threshold) {
            low++;
            lowItems.push(p);
          }

          const priceNum = parseFloat(p.price?.toString().replace(/,/g, '') || 0);
          if (!isNaN(priceNum) && stock > 0) val += priceNum * stock;
        });

        setLowStockItems(lowItems.slice(0, 5));

        // Calculate Revenue and Top Products
        const revenue = ordersData?.reduce((acc, order) => {
          if (order.status === 'delivered') {
            const totalNum = parseFloat(order.total?.toString().replace(/,/g, '') || 0);
            return acc + (isNaN(totalNum) ? 0 : totalNum);
          }
          return acc;
        }, 0) || 0;

        // ── Top Products: use order_items table (reliable UUID columns, not JSONB parsing)
        const validOrderIds = new Set(
          ordersData
            ?.filter(o => o.status !== 'cancelled' && o.status !== 'rejected')
            .map(o => o.id) || []
        );

        let orderItemsData = [];
        const orderIds = ordersData?.map(o => o.id) || [];
        if (orderIds.length > 0) {
          const { data } = await supabase
            .from('order_items')
            .select('order_id, product_id, quantity')
            .in('order_id', orderIds);
          orderItemsData = data || [];
        }

        const productSales = {};
        orderItemsData.forEach(item => {
          if (validOrderIds.has(item.order_id)) {
            productSales[item.product_id] = (productSales[item.product_id] || 0) + (item.quantity || 1);
          }
        });

        const sortedTop = Object.entries(productSales)
          .map(([id, qty]) => {
            const p = productsData.find(prod => prod.id.toString() === id.toString());
            return { id, qty, name: p?.name || 'منتج غير معروف', image: p?.image };
          })
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 5);

        setTopProducts(sortedTop);

        setStats({
          products: productsData.length,
          lowStock: low,
          outOfStock: out,
          orders: ordersData?.length || 0,
          totalValue: val,
          revenue: revenue,
          users: userCount
        });
      }

      if (ordersData) {
        // Enrich orders with user data (orders table has no name column)
        const enrichedOrders = await Promise.all(ordersData.slice(0, 8).map(async (order) => {
          if (order.user_id) {
            const { data: profile } = await supabase
              .from('user_profiles')
              .select('full_name, phone')
              .eq('user_id', order.user_id)
              .eq('store_id', store.id)
              .maybeSingle();

            return {
              ...order,
              phone: order.phone || profile?.phone || 'بدون رقم',
              full_name: profile?.full_name || 'عميل مجهول'
            };
          }
          return {
            ...order,
            phone: order.phone || 'بدون رقم',
            full_name: 'عميل (زائر)'
          };
        }));
        setRecentOrders(enrichedOrders);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[500px]">
        <span className="material-symbols-outlined animate-spin text-[60px] text-primary">progress_activity</span>
      </div>
    );
  }

  return (
    <div className="space-y-8" dir="rtl">
      <div>
        <h2 className="font-headline-lg text-headline-lg text-gray-900 dark:text-white">نظرة عامة (لوحة القيادة)</h2>
        <p className="text-gray-600 dark:text-gray-400 mt-1">إحصائيات متجرك لحظة بلحظة من قاعدة البيانات.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="glass-panel p-6 rounded-xl border border-white/10 hover:border-primary/50 transition-all shadow-lg relative overflow-hidden group">
          <div className="absolute -left-6 -top-6 w-24 h-24 bg-primary/20 rounded-full blur-2xl group-hover:bg-primary/30 transition-all"></div>
          <div className="flex items-center justify-between mb-4">
            <div className="bg-primary/20 p-3 rounded-lg text-primary">
              <span className="material-symbols-outlined text-[28px]">inventory_2</span>
            </div>
            <span className="text-3xl font-black text-gray-900 dark:text-white">{stats.products}</span>
          </div>
          <p className="font-bold text-on-surface-variant text-[10px] uppercase tracking-wider">إجمالي المنتجات</p>
        </div>

        <div className="glass-panel p-6 rounded-xl border border-white/10 hover:border-yellow-500/50 transition-all shadow-lg relative overflow-hidden group">
          <div className="absolute -left-6 -top-6 w-24 h-24 bg-yellow-500/20 rounded-full blur-2xl group-hover:bg-yellow-500/30 transition-all"></div>
          <div className="flex items-center justify-between mb-4">
            <div className="bg-yellow-500/20 p-3 rounded-lg text-yellow-500">
              <span className="material-symbols-outlined text-[28px]">warning</span>
            </div>
            <span className="text-3xl font-black text-gray-900 dark:text-white">{stats.lowStock}</span>
          </div>
          <p className="font-bold text-on-surface-variant text-[10px] uppercase tracking-wider">نواقص (أقل من 5)</p>
        </div>

        <div className="glass-panel p-6 rounded-xl border border-white/10 hover:border-error/50 transition-all shadow-lg relative overflow-hidden group">
          <div className="absolute -left-6 -top-6 w-24 h-24 bg-error/20 rounded-full blur-2xl group-hover:bg-error/30 transition-all"></div>
          <div className="flex items-center justify-between mb-4">
            <div className="bg-error/20 p-3 rounded-lg text-error">
              <span className="material-symbols-outlined text-[28px]">block</span>
            </div>
            <span className="text-3xl font-black text-gray-900 dark:text-white">{stats.outOfStock}</span>
          </div>
          <p className="font-bold text-on-surface-variant text-[10px] uppercase tracking-wider">نفذت تماماً</p>
        </div>

        <div className="glass-panel p-6 rounded-xl border border-white/10 hover:border-blue-500/50 transition-all shadow-lg relative overflow-hidden group">
          <div className="absolute -left-6 -top-6 w-24 h-24 bg-blue-500/20 rounded-full blur-2xl group-hover:bg-blue-500/30 transition-all"></div>
          <div className="flex items-center justify-between mb-4">
            <div className="bg-blue-500/20 p-3 rounded-lg text-blue-400">
              <span className="material-symbols-outlined text-[28px]">group</span>
            </div>
            <span className="text-3xl font-black text-gray-900 dark:text-white">{stats.users}</span>
          </div>
          <p className="font-bold text-on-surface-variant text-[10px] uppercase tracking-wider">إجمالي العملاء</p>
        </div>

        <div className="glass-panel p-6 rounded-xl border border-white/10 hover:border-[#25D366]/50 transition-all shadow-lg relative overflow-hidden group">
          <div className="absolute -left-6 -top-6 w-24 h-24 bg-[#25D366]/20 rounded-full blur-2xl group-hover:bg-[#25D366]/30 transition-all"></div>
          <div className="flex items-center justify-between mb-4">
            <div className="bg-[#25D366]/20 p-3 rounded-lg text-[#25D366]">
              <span className="material-symbols-outlined text-[28px]">payments</span>
            </div>
            <span className="text-xl font-black text-gray-900 dark:text-white" dir="ltr">{stats.revenue?.toLocaleString()} ج</span>
          </div>
          <p className="font-bold text-on-surface-variant text-[10px] uppercase tracking-wider">صافي المبيعات</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Quick Actions */}
        <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-white/10">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">bolt</span>
            إجراءات سريعة
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <Link to="/admin/products" className="bg-gray-50 dark:bg-surface-container hover:bg-gray-100 dark:hover:bg-white/5 border border-gray-200 dark:border-white/5 p-4 rounded-xl flex flex-col items-center gap-3 transition-colors text-center">
              <span className="material-symbols-outlined text-[32px] text-blue-500">add_box</span>
              <span className="font-bold text-sm text-gray-900 dark:text-white">إضافة منتج جديد</span>
            </Link>
            <Link to="/admin/wa-requests" className="bg-gray-50 dark:bg-surface-container hover:bg-gray-100 dark:hover:bg-white/5 border border-gray-200 dark:border-white/5 p-4 rounded-xl flex flex-col items-center gap-3 transition-colors text-center">
              <span className="material-symbols-outlined text-[32px] text-green-500">mark_chat_unread</span>
              <span className="font-bold text-sm text-gray-900 dark:text-white">مراجعة الطلبات</span>
            </Link>
            <Link to="/catalog" target="_blank" className="bg-gray-50 dark:bg-surface-container hover:bg-gray-100 dark:hover:bg-white/5 border border-gray-200 dark:border-white/5 p-4 rounded-xl flex flex-col items-center gap-3 transition-colors text-center">
              <span className="material-symbols-outlined text-[32px] text-purple-500">storefront</span>
              <span className="font-bold text-sm text-gray-900 dark:text-white">زيارة المتجر</span>
            </Link>
            <Link to="/admin/settings" className="bg-gray-50 dark:bg-surface-container hover:bg-gray-100 dark:hover:bg-white/5 border border-gray-200 dark:border-white/5 p-4 rounded-xl flex flex-col items-center gap-3 transition-colors text-center">
              <span className="material-symbols-outlined text-[32px] text-yellow-500">settings</span>
              <span className="font-bold text-sm text-gray-900 dark:text-white">إعدادات المتجر</span>
            </Link>
          </div>
        </div>

        {/* Recent Orders Overview */}
        <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-white/10">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">history</span>
            أحدث الطلبات
          </h3>
          {recentOrders.length > 0 ? (
            <div className="space-y-4">
              {recentOrders.map(order => (
                <div key={order.id} className="flex items-center justify-between p-5 bg-gray-50 dark:bg-white/[0.03] hover:bg-gray-100 dark:hover:bg-white/[0.06] rounded-2xl border border-gray-200 dark:border-white/5 transition-all">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center">
                      <span className="material-symbols-outlined">person</span>
                    </div>
                    <div>
                      <p className="font-black text-gray-900 dark:text-white">{order.full_name}</p>
                      <p className="text-primary text-xs font-mono" dir="ltr">{order.phone}</p>
                      <p className="text-[10px] text-gray-600 dark:text-gray-400 mt-1 font-bold">
                        {new Date(order.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' })} في {new Date(order.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                  <div className="text-left">
                    <p className="text-gray-900 dark:text-white font-black mb-2 text-sm">{order.total} ج</p>
                    <span className={`px-3 py-1 rounded-full text-[10px] font-black ${order.status === 'delivered' ? 'bg-green-500/20 text-green-500' :
                        order.status === 'cancelled' ? 'bg-error/20 text-error' :
                          'bg-yellow-500/20 text-yellow-500'
                      }`}>
                      {getStatusText(order.status)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-[200px] text-gray-600 dark:text-gray-400">
              <span className="material-symbols-outlined text-[48px] opacity-30 mb-4">inbox</span>
              <p>لا توجد طلبات حديثة حتى الآن.</p>
            </div>
          )}
        </div>
      </div>
      {/* Analytics Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Top Selling Products */}
        <div className="glass-panel p-6 rounded-xl border border-outline bg-surface-container-low">
          <h3 className="text-xl font-bold text-on-surface mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">trending_up</span>
            الأكثر مبيعاً
          </h3>
          <div className="space-y-4">
            {topProducts.map((p, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 bg-surface border border-outline/50 rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg bg-surface-container flex items-center justify-center overflow-hidden">
                    {p.image ? (
                      <img src={p.image} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="material-symbols-outlined text-on-surface-variant opacity-50">image</span>
                    )}
                  </div>
                  <div>
                    <p className="font-bold text-on-surface text-sm line-clamp-1">{p.name}</p>
                    <p className="text-[10px] text-on-surface-variant">إجمالي المبيعات: {p.qty} قطعة</p>
                  </div>
                </div>
                <div className="text-right">
                   <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-xs ${idx === 0 ? 'bg-yellow-500 text-black shadow-lg shadow-yellow-500/20' : 'bg-surface-container-high text-on-surface'}`}>
                    #{idx + 1}
                   </div>
                </div>
              </div>
            ))}
            {topProducts.length === 0 && <p className="text-center py-10 text-on-surface-variant">لا توجد بيانات مبيعات بعد.</p>}
          </div>
        </div>

        {/* Low Stock Alerts */}
        <div className="glass-panel p-6 rounded-xl border border-error/20 bg-error-container backdrop-blur-md">
          <h3 className="text-xl font-bold text-on-error-container mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-error">notification_important</span>
            تنبيهات المخزون
          </h3>
          <div className="space-y-4">
            {lowStockItems.map((p, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 bg-error/10 rounded-xl border border-error/20">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-error">priority_high</span>
                  <div>
                    <p className="font-bold text-on-error-container text-sm line-clamp-1">{p.name}</p>
                    <p className="text-[10px] text-error font-black">المتبقي: {p.stock_quantity} قطعة فقط!</p>
                  </div>
                </div>
                <Link to="/admin/products" className="px-4 py-1.5 bg-surface border border-outline hover:bg-surface-container-highest rounded-lg text-[10px] font-black text-on-surface transition-all">
                  تحديث
                </Link>
              </div>
            ))}
            {lowStockItems.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10">
                <span className="material-symbols-outlined text-green-500 text-4xl mb-2">check_circle</span>
                <p className="text-gray-600 dark:text-on-surface-variant text-sm">المخزون ممتاز في جميع الأصناف.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
