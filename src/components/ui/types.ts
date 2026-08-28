export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'glass' | 'ghost' | 'danger';
export type ComponentSize = 'small' | 'default' | 'large';
export type BadgeTone = 'normal' | 'warning' | 'info' | 'error';
export type FeedbackTone = 'success' | 'warning' | 'info' | 'error' | 'loading';
export type MenuTone = 'green' | 'yellow' | 'blue' | 'red' | 'charcoal';

export type BadgeItem = {
  label: string;
  tone?: BadgeTone;
};

export type MediaImage = {
  src: string;
  alt: string;
};

export type SelectOption = {
  label: string;
  value: string;
  disabled?: boolean;
};

export type ChoiceOption = SelectOption & {
  description?: string;
};

export type ChipOption = SelectOption;

export type SegmentedOption = SelectOption & {
  icon?: string;
};

export type MenuItem = {
  label: string;
  value: string;
  icon?: string;
  tone?: MenuTone;
  href?: string;
  disabled?: boolean;
};

export type MenuGroup = {
  label?: string;
  items: MenuItem[];
};
