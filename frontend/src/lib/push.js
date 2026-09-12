import { api } from './api.js';

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function getExistingSubscription() {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration || !registration.pushManager) return null;
  return registration.pushManager.getSubscription();
}

export async function subscribeToPush() {
  if (!isPushSupported()) {
    throw new Error('Browser notifications are not supported on this device.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was denied.');
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  if (navigator.serviceWorker.ready) {
    await navigator.serviceWorker.ready;
  }

  const keyResponse = await api('/push/public-key', { auth: 'none' });
  const publicKey = keyResponse?.data?.publicKey;
  if (!publicKey) {
    throw new Error('Push notifications are currently unavailable.');
  }

  const convertedKey = urlBase64ToUint8Array(publicKey);
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: convertedKey,
  });

  const json = subscription.toJSON ? subscription.toJSON() : {};
  const p256dh = json.keys?.p256dh;
  const authKey = json.keys?.auth;

  await api('/push/subscriptions', {
    method: 'POST',
    auth: 'required',
    body: {
      endpoint: subscription.endpoint,
      keys: {
        p256dh,
        auth: authKey,
      },
    },
  });

  return subscription;
}

export async function unsubscribeFromPush() {
  if (!isPushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration || !registration.pushManager) return false;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;

  const endpoint = subscription.endpoint;
  try {
    await api('/push/subscriptions', {
      method: 'DELETE',
      auth: 'required',
      body: { endpoint },
    });
  } catch (err) {
    console.warn('[push] Failed to remove subscription from backend:', err);
  }

  return subscription.unsubscribe();
}
