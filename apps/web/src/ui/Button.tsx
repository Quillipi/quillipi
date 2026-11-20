/**
 * Quillipi's button, in the few kinds the app uses. `primary` is the page's main action, in the
 * accent; `outline` and `soft` are the actions beside it; `ghost` is for toolbars and rows.
 * On a touch screen every button is at least 44 px tall.
 */
import { type VariantProps, cva } from 'class-variance-authority';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '../lib/cn';

export const buttonStyles = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-[background-color,color,box-shadow,border-color,transform] duration-150 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white shadow-primary hover:bg-brand-strong',
        outline: 'border border-input bg-background text-foreground shadow-[0_1px_2px_rgb(27_24_38/5%)] hover:bg-muted',
        soft: 'bg-brand-soft text-brand hover:bg-brand-tint',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground',
        danger: 'bg-removed text-white hover:brightness-95',
        link: 'h-auto rounded-sm px-0 text-brand underline-offset-4 hover:underline',
      },
      size: {
        md: 'h-9 rounded-xl px-3.5 text-[13.5px] touch:min-h-11',
        sm: 'h-8 rounded-[10px] px-2.5 text-[13px] touch:min-h-11',
        icon: 'size-9 rounded-xl touch:size-11',
        'icon-sm': 'size-7 rounded-lg touch:size-11',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

type Styles = VariantProps<typeof buttonStyles>;

export function Button({ variant, size, className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & Styles & { ref?: Ref<HTMLButtonElement> }) {
  return <button type={type} className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

/** A link that looks like a button, for actions that go somewhere. */
export function ButtonLink({ variant, size, className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & Styles) {
  return <a className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}
