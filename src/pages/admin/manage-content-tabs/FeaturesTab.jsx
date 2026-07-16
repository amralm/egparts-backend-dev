export default function FeaturesTab({ content, updateFeature, inputClass, labelClass, sectionClass }) {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className={sectionClass}>
        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary">star</span>
          مميزات المتجر
        </h2>
        <div className="space-y-6">
          {content.features.map((f, i) => (
            <div key={i} className="bg-black/20 rounded-2xl p-6 border border-white/5">
              <h3 className="text-white font-bold mb-4">الميزة {i + 1}</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className={labelClass}>أيقونة</label>
                  <input className={inputClass} value={f.icon} onChange={e => updateFeature(i, 'icon', e.target.value)} />
                </div>
                <div>
                  <label className={labelClass}>العنوان</label>
                  <input className={inputClass} value={f.title} onChange={e => updateFeature(i, 'title', e.target.value)} />
                </div>
                <div className="md:col-span-3">
                  <label className={labelClass}>الوصف</label>
                  <textarea className={inputClass + ' h-16 resize-none'} value={f.desc} onChange={e => updateFeature(i, 'desc', e.target.value)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
