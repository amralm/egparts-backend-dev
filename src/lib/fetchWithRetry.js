const RETRY_DELAYS = [3000, 5000, 10000, 15000, 20000];

export default async function fetchWithRetry(url, options, onRetry) {
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (err) {
      if (i === RETRY_DELAYS.length - 1) throw err;
      if (onRetry) onRetry(i);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[i]));
    }
  }
}

export const RETRY_MESSAGES = [
  'جاري الاتصال بالخادم...',
  'جاري إيقاظ الخادم...',
  'الخادم يستيقظ...',
  'تقريباً انتهينا...',
  'تم توصيل الخادم بنجاح!',
];
