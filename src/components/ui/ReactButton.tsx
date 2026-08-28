import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { uiClassNames } from './dom';
import type { ButtonVariant, ComponentSize } from './types';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ComponentSize;
};

export function ReactButton({
  children,
  variant = 'primary',
  size = 'default',
  className,
  type = 'button',
  ...rest
}: Props) {
  return (
    <button type={type} className={uiClassNames.button(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
