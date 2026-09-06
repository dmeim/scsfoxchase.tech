/**
 * Forms catalog — used by /help (featured), /forms (all), and tile launchers.
 * Individual form UIs live at /form/{slug}.
 */

export type FormEntry = {
  slug: string;
  label: string;
  description: string;
  /** Icon export name from src/scripts/icons.ts */
  icon: 'iconGamepad2' | 'iconWrench' | 'iconKeyRound';
  /** Show on /help Forms section */
  featured: boolean;
  status: 'live' | 'stub';
};

export const forms: FormEntry[] = [
  {
    slug: 'game-request',
    label: 'Request A Game',
    description: 'Suggest a new educational game for the catalog',
    icon: 'iconGamepad2',
    featured: true,
    status: 'stub',
  },
  {
    slug: 'help-tech',
    label: 'General Technology Help',
    description: 'Report tech issues or ask for general help',
    icon: 'iconWrench',
    featured: true,
    status: 'stub',
  },
  {
    slug: 'help-account',
    label: 'Google/Account Help',
    description: 'Get help with Google or school account access',
    icon: 'iconKeyRound',
    featured: true,
    status: 'stub',
  },
];

export function formHref(slug: string): string {
  return `/form/${slug}`;
}

export function featuredForms(): FormEntry[] {
  return forms.filter((f) => f.featured);
}
