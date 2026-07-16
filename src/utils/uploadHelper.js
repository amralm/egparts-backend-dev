import axios from 'axios';
import { supabase } from '../lib/supabase';

const UPLOAD_LIMITS = {
  avatars: 512 * 1024,      // 512 KB
  logos: 1 * 1024 * 1024,     // 1 MB
  products: 2 * 1024 * 1024,  // 2 MB
  banners: 3 * 1024 * 1024,   // 3 MB
  categories: 2 * 1024 * 1024, // 2 MB
  default: 5 * 1024 * 1024   // 5 MB
};

const CDN_URL = import.meta.env.VITE_CDN_URL || 'https://media.egparts.store';

// Prepend Custom CDN domain to relative storage key for rendering
export function getMediaUrl(key) {
  if (!key) return '';
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  return `${CDN_URL}/${key}`;
}

export async function compressAndConvertToWebp(file, maxDimension = 1920, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') {
      resolve(file);
      return;
    }

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Image compression failed'));
            return;
          }
          const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".webp", {
            type: 'image/webp',
            lastModified: Date.now(),
          });
          resolve(compressedFile);
        }, 'image/webp', quality);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}

// Upload file to R2, returning the relative storage key
export async function uploadFileToR2({ file, category, customName }) {
  if (!file) return null;

  const limit = UPLOAD_LIMITS[category] || UPLOAD_LIMITS.default;
  if (file.size > limit) {
    const limitMB = (limit / (1024 * 1024)).toFixed(1);
    throw new Error(`حجم الملف كبير جداً. الحد الأقصى المسموح به هو ${limitMB} ميجابايت.`);
  }

  const processedFile = await compressAndConvertToWebp(file);
  
  // Safe JWT token retrieval via Supabase Client
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  if (!token) {
    throw new Error('User session not authenticated');
  }

  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
  const response = await axios.post(`${backendUrl}/api/storage/presigned-url`, {
    category,
    customName,
    contentType: processedFile.type,
    originalName: file.name,
    size: processedFile.size
  }, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    withCredentials: true
  });

  const { uploadUrl, key } = response.data;

  // PUT binary directly to R2
  await axios.put(uploadUrl, processedFile, {
    headers: {
      'Content-Type': processedFile.type
    }
  });

  return key;
}

// Securely deletes an old file from R2
export async function deleteFileFromR2(key) {
  if (!key) return;
  
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  
  if (!token) return;

  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
  await axios.post(`${backendUrl}/api/storage/delete-file`, { key }, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    withCredentials: true
  });
}
