import { getMediaUrl } from '../../../utils/uploadHelper';

export default function CategoriesTab({ 
  content, 
  update, 
  updateCategory, 
  moveCategory, 
  addCategory, 
  removeCategory, 
  handleCategoryFileUpload, 
  uploadingCategoryIdx, 
  availableCategories, 
  inputClass, 
  labelClass, 
  sectionClass 
}) {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className={sectionClass}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-black text-white flex items-center gap-3">
            <span className="material-symbols-outlined text-primary">category</span>
            الأقسام (نظام القوالب الذكي)
          </h2>
          <button onClick={addCategory} className="px-4 py-2 bg-primary/20 text-primary hover:bg-primary hover:text-white rounded-lg font-bold transition-all text-sm flex items-center gap-1">
            <span className="material-symbols-outlined text-[18px]">add</span> إضافة قسم
          </button>
        </div>
        <div className="space-y-4 mb-6 bg-black/20 p-6 rounded-2xl border border-white/5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>عنوان قسم الأقسام</label>
              <input className={inputClass} value={content.categories.heading} onChange={e => update('categories.heading', e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>النص الفرعي</label>
              <input className={inputClass} value={content.categories.subtitle} onChange={e => update('categories.subtitle', e.target.value)} />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {content.categories.items.map((c, i) => (
            <div key={c.id} className={`bg-black/20 rounded-2xl p-6 border transition-all ${c.is_visible ? 'border-white/10' : 'border-error/30 opacity-75'}`}>
              <div className="flex justify-between items-center mb-4 pb-4 border-b border-white/5">
                <div className="flex items-center gap-4">
                  <h3 className="text-white font-bold">القسم {i + 1}</h3>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={c.is_visible} onChange={e => updateCategory(i, 'is_visible', e.target.checked)} className="w-4 h-4 accent-primary" />
                    <span className="text-xs text-on-surface-variant font-bold">مرئي للعملاء</span>
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => moveCategory(i, 'up')} disabled={i === 0} className="w-8 h-8 flex items-center justify-center rounded bg-white/5 hover:bg-white/10 disabled:opacity-30">
                    <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
                  </button>
                  <button onClick={() => moveCategory(i, 'down')} disabled={i === content.categories.items.length - 1} className="w-8 h-8 flex items-center justify-center rounded bg-white/5 hover:bg-white/10 disabled:opacity-30">
                    <span className="material-symbols-outlined text-[18px]">arrow_downward</span>
                  </button>
                  <div className="w-px h-6 bg-white/10 mx-2"></div>
                  <button onClick={() => removeCategory(i)} className="w-8 h-8 flex items-center justify-center rounded bg-error/10 text-error hover:bg-error hover:text-white transition-all">
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Image Section */}
                <div className="lg:col-span-4 flex flex-col gap-3">
                  <label className={labelClass}>صورة القسم (الحد الأقصى 2MB)</label>
                  <div className="relative group border-2 border-dashed border-white/10 rounded-xl p-4 flex flex-col items-center justify-center gap-2 h-[140px] overflow-hidden hover:border-primary/50 transition-all">
                    {c.image ? (
                      <img src={getMediaUrl(c.image)} alt={c.name} className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-40 transition-all" />
                    ) : null}
                    <input type="file" accept="image/*" onChange={(e) => handleCategoryFileUpload(e, i)} className="absolute inset-0 opacity-0 cursor-pointer z-20" />
                    <div className="relative z-10 flex flex-col items-center pointer-events-none bg-black/40 p-2 rounded-lg backdrop-blur-sm">
                      {uploadingCategoryIdx === i ? (
                        <span className="material-symbols-outlined animate-spin text-primary">progress_activity</span>
                      ) : (
                        <>
                          <span className="material-symbols-outlined text-white">cloud_upload</span>
                          <span className="text-[10px] text-white font-bold mt-1">تغيير الصورة</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Info Section */}
                <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>اسم القسم (العنوان)</label>
                    <input className={inputClass} value={c.name} onChange={e => updateCategory(i, 'name', e.target.value)} />
                  </div>
                  <div>
                    <label className={labelClass}>الوصف (العنوان الفرعي)</label>
                    <input className={inputClass} value={c.desc} onChange={e => updateCategory(i, 'desc', e.target.value)} />
                  </div>
                  <div>
                    <label className={labelClass}>أيقونة (Material Symbols)</label>
                    <input className={inputClass} value={c.icon} onChange={e => updateCategory(i, 'icon', e.target.value)} placeholder="ex: kitchen" />
                  </div>
                  <div>
                    <label className={labelClass}>الربط بفئة المنتجات</label>
                    <select className={inputClass} value={c.category_link} onChange={e => updateCategory(i, 'category_link', e.target.value)}>
                      <option value="">بدون ربط (لن يعمل الفلتر)</option>
                      {availableCategories.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className={labelClass}>قالب العرض (Template Layout)</label>
                    <div className="flex gap-4">
                      <label className={`flex-1 p-3 rounded-xl border cursor-pointer transition-all ${c.template === 'templateA' ? 'border-primary bg-primary/10' : 'border-white/10 bg-black/40 hover:border-white/30'}`}>
                        <input type="radio" name={`template-${i}`} value="templateA" checked={c.template === 'templateA'} onChange={() => updateCategory(i, 'template', 'templateA')} className="hidden" />
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-full h-12 bg-white/10 rounded"></div>
                          <span className="text-xs font-bold text-white">Template A (مربع كبير)</span>
                        </div>
                      </label>
                      <label className={`flex-1 p-3 rounded-xl border cursor-pointer transition-all ${c.template === 'templateB' ? 'border-primary bg-primary/10' : 'border-white/10 bg-black/40 hover:border-white/30'}`}>
                        <input type="radio" name={`template-${i}`} value="templateB" checked={c.template === 'templateB'} onChange={() => updateCategory(i, 'template', 'templateB')} className="hidden" />
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-12 h-12 bg-white/10 rounded"></div>
                          <span className="text-xs font-bold text-white">Template B (مربع عادي)</span>
                        </div>
                      </label>
                      <label className={`flex-1 p-3 rounded-xl border cursor-pointer transition-all ${c.template === 'templateC' ? 'border-primary bg-primary/10' : 'border-white/10 bg-black/40 hover:border-white/30'}`}>
                        <input type="radio" name={`template-${i}`} value="templateC" checked={c.template === 'templateC'} onChange={() => updateCategory(i, 'template', 'templateC')} className="hidden" />
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-full h-8 bg-white/10 rounded mt-4"></div>
                          <span className="text-xs font-bold text-white">Template C (مستطيل عريض)</span>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
