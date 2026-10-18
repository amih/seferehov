import { api } from './api.js';

// Phone notifications on this device: the browser's permission, then an address the
// server sends to. iPhones only allow it once the app is on the home screen.
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const b64ToBytes = (s) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Resolves to true when this device will get notifications.
export async function enablePush() {
  if (!pushSupported()) return false;
  if (await Notification.requestPermission() !== 'granted') return false;
  const { key } = await api('/api/push/key');
  if (!key) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await api('/api/push', { method: 'POST', json: sub.toJSON() });
  return true;
}

export async function disablePush() {
  const sub = await currentSub();
  if (!sub) return;
  await api('/api/push', { method: 'DELETE', json: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
