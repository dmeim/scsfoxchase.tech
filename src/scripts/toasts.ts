import {
  iconBell,
  iconCircleCheck,
  iconCircleX,
  iconInfo,
  iconLogIn,
  iconSquarePlus,
  iconTimes,
  iconTriangleAlert,
} from './icons';
import {
  isNotificationIcon,
  isNotificationKind,
  type NotificationIcon,
  type ToastInput,
} from '../lib/notifications';

const DEFAULT_DURATION_MS = 10_000;

const iconMarkup: Record<NotificationIcon, string> = {
  bell: iconBell,
  'circle-check': iconCircleCheck,
  'triangle-alert': iconTriangleAlert,
  info: iconInfo,
  'circle-x': iconCircleX,
  'log-in': iconLogIn,
  'square-plus': iconSquarePlus,
};

export function notificationIconMarkup(icon: NotificationIcon): string {
  return iconMarkup[icon] ?? iconBell;
}

function textElement(className: string, value: string): HTMLElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = value;
  return element;
}

export function dismissToast(id: string): void {
  document.querySelector<HTMLElement>(`[data-toast-id="${CSS.escape(id)}"]`)?.remove();
}

export function showToast(input: ToastInput): string | null {
  if (
    typeof document === 'undefined' ||
    !isNotificationKind(input.kind) ||
    !isNotificationIcon(input.icon) ||
    typeof input.title !== 'string' ||
    !input.title.trim()
  ) {
    return null;
  }
  const region = document.querySelector<HTMLElement>('[data-toast-region]');
  if (!region) return null;

  const id = crypto.randomUUID();
  const toast = document.createElement('article');
  toast.className = `toast is-${input.kind}`;
  toast.dataset.toastId = id;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = notificationIconMarkup(input.icon);

  const copy = document.createElement('div');
  copy.className = 'toast-copy';
  copy.appendChild(textElement('toast-title', input.title.trim()));
  if (input.subtitle?.trim()) {
    copy.appendChild(textElement('toast-subtitle', input.subtitle.trim()));
  }
  if (input.description?.trim()) {
    copy.appendChild(textElement('toast-description', input.description.trim()));
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = iconTimes;
  close.addEventListener('click', () => dismissToast(id));

  toast.appendChild(icon);
  toast.appendChild(copy);
  toast.appendChild(close);
  region.insertBefore(toast, region.firstChild);

  if (!input.persist) {
    const requested = Number(input.duration);
    const duration = Number.isFinite(requested) && requested >= 1_000
      ? Math.min(requested, 60_000)
      : DEFAULT_DURATION_MS;
    window.setTimeout(() => dismissToast(id), duration);
  }
  return id;
}
