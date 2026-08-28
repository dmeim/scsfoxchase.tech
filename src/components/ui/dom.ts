import type { BadgeTone, ButtonVariant, ComponentSize, FeedbackTone } from './types';

const join = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

/** Shared class contract for content that must be created after Astro renders. */
export const uiClassNames = {
  button: (variant: ButtonVariant = 'primary', size: ComponentSize = 'default', extra?: string) =>
    join('ui-button', `ui-button--${variant}`, size !== 'default' && `ui-button--${size}`, extra),
  iconButton: (size: ComponentSize = 'default', extra?: string) =>
    join('ui-icon-button', size !== 'default' && `ui-icon-button--${size}`, extra),
  card: (extra?: string, options?: { transparent?: boolean }) =>
    join('ui-card', options?.transparent && 'ui-card--transparent', extra),
  badge: (tone: BadgeTone = 'normal', extra?: string) => join('ui-badge', `ui-badge--${tone}`, extra),
  chip: (selected = false, extra?: string) => join('ui-chip', 'ui-chip--filter', selected && 'is-selected', extra),
  fieldControl: (extra?: string) => join('ui-field-control', extra),
  feedback: (tone: FeedbackTone = 'info', extra?: string) => join('ui-feedback', `ui-feedback--${tone}`, extra),
};

export function setUiButtonLoading(
  button: HTMLButtonElement,
  loading: boolean,
  labels: { loading: string; idle: string },
  idleIcon?: string,
): void {
  button.disabled = loading;
  button.toggleAttribute('aria-busy', loading);
  if (loading) {
    const spinner = document.createElement('span');
    spinner.className = 'ui-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    button.replaceChildren(spinner, document.createTextNode(labels.loading));
    return;
  }
  const content: Node[] = [];
  if (idleIcon) {
    const icon = document.createElement('span');
    icon.className = 'ui-button-icon';
    icon.innerHTML = idleIcon;
    content.push(icon);
  }
  content.push(document.createTextNode(labels.idle));
  button.replaceChildren(...content);
}
