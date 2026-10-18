import { useEffect, useState, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';
import { syncClock } from './clock';

export const socket = io({
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

export type Subscription =
  | { officeId: string; role: 'staff'; staffKey: string }
  | { officeId: string; role: 'lobby' }
  | { officeId: string; role: 'ticket'; ticketId: string };

export type ChannelError = 'office_not_found' | 'forbidden';

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
 * Subscribe to a live channel of one office. Re-subscribes on every
 * (re)connect, and the server answers each subscribe with the current state —
 * so after a dropped connection the screen catches up immediately.
 */
export function useChannel<T extends { officeId: string; serverNow?: number }>(
  sub: Subscription | null,
  event: string,
  filter?: (data: T) => boolean,
): { data: T | null; error: ChannelError | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ChannelError | null>(null);
  const key = sub ? JSON.stringify(sub) : null;

  useEffect(() => {
    if (!sub) return;
    setData(null);
    setError(null);
    const onData = (d: T) => {
      if (d?.officeId !== sub.officeId || (filter && !filter(d))) return;
      if (typeof d.serverNow === 'number') syncClock(d.serverNow);
      setError(null);
      setData(d);
    };
    const onError = (e: { officeId: string; role: string; code: ChannelError }) => {
      if (e.officeId === sub.officeId && e.role === sub.role) setError(e.code);
    };
    const doSubscribe = () => socket.emit('subscribe', sub);
    socket.on(event, onData);
    socket.on('subscribe:error', onError);
    socket.on('connect', doSubscribe);
    if (socket.connected) doSubscribe();
    return () => {
      socket.off(event, onData);
      socket.off('subscribe:error', onError);
      socket.off('connect', doSubscribe);
      socket.emit('unsubscribe', sub);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, event]);

  return { data, error };
}
