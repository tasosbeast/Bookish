// The API client is injected from api.js so this module does not import it back.
const UNSUBSCRIBE_WAIT_MS = 5000;
let pushApi = null;
let warnedUnconfigured = false;
let pendingUnsubscribe = Promise.resolve();

export function configurePushClient(client) {
  pushApi = typeof client === 'function' ? client : null;
  if (pushApi) warnedUnconfigured = false;
}

function requirePushApi() {
  if (pushApi) return pushApi;
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn('[push] Push client is not configured.');
  }
  return null;
}

function trackUnsubscribe(promise) {
  const settled = Promise.resolve(promise).then(() => {}, () => {});
  pendingUnsubscribe = pendingUnsubscribe.then(() => settled, () => settled);
  return promise;
}

async function waitForPendingUnsubscribe() {
  let timer;
  let timedOut = false;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => { timedOut = true; resolve(); }, UNSUBSCRIBE_WAIT_MS);
  });
  try {
    await Promise.race([pendingUnsubscribe, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) console.warn('[push] Waited too long for an in-flight unsubscribe; continuing.');
}

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

export async function checkSubscriptionStatus(endpoint) {
  if (!endpoint || !isPushSupported()) return false;
  const client = requirePushApi();
  if (!client) return false;
  try {
    const result = await client('/push/subscriptions/status', {
      method: 'POST',
      auth: 'required',
      body: { endpoint },
    });
    return Boolean(result?.data?.subscribed);
  } catch {
    return false;
  }
}

export async function subscribeToPush() {
  if (!isPushSupported()) {
    throw new Error('Browser notifications are not supported on this device.');
  }
  // A logout unsubscribe that outlived its deadline must finish before a new subscription is created.
  // Cap the wait so a hung PushManager cannot block the Account toggle forever.
  await waitForPendingUnsubscribe();
  const client = requirePushApi();
  if (!client) {
    throw new Error('Push notifications are currently unavailable.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was denied.');
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  if (navigator.serviceWorker.ready) {
    await navigator.serviceWorker.ready;
  }

  const keyResponse = await client('/push/public-key', { auth: 'none' });
  const publicKey = keyResponse?.data?.publicKey;
  if (!publicKey) {
    throw new Error('Push notifications are currently unavailable.');
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const convertedKey = urlBase64ToUint8Array(publicKey);
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedKey,
    });
  }

  const json = subscription.toJSON ? subscription.toJSON() : {};
  const p256dh = json.keys?.p256dh;
  const authKey = json.keys?.auth;

  await client('/push/subscriptions', {
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

async function dropBrowserPushSubscriptionNow() {
  if (!isPushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (!subscription) return false;
    return await subscription.unsubscribe();
  } catch (err) {
    console.warn('[push] Failed to unsubscribe:', err);
    return false;
  }
}

// Browser-only. Used when the session is already unauthenticated, so no server delete is attempted.
export function dropBrowserPushSubscription() {
  return trackUnsubscribe(dropBrowserPushSubscriptionNow());
}

async function unsubscribeFromPushNow({ signal } = {}) {
  if (signal?.aborted || !isPushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.pushManager) return false;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return false;

    const client = requirePushApi();
    if (!client) {
      return await subscription.unsubscribe();
    }
    try {
      await client('/push/subscriptions', {
        method: 'DELETE',
        auth: 'required',
        body: { endpoint: subscription.endpoint },
        signal,
      });
    } catch (err) {
      // Abort is the logout deadline. Any other server failure is logged once here.
      if (err?.name !== 'AbortError' && !signal?.aborted) {
        console.warn('[push] Failed to remove subscription from backend:', err);
      }
    }

    return await subscription.unsubscribe();
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) return false;
    // Account calls this without a signal and still needs the rejection.
    // Logout passes a signal and must not log the same failure again upstream.
    if (signal) {
      console.warn('[push] Failed to unsubscribe:', err);
      return false;
    }
    throw err;
  }
}

export function unsubscribeFromPush(options) {
  return trackUnsubscribe(unsubscribeFromPushNow(options));
}
