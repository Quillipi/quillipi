/**
 * A small label that names a button when the pointer rests on it or it takes focus. A phone or
 * tablet can't rest a pointer on anything: there a tap would show the label and leave it over the
 * page, so it has none. Every button also has its name for screen readers (aria-label).
 */
import { Tooltip as Radix } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = Radix.Provider;

const NO_HOVER = typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches;

export function Tooltip({ label, keys, side = 'bottom', children }: { label: ReactNode; keys?: string; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactNode }) {
  if (NO_HOVER) return children;
  return (
    <Radix.Root>
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          side={side}
          sideOffset={7}
          collisionPadding={8}
          className="z-[70] flex animate-fade items-center gap-2 rounded-lg bg-[#1b1826] px-2.5 py-1.5 text-[12px] font-medium text-white shadow-pop select-none"
        >
          {label}
          {keys && <kbd className="font-sans text-[11px] text-white/55">{keys}</kbd>}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
