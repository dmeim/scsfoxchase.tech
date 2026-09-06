import {
  getActiveIdentity,
  getSessionTokenSettled,
  onAuthChange,
  whenAuthReady,
} from '../lib/whiteboard-identity';
import {
  isNotificationIcon,
  isNotificationKind,
  type NotificationInput,
  type NotificationRecord,
} from '../lib/notifications';
import { iconTimes } from './icons';
import { notificationIconMarkup, showToast } from './toasts';
import { uiClassNames } from '../components/ui/dom';

const STORAGE_KEY = 'scsfoxchase.notifications.v1';
const MAX_LOCAL_NOTIFICATIONS = 100;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const centers = [...document.querySelectorAll<HTMLElement>('[data-notification-center]')];
let notifications: NotificationRecord[] = [];
let usingCloud = false;
let mutationBusy = false;
let syncGeneration = 0;
let renderedIdentity: string | undefined;

function validRecord(value: unknown): value is NotificationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' && UUID_RE.test(item.id) &&
    isNotificationKind(item.kind) &&
    isNotificationIcon(item.icon) &&
    typeof item.title === 'string' &&
    item.title.length > 0 && item.title.length <= 100 &&
    typeof item.createdAt === 'string' &&
    typeof item.expiresAt === 'string' &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    Number.isFinite(Date.parse(item.expiresAt)) &&
    Date.parse(item.createdAt) <= Date.now() + 5 * 60_000 &&
    Date.parse(item.expiresAt) <= Date.parse(item.createdAt) + MAX_RETENTION_MS &&
    typeof item.persist === 'boolean' &&
    (item.subtitle === undefined || (typeof item.subtitle === 'string' && item.subtitle.length <= 140)) &&
    (item.description === undefined || (typeof item.description === 'string' && item.description.length <= 500)) &&
    (item.dedupeKey === undefined || (typeof item.dedupeKey === 'string' && item.dedupeKey.length <= 120)) &&
    (item.readAt === undefined || (
      typeof item.readAt === 'string' && Number.isFinite(Date.parse(item.readAt))
    ))
  );
}

function loadLocal(): NotificationRecord[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter(validRecord)
      .filter((item) => Date.parse(item.expiresAt) > now)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_LOCAL_NOTIFICATIONS);
  } catch {
    return [];
  }
}

function saveLocal(items: NotificationRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_LOCAL_NOTIFICATIONS)));
  } catch {
    // A full or blocked localStorage must not break transient toasts.
  }
}

async function api(path = '', init: RequestInit = {}): Promise<Response | null> {
  const token = await getSessionTokenSettled();
  if (!token) return null;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return fetch(`/api/notifications${path}`, { ...init, headers });
}

function formatTime(value: string): string {
  const elapsed = Date.parse(value) - Date.now();
  const abs = Math.abs(elapsed);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return formatter.format(Math.round(elapsed / 60_000), 'minute');
  if (abs < 86_400_000) return formatter.format(Math.round(elapsed / 3_600_000), 'hour');
  return formatter.format(Math.round(elapsed / 86_400_000), 'day');
}

function addText(parent: HTMLElement, className: string, value?: string): void {
  if (!value) return;
  const element = document.createElement('p');
  element.className = className;
  element.textContent = value;
  parent.appendChild(element);
}

function render(): void {
  const unread = notifications.filter((item) => !item.readAt).length;
  for (const center of centers) {
    const list = center.querySelector<HTMLUListElement>('[data-notification-list]');
    const empty = center.querySelector<HTMLElement>('[data-notification-empty]');
    const badge = center.querySelector<HTMLElement>('[data-notification-badge]');
    const clear = center.querySelector<HTMLButtonElement>('[data-notification-clear]');
    if (!list || !empty || !badge || !clear) continue;

    list.replaceChildren();
    for (const item of notifications) {
      const row = document.createElement('li');
      row.className = `notification-item is-${item.kind}${item.readAt ? '' : ' is-unread'}`;
      row.dataset.notificationId = item.id;

      const icon = document.createElement('span');
      icon.className = 'notification-item-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = notificationIconMarkup(item.icon);

      const copy = document.createElement('div');
      copy.className = 'notification-item-copy';
      addText(copy, 'notification-item-title', item.title);
      addText(copy, 'notification-item-subtitle', item.subtitle);
      addText(copy, 'notification-item-description', item.description);
      const time = document.createElement('time');
      time.className = 'notification-item-time';
      time.dateTime = item.createdAt;
      time.textContent = formatTime(item.createdAt);
      copy.appendChild(time);

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = uiClassNames.iconButton('small', 'notification-dismiss');
      dismiss.dataset.notificationDismiss = item.id;
      dismiss.setAttribute('aria-label', `Dismiss ${item.title}`);
      dismiss.innerHTML = iconTimes;
      dismiss.disabled = mutationBusy;
      row.appendChild(icon);
      row.appendChild(copy);
      row.appendChild(dismiss);
      list.appendChild(row);
    }

    list.hidden = notifications.length === 0;
    empty.hidden = notifications.length > 0;
    clear.disabled = notifications.length === 0 || mutationBusy;
    center.setAttribute('aria-busy', String(mutationBusy));
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  }
}

