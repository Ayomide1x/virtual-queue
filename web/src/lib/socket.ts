import { useEffect, useState, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';
import { syncClock } from './clock';

export const socket = io({
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

export type Subscription = { role: 'staff' } | { role: 'lobby' } | { role: 'ticket'; ticketId: string };

function subscribeConnection(cb: () => void) {
  socket.on('connect', cb);
  socket.on('disconnect', cb);
  return () => {
    socket.off('connect', cb);
    socket.off('disconnect', cb);
  };
}

export function useConnected(): boolean {
  return useSyncExternalStore(subscribeConnection, () => socket.connected);
}

/**
 * Subscribe to a live channel. Re-subscribes on every (re)connect, and the
 * server answers each subscribe with the current state — so after a dropped
 * connection the screen catches up immediately.
 */
export function useChannel<T extends { serverNow?: number }>(sub: Subscription | null, event: string, filter?: (data: T) => boolean): T | null {
  const [data, setData] = useState<T | null>(null);
  const key = sub ? JSON.stringify(sub) : null;

  useEffect(() => {
    if (!sub) return;
    setData(null);
    const onData = (d: T) => {
      if (filter && !filter(d)) return;
      if (d && typeof d.serverNow === 'number') syncClock(d.serverNow);
      setData(d);
    };
    const doSubscribe = () => socket.emit('subscribe', sub);
    socket.on(event, onData);
    socket.on('connect', doSubscribe);
    if (socket.connected) doSubscribe();
    return () => {
      socket.off(event, onData);
      socket.off('connect', doSubscribe);
      socket.emit('unsubscribe', sub);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, event]);

  return data;
}
