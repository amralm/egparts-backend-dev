import { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

import { useStore } from './StoreContext';

const SettingsContext = createContext();

export function SettingsProvider({ children }) {
  const { store } = useStore();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshSettings = async () => {
    if (!store?.id) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.from('site_settings').select('*').eq('store_id', store.id).single();
      if (error) throw error;
      setSettings(data);
      applyThemeSettings(data);
      updateSEOTags(data);
    } catch (err) {
      console.error('Error fetching settings:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshSettings();
  }, [store?.id]);

  const applyThemeSettings = (data) => {
    // Don't apply store theme colors on admin pages — admin has its own CSS variables
    if (window.location.pathname.startsWith('/admin')) return;
    
    if (!data?.theme_colors) return;
    const colors = data.theme_colors;
    const root = document.documentElement;

    // Apply basic primary and secondary colors dynamically to CSS variables (BOTH MODES)
    if (colors.primary) {
      root.style.setProperty('--primary', colors.primary);
      root.style.setProperty('--primary-container', colors.primary_container || colors.primary);
    }
    if (colors.primary_hover) root.style.setProperty('--primary-hover', colors.primary_hover);
    if (colors.primary_foreground) root.style.setProperty('--on-primary', colors.primary_foreground);
    
    if (colors.secondary) {
      root.style.setProperty('--secondary', colors.secondary);
      root.style.setProperty('--secondary-container', colors.secondary_container || colors.secondary);
    }
    if (colors.secondary_foreground) root.style.setProperty('--on-secondary', colors.secondary_foreground);

    if (colors.success) root.style.setProperty('--success', colors.success);
    if (colors.warning) root.style.setProperty('--warning', colors.warning);
    if (colors.danger) root.style.setProperty('--error', colors.danger);

    const isDark = root.classList.contains('dark');
    if (!isDark) {
      // In light mode, clear out any structural overrides from dark mode
      root.style.removeProperty('--background');
      root.style.removeProperty('--surface');
      root.style.removeProperty('--surface-container');
      root.style.removeProperty('--on-surface');
      root.style.removeProperty('--on-surface-variant');
      root.style.removeProperty('--outline');
      return;
    }

    // Apply structural colors ONLY in dark mode
    if (colors.background) root.style.setProperty('--background', colors.background);
    if (colors.surface) root.style.setProperty('--surface', colors.surface);
    if (colors.surface_2) root.style.setProperty('--surface-container', colors.surface_2);
    if (colors.text) root.style.setProperty('--on-surface', colors.text);
    if (colors.text_muted) root.style.setProperty('--on-surface-variant', colors.text_muted);
    if (colors.border) root.style.setProperty('--outline', colors.border);
  };

  const updateSEOTags = (data) => {
    if (data?.brand_name) {
      document.title = `${data.brand_name} | سوق قطع غيار الأجهزة المنزلية`;
      const metaTitle = document.querySelector('meta[property="og:title"]');
      if (metaTitle) metaTitle.setAttribute('content', document.title);
      const metaSiteName = document.querySelector('meta[property="og:site_name"]');
      if (metaSiteName) metaSiteName.setAttribute('content', data.brand_name);
    }
    if (data?.favicon_url) {
      let link = document.querySelector("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = data.favicon_url;
    }
    if (data?.store_description) {
      let metaDesc = document.querySelector('meta[name="description"]');
      if (!metaDesc) {
        metaDesc = document.createElement('meta');
        metaDesc.name = 'description';
        document.head.appendChild(metaDesc);
      }
      metaDesc.setAttribute('content', data.store_description);
      
      let ogDesc = document.querySelector('meta[property="og:description"]');
      if (!ogDesc) {
        ogDesc = document.createElement('meta');
        ogDesc.setAttribute('property', 'og:description');
        document.head.appendChild(ogDesc);
      }
      ogDesc.setAttribute('content', data.store_description);
    }
  };

  return (
    <SettingsContext.Provider value={{ settings, loading, error, refreshSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
