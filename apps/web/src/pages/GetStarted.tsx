/**
 * Home's Get started card, for a new Quillipi: connect Claude, then make the first notebook. Each
 * step ticks itself (Claude's first connection is noted by the cloud and comes in live; a notebook
 * is any card that isn't archived), and the card goes once both are done. The steps are drawn like
 * the setup's, so the newcomer carries on the same way.
 */
import { Check, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConnectClaude } from '../components/ConnectClaude';
import { cn } from '../lib/cn';
import type { GetStarted as Progress } from '../news';
import { useShelf } from '../store';
import { Button } from '../ui/Button';
import { CopyLine } from './Overview';

export function GetStarted({ progress, alone }: { progress: Progress; alone: boolean }) {
  const first = !progress.claude ? 'claude' : 'notebook';
  return (
    <section aria-labelledby="get-started" className={cn('w-full rounded-2xl border border-border bg-background p-6 shadow-[0_1px_2px_rgb(27_24_38/4%)] max-md:p-4', alone && 'mx-auto max-w-[820px]')}>
      <div className="mb-5 flex items-center gap-4">
        <h2 id="get-started" className="flex-1 text-[17px] font-semibold tracking-[-0.015em]">
          Get started
        </h2>
        <span className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
          <span className="flex gap-1" aria-hidden="true">
            {[0, 1].map((index) => (
              <span key={index} className={cn('h-1.5 w-6 rounded-full', index < progress.done ? 'bg-brand' : 'bg-secondary')} />
            ))}
          </span>
          {progress.done} of 2
        </span>
      </div>
      <ol>
        <Item title="Connect Claude" done={progress.claude} current={first === 'claude'} summary="Claude is connected. It reads and writes your notebooks from any chat." last={false}>
          <p className="mb-3.5 text-[13.5px] leading-relaxed text-muted-foreground">Claude then keeps your notebooks with you in every chat, on the phone too, and every change it makes is a commit you can see.</p>
          <ConnectClaude />
        </Item>
        <Item title="Make your first notebook" done={progress.notebook} current={first === 'notebook'} summary="You have a notebook." last>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button variant="primary" onClick={() => useShelf.getState().setCreating(true)}>
              <Plus className="size-4" strokeWidth={2.2} aria-hidden="true" /> New notebook
            </Button>
            <span className="text-[13.5px] text-muted-foreground">or say to Claude in any chat:</span>
          </div>
          <CopyLine text="Make a Quillipi notebook called Gym rollup, and write a plan in it." className="mt-3" />
        </Item>
      </ol>
    </section>
  );
}

function Item({ title, done, current, summary, last, children }: { title: string; done: boolean; current: boolean; summary: string; last: boolean; children: ReactNode }) {
  return (
    <li className="relative flex gap-3.5" aria-current={current ? 'step' : undefined}>
      {!last && <span className={cn('absolute top-8 bottom-1 left-[13px] w-0.5 rounded-full', done ? 'bg-brand/35' : 'bg-border')} aria-hidden="true" />}
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full border-2 text-[13px] font-semibold',
          done ? 'border-brand bg-brand text-white' : current ? 'border-brand bg-brand-soft text-brand ring-4 ring-brand/12' : 'border-input text-muted-foreground',
        )}
        aria-hidden="true"
      >
        {done ? <Check className="size-3.5" strokeWidth={3} /> : last ? 2 : 1}
      </span>
      <div className={cn('min-w-0 flex-1 pt-[3px]', !last && 'pb-6')}>
        <h3 className={cn('text-[15px] leading-snug font-semibold', !done && !current && 'text-muted-foreground')}>
          {title}
          <span className="sr-only"> ({done ? 'done' : current ? 'now' : 'next'})</span>
        </h3>
        {done ? <p className="mt-0.5 text-[13px] text-muted-foreground">{summary}</p> : <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}
