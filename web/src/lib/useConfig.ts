import { useEffect, useState } from 'react';
import type { AppConfig } from '../types';
import { api } from './api';

let cached: AppConfig | null = null;

export function useConfig(): AppConfig | null {
  const [config, setConfig] = useState(cached);
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    const load = (attempt = 0) =>
      api
        .config()
        .then((c) => {
          cached = c;
          if (!cancelled) setConfig(c);
        })
        .catch(() => {
          if (!cancelled) setTimeout(() => load(attempt + 1), Math.min(1000 * (attempt + 1), 5000));
        });
    load();
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}
