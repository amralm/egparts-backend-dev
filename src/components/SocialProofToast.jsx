import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../context/StoreContext';

const DEMO_BUYERS = [
  { name: 'م. محمد', city: 'القاهرة' },
  { name: 'أحمد علي', city: 'الجيزة' },
  { name: 'مصطفى كامل', city: 'الإسكندرية' },
  { name: 'كريم حسن', city: 'طنطا' },
  { name: 'محمود السيد', city: 'المنصورة' },
  { name: 'إبراهيم خليل', city: 'أسيوط' },
  { name: 'عبدالله عمر', city: 'الشرقية' },
  { name: 'حسن يوسف', city: 'الدقهلية' },
  { name: 'علي محمود', city: 'القليوبية' },
  { name: 'سامي عبدالسلام', city: 'الغربية' },
  { name: 'خالد رشاد', city: 'البحيرة' },
  { name: 'م. هاني', city: 'بورسعيد' }
];

const ITEMS_PREVIEW = [
  { name: 'طقم مكابح أمامي', id: null },
  { name: 'فلتر زيت أصلي', id: null },
  { name: 'بوجيهات إشعال', id: null },
  { name: 'زيت محرك 20W50', id: null },
  { name: 'سير كاتينة', id: null },
  { name: 'طقم كلتش كامل', id: null },
  { name: 'ماسورة عادم ريوس', id: null },
  { name: 'مساعدين أمامي', id: null },
  { name: 'دينمو كرسي', id: null },
  { name: 'راديتر ألومنيوم', id: null },
  { name: 'فلتر هواء سبورت', id: null },
  { name: 'بوابة كهرباء', id: null }
];

const TOAST_DURATION = 6000;
const INTERVAL_MS = 25000;

function timeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (diff < 1) return 'لحظات';
  if (diff < 60) return `${diff} دقيقة`;
  const hrs = Math.floor(diff / 60);
  if (hrs < 24) return `${hrs} ساعة`;
  return `${Math.floor(hrs / 24)} يوم`;
}

function randomTimeAgo() {
  const mins = Math.floor(Math.random() * 55) + 3;
  return `${mins} دقيقة`;
}

