import { useState, useEffect } from 'react';

let cachedDevMode = null;
let fetchPromise = null;

/**
 * Returns whether the platform is currently in developer mode.
 * Fetches once from /api/health/maintenance and caches the result.
 */
export function useDevMode() {
  const [devMode, setDevMode] = useState(cachedDevMode ?? false);

  useEffect(() => {
    if (cachedDevMode !== null) {
      setDevMode(cachedDevMode);
      return;
    }

    if (!fetchPromise) {
      fetchPromise = fetch(`${import.meta.env.VITE_BACKEND_URL}/api/health/maintenance`)
        .then(r => r.json())
        .then(data => {
          cachedDevMode = data.devMode === true;
          return cachedDevMode;
        })
        .catch(() => {
          cachedDevMode = false;
          return false;
        });
    }

    fetchPromise.then(val => setDevMode(val));
  }, []);

  return devMode;
}
