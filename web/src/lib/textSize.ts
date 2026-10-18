import { useEffect, useState } from 'react';

// "Larger text": scales the root font size, so everything sized in rem grows.
// Remembered on this device; applied before the first render (see main.tsx).

const KEY = 'vq.textSize';
const CLASS = 'text-large';

export function savedLargeText(): boolean {
  try {
    return localStorage.getItem(KEY) === 'large';
  } catch {
    return false;
  }
}

export function applyLargeText(on: boolean) {
  document.documentElement.classList.toggle(CLASS, on);
}

export function useLargeText(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(savedLargeText);
  useEffect(() => {
    applyLargeText(on);
    try {
      if (on) localStorage.setItem(KEY, 'large');
      else localStorage.removeItem(KEY);
    } catch {
      /* just not remembered */
    }
  }, [on]);
  return [on, setOn];
}
