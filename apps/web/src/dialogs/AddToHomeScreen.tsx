/**
 * How to install Quillipi on an iPhone or iPad, which offer no Install button: it is added from the
 * Share menu, in Safari and in the other browsers there.
 */
import { Share, SquarePlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Dialog, DialogActions } from '../ui/Dialog';

export function AddToHomeScreen({ onClose }: { onClose(): void }) {
  return (
    <Dialog title="Add Quillipi to your Home Screen" description="Then it opens in one tap, like any app." onClose={onClose}>
      <ol className="flex flex-col gap-3 text-[14px]">
        <Step number={1}>
          Tap <Icon label="Share">{<Share />}</Icon> in the browser’s toolbar.
        </Step>
        <Step number={2}>
          Choose <Icon label="">{<SquarePlus />}</Icon> <strong className="font-semibold">Add to Home Screen</strong>. If it isn’t there, scroll the list down.
        </Step>
        <Step number={3}>
          Tap <strong className="font-semibold">Add</strong>.
        </Step>
      </ol>
      <DialogActions>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-3">
      <span className="grid size-6 shrink-0 translate-y-[-1px] place-items-center rounded-full bg-brand-soft text-[12.5px] font-semibold text-brand" aria-hidden="true">
        {number}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}

/** An icon as the browser draws it, inline in the words; `label` is what a screen reader says instead. */
function Icon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-grid size-6 translate-y-[5px] place-items-center rounded-md bg-muted text-foreground [&_svg]:size-4" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
      {children}
    </span>
  );
}
