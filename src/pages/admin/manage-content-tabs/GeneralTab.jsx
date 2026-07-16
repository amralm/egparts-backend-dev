export default function GeneralTab({ content, update, inputClass, labelClass, sectionClass }) {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Site Name */}
      <div className={sectionClass}>
        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary">badge</span>
          اسم الموقع
        </h2>
        <div>
          <label className={labelClass}>اسم الموقع</label>
          <input className={inputClass} value={content.site_name} onChange={e => update('site_name', e.target.value)} />
        </div>
      </div>

      {/* SEO */}
      <div className={sectionClass}>
        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary">travel_explore</span>
          تحسين محركات البحث (SEO)
        </h2>
        <div className="space-y-4">
          <div>
            <label className={labelClass}>عنوان الصفحة الرئيسية</label>
            <input className={inputClass} value={content.seo.title} onChange={e => update('seo.title', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>وصف الصفحة الرئيسية</label>
            <textarea className={inputClass + ' h-24 resize-none'} value={content.seo.description} onChange={e => update('seo.description', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Sections Headings */}
      <div className={sectionClass}>
        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary">format_heading</span>
          عناوين الأقسام المتغيرة
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
            <h3 className="text-white font-bold mb-4">قسم "وصل حديثاً"</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>العنوان</label>
                <input className={inputClass} value={content.sections.latest.heading} onChange={e => update('sections.latest.heading', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>النص الفرعي</label>
                <input className={inputClass} value={content.sections.latest.subtitle} onChange={e => update('sections.latest.subtitle', e.target.value)} />
              </div>
            </div>
          </div>
          <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
            <h3 className="text-white font-bold mb-4">قسم "الأكثر مبيعاً"</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>العنوان</label>
                <input className={inputClass} value={content.sections.trending.heading} onChange={e => update('sections.trending.heading', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>النص الفرعي</label>
                <input className={inputClass} value={content.sections.trending.subtitle} onChange={e => update('sections.trending.subtitle', e.target.value)} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Product Card Labels */}
      <div className={sectionClass}>
        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary">shopping_cart</span>
          نصوص بطاقات المنتجات
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(content.product_card).map(([key, val]) => (
            <div key={key}>
              <label className={labelClass}>{key}</label>
              <input className={inputClass} value={val} onChange={e => update('product_card.' + key, e.target.value)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