async function claimLocalAndLoadCloud(): Promise<void> {
  const generation = ++syncGeneration;
  const identity = getActiveIdentity()?.clerkUserId;
  const current = () => generation === syncGeneration && identity === getActiveIdentity()?.clerkUserId;
  try {
    const local = loadLocal();
    if (local.length > 0) {
      const response = await api('/claim', {
        method: 'POST',
        body: JSON.stringify({ notifications: local }),
      });
      if (!current()) return;
      if (!response?.ok) {
        usingCloud = false;
        notifications = local;
        render();
        return;
      }
      const body = await response.json() as { claimedIds?: unknown };
      if (!current()) return;
      const claimed = new Set(Array.isArray(body.claimedIds) ? body.claimedIds : []);
      saveLocal(local.filter((item) => !claimed.has(item.id)));
    }

    const response = await api();
    if (!current()) return;
    if (!response?.ok) throw new Error('Could not refresh notifications');
    const body = await response.json() as { notifications?: unknown };
    if (!current()) return;
    usingCloud = true;
    notifications = Array.isArray(body.notifications)
      ? body.notifications.filter(validRecord)
      : [];
    render();
  } catch {
    // Keep the last rendered list available during a transient connection failure.
    if (current()) render();
  }
}

async function syncForIdentity(): Promise<void> {
  const identity = getActiveIdentity()?.clerkUserId;
  if (identity !== renderedIdentity) {
    ++syncGeneration;
    renderedIdentity = identity;
    usingCloud = false;
    notifications = loadLocal();
    render();
  }
  if (identity) {
    await claimLocalAndLoadCloud();
  } else {
    ++syncGeneration;
    usingCloud = false;
    notifications = loadLocal();
    render();
  }
}

async function commitChange(path: string, method: string, apply: () => void): Promise<void> {
  if (mutationBusy) return;
  const identity = getActiveIdentity()?.clerkUserId;
  const cloud = usingCloud;
  mutationBusy = true;
  ++syncGeneration; // A stale list response must not undo a completed action.
  render();
  try {
    if (cloud) {
      const response = await api(path, { method });
      if (!response?.ok) throw new Error('Notification update failed');
    }
    if (identity !== getActiveIdentity()?.clerkUserId) return;
    ++syncGeneration;
    apply();
    if (!cloud) saveLocal(notifications);
  } catch {
    if (identity === getActiveIdentity()?.clerkUserId) showToast({
      kind: 'error', icon: 'triangle-alert', title: 'Notifications were not updated',
      description: 'Check your connection and try again. Your notifications are still here.',
    });
  } finally {
    mutationBusy = false;
    render();
  }
}

async function markAllRead(): Promise<void> {
  const ids = new Set(notifications.filter(item => !item.readAt).map(item => item.id));
  if (ids.size === 0) return;
  const now = new Date().toISOString();
  await commitChange('/read-all', 'POST', () => {
    notifications = notifications.map(item => ids.has(item.id) ? { ...item, readAt: now } : item);
  });
}

async function dismiss(id: string): Promise<void> {
  await commitChange(`/${encodeURIComponent(id)}`, 'DELETE', () => {
    notifications = notifications.filter(item => item.id !== id);
  });
}

async function clearAll(): Promise<void> {
  const ids = new Set(notifications.map(item => item.id));
  await commitChange('/clear', 'POST', () => {
    notifications = notifications.filter(item => !ids.has(item.id));
  });
}

function setOpen(center: HTMLElement, open: boolean): void {
  const trigger = center.querySelector<HTMLButtonElement>('[data-notification-trigger]');
  const panel = center.querySelector<HTMLElement>('[data-notification-panel]');
  if (!trigger || !panel) return;
  center.classList.toggle('is-open', open);
  trigger.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
  if (open) void markAllRead();
}

for (const center of centers) {
  center.querySelector('[data-notification-trigger]')?.addEventListener('click', () => {
    setOpen(center, !center.classList.contains('is-open'));
  });
  center.querySelector('[data-notification-clear]')?.addEventListener('click', () => {
    void clearAll();
  });
  center.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLElement>('[data-notification-dismiss]');
    if (button?.dataset.notificationDismiss) void dismiss(button.dataset.notificationDismiss);
  });
}

document.addEventListener('click', (event) => {
  for (const center of centers) {
    if (!center.contains(event.target as Node)) setOpen(center, false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const center of centers) setOpen(center, false);
});

export async function createNotification(input: NotificationInput): Promise<NotificationRecord | null> {
  const title = input.title?.trim();
  const subtitle = input.subtitle?.trim();
  const description = input.description?.trim();
  const dedupeKey = input.dedupeKey?.trim();
  if (
    !isNotificationKind(input.kind) ||
    !isNotificationIcon(input.icon) ||
    !title || title.length > 100 ||
    (subtitle && subtitle.length > 140) ||
    (description && description.length > 500) ||
    (dedupeKey && dedupeKey.length > 120)
  ) {
    return null;
  }
  const now = new Date();
  const requestedExpiry = input.expiresAt ? Date.parse(input.expiresAt) : Number.NaN;
  const expiresAt = Number.isFinite(requestedExpiry)
    ? Math.min(requestedExpiry, now.getTime() + MAX_RETENTION_MS)
    : now.getTime() + MAX_RETENTION_MS;
  if (expiresAt <= now.getTime()) return null;
  const local: NotificationRecord = {
    id: input.id && UUID_RE.test(input.id) ? input.id.toLowerCase() : crypto.randomUUID(),
    kind: input.kind,
    icon: input.icon,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(description ? { description } : {}),
    persist: input.persist === true,
    ...(dedupeKey ? { dedupeKey } : {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
  const pending = [local, ...loadLocal().filter((item) => item.id !== local.id)];
  saveLocal(pending);
  notifications = pending;
  usingCloud = false;
  render();
  showToast(local);
  if (getActiveIdentity()) await claimLocalAndLoadCloud();
  return local;
}

void whenAuthReady().then(syncForIdentity);
onAuthChange(() => { void syncForIdentity(); });
