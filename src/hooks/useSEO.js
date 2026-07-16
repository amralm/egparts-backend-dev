import { useEffect } from 'react';
import { useSettings } from '../context/SettingsContext';

export function useSEO({ title, description, image, url }) {
  const { settings } = useSettings();

  useEffect(() => {
    // Set standard Document Title
    const siteName = settings?.brand_name || 'EG-PARTS';
    document.title = title ? title.replace('EG-PARTS', siteName) : siteName;
    
    // Helper function to dynamically add/update Meta Tags
    const setMeta = (name, content, attribute = 'name') => {
      if (!content) return;
      let tag = document.querySelector(`meta[${attribute}="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute(attribute, name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    const defaultDesc = `اكتشف أفضل المنتجات وقطع الغيار في ${siteName}.`;
    const finalDesc = description || defaultDesc;
    const finalUrl = url || window.location.href;

    // Standard Tags
    setMeta('description', finalDesc);

    // Open Graph (Facebook, WhatsApp, LinkedIn)
    setMeta('og:site_name', siteName, 'property');
    setMeta('og:title', title || siteName, 'property');
    setMeta('og:description', finalDesc, 'property');
    setMeta('og:url', finalUrl, 'property');
    setMeta('og:type', 'website', 'property');
    
    if (image) {
      setMeta('og:image', image, 'property');
      setMeta('og:image:width', '1200', 'property');
      setMeta('og:image:height', '630', 'property');
    }

    // Twitter
    setMeta('twitter:card', 'summary_large_image');
    setMeta('twitter:title', title || siteName);
    setMeta('twitter:description', finalDesc);
    if (image) {
      setMeta('twitter:image', image);
    }

  }, [title, description, image, url]);
}
