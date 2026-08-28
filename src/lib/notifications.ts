export const NOTIFICATION_KINDS = [
  'success',
  'warning',
  'info',
  'error',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_ICONS = [
  'bell',
  'circle-check',
  'triangle-alert',
  'info',
  'circle-x',
  'log-in',
  'square-plus',
] as const;

export type NotificationIcon = (typeof NOTIFICATION_ICONS)[number];

export const TOAST_KINDS = [...NOTIFICATION_KINDS, 'loading'] as const;
export type ToastKind = (typeof TOAST_KINDS)[number];

export const TOAST_ICONS = [...NOTIFICATION_ICONS, 'loader'] as const;
export type ToastIcon = (typeof TOAST_ICONS)[number];

export type NotificationInput = {
  id?: string;
  kind: NotificationKind;
  icon: NotificationIcon;
  title: string;
  subtitle?: string;
  description?: string;
  persist?: boolean;
  dedupeKey?: string;
  expiresAt?: string;
};

export type NotificationRecord = Required<
  Pick<NotificationInput, 'kind' | 'icon' | 'title'>
> & {
  id: string;
  subtitle?: string;
  description?: string;
  persist: boolean;
  dedupeKey?: string;
  createdAt: string;
  expiresAt: string;
  readAt?: string;
};

export type ToastInput = Omit<
  NotificationInput,
  'id' | 'dedupeKey' | 'expiresAt' | 'kind' | 'icon'
> & {
  kind: ToastKind;
  icon: ToastIcon;
  duration?: number;
};

const kindSet = new Set<string>(NOTIFICATION_KINDS);
const iconSet = new Set<string>(NOTIFICATION_ICONS);
const toastKindSet = new Set<string>(TOAST_KINDS);
const toastIconSet = new Set<string>(TOAST_ICONS);

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && kindSet.has(value);
}

export function isNotificationIcon(value: unknown): value is NotificationIcon {
  return typeof value === 'string' && iconSet.has(value);
}

export function isToastKind(value: unknown): value is ToastKind {
  return typeof value === 'string' && toastKindSet.has(value);
}

export function isToastIcon(value: unknown): value is ToastIcon {
  return typeof value === 'string' && toastIconSet.has(value);
}
