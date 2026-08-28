import {
  iconCircleCheck,
  iconCircleX,
  iconInfo,
  iconTriangleAlert,
} from '../scripts/icons';

export type TempNotificationKind = 'success' | 'warning' | 'info' | 'error';

export interface TempNotification {
  id: string;
  kind: TempNotificationKind;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
}

export const tempNotifications: TempNotification[] = [
  {
    id: 'board-saved',
    kind: 'success',
    title: 'Whiteboard saved',
    subtitle: 'Available everywhere',
    description: 'This board is now in your Library and ready on any Chromebook.',
    icon: iconCircleCheck,
  },
  {
    id: 'scratch-board',
    kind: 'warning',
    title: 'Scratch board not saved',
    subtitle: 'Removed after 24 hours',
    description: 'Sign in and save this board if you want to keep it in your Library.',
    icon: iconTriangleAlert,
  },
  {
    id: 'group-edit',
    kind: 'info',
    title: 'Group Edit is off',
    subtitle: 'Guests are view-only',
    description: 'Turn on Group Edit when everyone is ready to draw.',
    icon: iconInfo,
  },
  {
    id: 'share-code-required',
    kind: 'error',
    title: 'Share code required',
    subtitle: 'Couldn’t join the board',
    description: 'Enter a share code, board link, or UUID and try again.',
    icon: iconCircleX,
  },
];
