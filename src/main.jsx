import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// إصلاح عالمي لمشكلة ترجمة جوجل مع الأيقونات (يمنع ترجمة أسماء الأيقونات إلى نصوص عربية)
const observer = new MutationObserver(() => {
  const icons = document.querySelectorAll('.material-symbols-outlined:not(.notranslate)');
  icons.forEach(icon => {
    icon.classList.add('notranslate');
    icon.setAttribute('translate', 'no');
  });
});
observer.observe(document.body, { childList: true, subtree: true });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