export default function SocialProofToast() {
  const { store } = useStore();
  const [toasts, setToasts] = useState([]);
  const [active, setActive] = useState(false);
  const [settings, setSettings] = useState(null);
  const [products, setProducts] = useState([]);
  const queueRef = useRef([]);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!store?.id) return;
    let mounted = true;
    async function init() {
      const { data: set } = await supabase.from('site_settings').select('*').eq('store_id', store.id).single();
      if (!mounted) return;
      if (set && set.social_proof_active === false) { setActive(false); return; }
      setActive(true);
      setSettings(set || { social_proof_active: true, social_proof_demo: true });

      let allProducts = [];
      const { data: activeProds } = await supabase.from('products').select('id, name, image').eq('store_id', store.id).eq('is_active', true).neq('is_deleted', true).limit(100);
      const activeProdMap = new Map(activeProds?.map(p => [p.id, p]) || []);

      if (set && set.social_proof_demo === false) {
        const { data: recentOrders } = await supabase.from('orders').select('items, created_at').eq('store_id', store.id).order('created_at', { ascending: false }).limit(15);
        if (recentOrders && recentOrders.length > 0) {
          recentOrders.forEach(order => {
            if (order.items && Array.isArray(order.items)) {
              order.items.forEach(item => {
                if (activeProdMap.has(item.id)) {
                  allProducts.push({ id: item.id, name: item.title || item.name, image: item.image, time: order.created_at });
                }
              });
            }
          });
        }
      }

      if (allProducts.length === 0) {
        if (set && set.social_proof_demo === false) {
          // Demo is disabled, do nothing (do not populate ITEMS_PREVIEW)
        } else {
          if (activeProds && activeProds.length > 0) {
            allProducts = activeProds.map(p => ({ id: p.id, name: p.name, image: p.image, time: null }));
          }
          if (allProducts.length === 0) {
            ITEMS_PREVIEW.forEach((item, i) => {
              allProducts.push({ ...item, id: `demo-${i}`, time: null });
            });
          }
        }
      }
      if (mounted) setProducts(allProducts);
    }
    init();
    return () => { mounted = false; };
  }, [store?.id]);

  const pickRandom = useCallback((arr) => arr[Math.floor(Math.random() * arr.length)], []);

  const generateToast = useCallback(() => {
    if (products.length === 0) return;
    const product = pickRandom(products);
    const isDemo = settings?.social_proof_demo !== false;
    const buyer = isDemo ? pickRandom(DEMO_BUYERS) : { name: pickRandom(DEMO_BUYERS).name, city: null };
    const tAgo = !isDemo && product.time ? timeAgo(product.time) : randomTimeAgo();
    return {
      id: Date.now() + Math.random(),
      name: buyer.name,
      city: buyer.city,
      productName: product.name,
      productId: product.id,
      image: product.image,
      timeAgo: tAgo
    };
  }, [products, settings, pickRandom]);

  useEffect(() => {
    if (!active || products.length === 0) return;

    const showNext = () => {
      const toast = generateToast();
      if (!toast) return;
      setToasts(prev => [...prev, toast]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toast.id));
      }, TOAST_DURATION);
    };

    const initialTimer = setTimeout(showNext, 3000);
    intervalRef.current = setInterval(showNext, INTERVAL_MS);

    return () => {
      clearTimeout(initialTimer);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [active, products, generateToast]);

  if (!active || toasts.length === 0) return null;

  return (
    <div className="fixed bottom-28 md:bottom-20 left-4 md:left-8 z-[90] flex flex-col gap-3 max-w-sm w-[calc(100%-2rem)] md:w-80 pointer-events-none" dir="rtl">
      <AnimatePresence>
        {toasts.map((toast, idx) => (
          <ToastCard key={toast.id} toast={toast} index={idx} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ toast, index }) {
  const [imgError, setImgError] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, x: 80, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.9 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300, delay: index * 0.1 }}
      className="pointer-events-auto"
    >
      <Link to={`/product/${toast.productId}`}
        className="group relative block bg-surface-container-high/90 backdrop-blur-xl border border-on-surface/10 rounded-2xl p-3 shadow-[0_8px_32px_rgba(0,0,0,0.4)] hover:border-primary/40 transition-all duration-300 overflow-hidden">
        {/* Glow line */}
        <div className="absolute right-0 top-0 w-1 h-full bg-gradient-to-b from-primary/60 via-primary/20 to-transparent rounded-r-full" />

        <div className="flex items-center gap-3">
          <div className="w-14 h-14 bg-surface-container rounded-xl flex-shrink-0 flex items-center justify-center overflow-hidden shadow-inner border border-on-surface/5">
            {toast.image && !imgError ? (
              <img src={toast.image} alt={toast.productName} className="w-full h-full object-cover"
                onError={() => setImgError(true)} />
            ) : (
              <span className="material-symbols-outlined text-primary/40 text-2xl">inventory_2</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="material-symbols-outlined text-[12px] text-emerald-400">shopping_cart_checkout</span>
              <span className="text-[11px] font-black text-on-surface truncate">{toast.name}</span>
              {toast.city && (
                <span className="text-[9px] text-on-surface-variant/60 truncate">من {toast.city}</span>
              )}
            </div>
            <p className="text-[13px] font-bold text-on-surface leading-tight line-clamp-1">
              اشترى <span className="text-primary">{toast.productName}</span>
            </p>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="material-symbols-outlined text-[10px] text-on-surface-variant/40">schedule</span>
              <span className="text-[9px] text-on-surface-variant/50">منذ {toast.timeAgo}</span>
              <span className="material-symbols-outlined text-[10px] text-on-surface-variant/20 mr-auto group-hover:text-primary/40 transition-colors">chevron_left</span>
            </div>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
