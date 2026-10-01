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
export function publishLive(message: LiveMessage) {
  window.dispatchEvent(new CustomEvent<LiveMessage>(liveEvent, { detail: message }));
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
