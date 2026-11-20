/**
 * A modal dialog, on Radix: focus stays inside it, the page behind it can't be used, Escape or a
 * press outside closes it, and focus goes back to where it was. On a phone it is a sheet that
 * rises from the bottom edge.
 */
import { X } from 'lucide-react';
import { Dialog as Radix } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Dialog({ title, description, onClose, children, className }: { title: string; description?: ReactNode; onClose(): void; children: ReactNode; className?: string }) {
  return (
    <Radix.Root open onOpenChange={(open) => !open && onClose()}>
      <Radix.Portal>
        <Radix.Overlay className="fixed inset-0 z-50 animate-fade bg-[#14111b]/45 backdrop-blur-[2px]" />
        <Radix.Content
          aria-describedby={undefined}
          className={cn(
            'fixed z-50 flex max-h-[calc(100dvh-32px)] w-[min(460px,calc(100vw-32px))] flex-col overflow-hidden rounded-[22px] bg-background shadow-pop outline-none',
            'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pop',
            'max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:animate-sheet max-sm:rounded-b-none',
            className,
          )}
        >
          <header className="flex items-start gap-3 px-6 pt-5 pb-1">
            <div className="min-w-0 flex-1">
              <Radix.Title className="text-[17px] leading-snug font-semibold tracking-[-0.015em]">{title}</Radix.Title>
              {description && <p className="mt-1 text-[13.5px] text-muted-foreground">{description}</p>}
            </div>
            <Radix.Close aria-label="Close" className="-mt-1 -mr-2 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground touch:size-11">
              <X className="size-4" />
            </Radix.Close>
          </header>
          <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-6 max-sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]">{children}</div>
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}

/** The row of buttons at a dialog's foot, the main one last. */
export function DialogActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-6 flex items-center justify-end gap-2', className)}>{children}</div>;
}

/** A labelled field in a dialog's form. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2 text-[13px] font-medium">
        {label}
        {hint && <span className="font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const inputStyles =
  'h-10 w-full rounded-xl border border-input bg-background px-3 text-[14px] outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-brand focus:ring-[3px] focus:ring-brand/15 touch:h-11 touch:text-[16px]';
