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

export type ToastInput = Omit<NotificationInput, 'id' | 'dedupeKey' | 'expiresAt'> & {
  duration?: number;
};

const kindSet = new Set<string>(NOTIFICATION_KINDS);
const iconSet = new Set<string>(NOTIFICATION_ICONS);

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && kindSet.has(value);
}

export function isNotificationIcon(value: unknown): value is NotificationIcon {
  return typeof value === 'string' && iconSet.has(value);
}
