import React, { useEffect } from 'react';

export default function Toast({ type = 'info', message, onClose }) {
  // Auto close after 4 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose?.();
    }, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bg = {
    success: 'bg-green-500',
    error: 'bg-red-600',
    info: 'bg-blue-500',
    warning: 'bg-yellow-600',
  }[type];

  const icon = {
    success: 'check_circle',
    error: 'error',
    info: 'info',
    warning: 'warning',
  }[type];

  return (
    <div className={`fixed top-24 left-1/2 -translate-x-1/2 z-[300] ${bg} text-white px-6 py-3 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex items-center gap-3 transition-opacity duration-300`}> 
      <span className="material-symbols-outlined">{icon}</span>
      <span className="font-bold">{message}</span>
    </div>
  );
}
