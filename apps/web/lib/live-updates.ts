'use client';
import { useEffect, useState } from 'react';
import { LiveUpdates, type ApiClient, type LiveMessage } from '@harbor/api-client';

// Pushed hints are rebroadcast as window events so any view can refresh itself.
// The web app owns the socket below; the desktop renderer forwards its main process's.
const liveEvent = 'harbor:live';
let connected = false;
/** Whether pushed updates are arriving, so views can poll rarely. */
export const isLive = () => connected;
export function setLiveConnected(value: boolean) {
  connected = value;
}
// Every hint makes each open view refetch its data, and a device saving many files sends
// several hints a second. Deliver the first at once, then at most one per window.
export const LIVE_COALESCE_MS = 5000;
const coalesced = new Map<
  LiveMessage['type'],
  { last: number; timer?: ReturnType<typeof setTimeout> }
>();
const dispatch = (message: LiveMessage) =>
  window.dispatchEvent(new CustomEvent<LiveMessage>(liveEvent, { detail: message }));
export function publishLive(message: LiveMessage) {
  const state = coalesced.get(message.type) ?? { last: -Infinity };
  coalesced.set(message.type, state);
  if (state.timer) return;
  const wait = state.last + LIVE_COALESCE_MS - Date.now();
  if (wait <= 0) {
    state.last = Date.now();
    dispatch(message);
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = undefined;
    state.last = Date.now();
    dispatch(message);
  }, wait);
}
export function onLive(listener: (message: LiveMessage) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<LiveMessage>).detail);
  window.addEventListener(liveEvent, handler);
  return () => window.removeEventListener(liveEvent, handler);
}
/** Holds the live updates connection for the signed-in web user. */
export function useLiveUpdates(api: ApiClient, userId: string | undefined) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!userId) return;
    let opened = false;
    const updates = new LiveUpdates({
      ticket: () => api.request('/v1/realtime/tickets', { method: 'POST' }),
      onMessage: publishLive,
      onConnected(value) {
        setLiveConnected(value);
        setLive(value);
        // A reconnect may have missed messages while the socket was down.
        if (value && opened) publishLive({ type: 'changes' });
        opened ||= value;
      },
    });
    updates.start();
    return () => {
      updates.stop();
      setLiveConnected(false);
      setLive(false);
    };
  }, [api, userId]);
  return live;
}
