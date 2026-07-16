import { motion, AnimatePresence } from 'framer-motion';

export default function ConfirmModal({ isOpen, onClose, onConfirm, title, message, confirmText = 'تأكيد', cancelText = 'إلغاء', type = 'danger' }) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[500] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          className="bg-surface-container border border-outline rounded-[2.5rem] w-full max-w-md p-8 shadow-2xl relative overflow-hidden text-center"
          dir="rtl"
        >
          {/* Decorative Glow */}
          <div className={`absolute -top-24 -right-24 w-48 h-48 ${type === 'danger' ? 'bg-error/10' : 'bg-primary/10'} rounded-full blur-3xl`}></div>

          <div className={`w-20 h-20 ${type === 'danger' ? 'bg-error/20 text-error' : 'bg-primary/20 text-primary'} rounded-full flex items-center justify-center mx-auto mb-6 relative z-10`}>
            <span className="material-symbols-outlined text-4xl">
              {type === 'danger' ? 'delete_forever' : 'help'}
            </span>
          </div>

          <h2 className="text-2xl font-black text-on-surface mb-3 relative z-10">{title}</h2>
          <p className="text-on-surface-variant font-medium mb-10 relative z-10 leading-relaxed">
            {message}
          </p>

          <div className="flex gap-4 relative z-10">
            <button
              onClick={onConfirm}
              className={`flex-1 ${type === 'danger' ? 'bg-error hover:bg-red-600' : 'bg-primary hover:bg-primary-fixed'} text-white font-black py-4 rounded-2xl transition-all shadow-lg active:scale-95`}
            >
              {confirmText}
            </button>
            <button
              onClick={onClose}
              className="flex-1 bg-surface-container-high hover:bg-surface-container-highest text-on-surface font-black py-4 rounded-2xl border border-outline transition-all active:scale-95"
            >
              {cancelText}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
