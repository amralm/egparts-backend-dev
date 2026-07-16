export default function HeroTab({ content, update, inputClass, labelClass, sectionClass }) {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className={sectionClass}>
        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary">palette</span>
          القسم العلوي (Hero)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>النص الأول للعنوان</label>
            <input className={inputClass} value={content.hero.title1} onChange={e => update('hero.title1', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>النص الثاني للعنوان</label>
            <input className={inputClass} value={content.hero.title2} onChange={e => update('hero.title2', e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>النص الفرعي</label>
            <textarea className={inputClass + ' h-20 resize-none'} value={content.hero.subtitle} onChange={e => update('hero.subtitle', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>زر "تسوق الآن"</label>
            <input className={inputClass} value={content.hero.cta} onChange={e => update('hero.cta', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>زر "انضم لمجتمعنا"</label>
            <input className={inputClass} value={content.hero.community} onChange={e => update('hero.community', e.target.value)} />
          </div>
        </div>
      </div>
    </div>
  );
}
