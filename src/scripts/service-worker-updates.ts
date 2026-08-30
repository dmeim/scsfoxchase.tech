import { showToast } from './toasts';

let updateToastId: string | null = null;
let reloadRequested = false;
let reloadStarted = false;

function showUpdateToast(onReload: () => void): void {
  if (updateToastId) return;

  updateToastId = showToast({
    kind: 'info',
    icon: 'info',
    title: 'Update ready',
    description: 'Reload to use the latest version of St. Cecilia Technology.',
    persist: true,
    action: {
      label: 'Reload',
      onClick: () => {
        reloadRequested = true;
        onReload();
      },
    },
  });
}

function showWaitingUpdateToast(
  registration: ServiceWorkerRegistration,
  updateWorker: ServiceWorker,
): void {
  showUpdateToast(() => {
    const waitingWorker = registration.waiting ?? updateWorker;
    if (waitingWorker.state === 'installed') {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    window.location.reload();
  });
}

export async function registerServiceWorkerUpdates(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadStarted || (!hadController && !reloadRequested)) return;
    if (!reloadRequested) {
      showUpdateToast(() => window.location.reload());
      return;
    }
    reloadStarted = true;
    window.location.reload();
  });

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      updateViaCache: 'none',
    });

    if (registration.waiting && navigator.serviceWorker.controller) {
      showWaitingUpdateToast(registration, registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const installingWorker = registration.installing;
      if (!installingWorker) return;

      installingWorker.addEventListener('statechange', () => {
        if (
          installingWorker.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          showWaitingUpdateToast(registration, installingWorker);
        }
      });
    });

    console.log('Service Worker registered with scope:', registration.scope);
  } catch (error) {
    console.error('Service Worker registration failed:', error);
  }
}

if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
  window.addEventListener('load', () => {
    void registerServiceWorkerUpdates();
  }, { once: true });
}
