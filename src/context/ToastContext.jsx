import React, { createContext, useContext, useState, useEffect } from 'react';
import Toast from '../components/Toast';

const ToastContext = createContext();

export const ToastProvider = ({ children }) => {
  const [toast, setToast] = useState({ show: false, type: 'info', message: '' });

  const showToast = (type, message) => {
    setToast({ show: true, type, message });
  };

  useEffect(() => {
    let timer;
    if (toast.show) {
      timer = setTimeout(() => setToast(prev => ({ ...prev, show: false })), 4000);
    }
    return () => clearTimeout(timer);
  }, [toast.show]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast.show && <Toast type={toast.type} message={toast.message} />}
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
