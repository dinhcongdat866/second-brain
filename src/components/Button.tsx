import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
type Size    = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Stretches to container width and left-aligns content. */
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    className = '',
    type = 'button',
    children,
    ...rest
  },
  ref,
) {
  const cls = [
    'nb-btn',
    `nb-btn--${variant}`,
    `nb-btn--${size}`,
    fullWidth ? 'nb-btn--full' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {children}
    </button>
  );
});
