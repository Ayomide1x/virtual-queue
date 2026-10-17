import { useEffect, useState } from 'react';

// Offset between server and device clocks, so "waiting 4:12" is right on any device.
let offset = 0;

export function syncClock(serverNow: number) {
  offset = serverNow - Date.now();
}

export function serverNow(): number {
  return Date.now() + offset;
}

/** Re-renders every `intervalMs` and returns the current server time. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
