/**
 * Home's Get started card, for a new Quillipi: in a copy, turn on updates; then connect Claude and
 * make the first notebook. Each step ticks itself (the copy's build finds the update workflow;
 * Claude's first connection is noted by the cloud and comes in live; a notebook is any card that
 * isn't archived), and the card goes once every step is done. The steps are drawn like the setup's,
 * so the newcomer carries on the same way.
 */
import type { Updates } from '@inklog/core';
import { Check, Copy, ExternalLink, LoaderCircle, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
// The copy's update check, word for word: the one file a newcomer adds by hand.
import workflow from '../../../../deploy/.github/workflows/update.yml?raw';
import { api } from '../api';
import { ConnectClaude } from '../components/ConnectClaude';
import { cn } from '../lib/cn';
import type { GetStarted as Progress } from '../news';
import { useShelf } from '../store';
import { Button, ButtonLink } from '../ui/Button';
import { CopyLine } from './Overview';

/** Where a copy keeps its update check (deploy/build.mjs looks for it there). */
const WORKFLOW_PATH = '.github/workflows/update.yml';

export function GetStarted({ progress, updates, alone }: { progress: Progress; updates?: Updates; alone: boolean }) {
  const steps: { key: string; title: string; done: boolean; summary: string; body: ReactNode }[] = [];
  if (updates && progress.updates !== undefined) {
    steps.push({
      key: 'updates',
      title: 'Turn on updates',
      done: progress.updates,
      summary: `Updates are on. When a new Quillipi is out, an issue in ${updates.repository} says what's new.`,
      body: <TurnOnUpdates repository={updates.repository} />,
    });
  }
  steps.push(
    {
      key: 'claude',
      title: 'Connect Claude',
      done: progress.claude,
      summary: 'Claude is connected. It reads and writes your notebooks from any chat.',
      body: (
        <>
          <p className="mb-3.5 text-[13.5px] leading-relaxed text-muted-foreground">Claude then keeps your notebooks with you in every chat, on the phone too, and every change it makes is a commit you can see.</p>
          <ConnectClaude />
        </>
      ),
    },
    {
      key: 'notebook',
      title: 'Make your first notebook',
      done: progress.notebook,
      summary: 'You have a notebook.',
      body: (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button variant="primary" onClick={() => useShelf.getState().setCreating(true)}>
              <Plus className="size-4" strokeWidth={2.2} aria-hidden="true" /> New notebook
            </Button>
            <span className="text-[13.5px] text-muted-foreground">or say to Claude in any chat:</span>
          </div>
          <CopyLine text="Make a Quillipi notebook called Gym rollup, and write a plan in it." className="mt-3" />
        </>
      ),
    },
  );
  const current = steps.find((step) => !step.done)?.key;

  return (
    <section aria-labelledby="get-started" className={cn('w-full rounded-2xl border border-border bg-background p-6 shadow-[0_1px_2px_rgb(27_24_38/4%)] max-md:p-4', alone && 'mx-auto max-w-[820px]')}>
      <div className="mb-5 flex items-center gap-4">
        <h2 id="get-started" className="flex-1 text-[17px] font-semibold tracking-[-0.015em]">
          Get started
        </h2>
        <span className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
          <span className="flex gap-1" aria-hidden="true">
            {steps.map((step, index) => (
              <span key={step.key} className={cn('h-1.5 w-6 rounded-full', index < progress.done ? 'bg-brand' : 'bg-secondary')} />
            ))}
          </span>
          {progress.done} of {progress.total}
        </span>
      </div>
      <ol>
        {steps.map((step, index) => (
          <Item key={step.key} n={index + 1} title={step.title} done={step.done} current={current === step.key} summary={step.summary} last={index === steps.length - 1}>
            {step.body}
          </Item>
        ))}
      </ol>
    </section>
  );
}

/** How long to keep asking after the owner opens GitHub: a commit, then Cloudflare's build and deploy. */
const WAIT_MS = 15 * 60_000;
const ASK_EVERY_MS = 10_000;

/**
 * Turn on updates: Cloudflare's GitHub app can't add workflow files to the copy it makes, so the
 * owner adds the one file. GitHub's new-file page opens with its name and text filled in; the
 * commit makes Cloudflare build the copy again, the build finds the file, and this step ticks.
 */
function TurnOnUpdates({ repository }: { repository: string }) {
  const [waiting, setWaiting] = useState(false);
  const href = `https://github.com/${repository}/new/main?filename=${encodeURIComponent(WORKFLOW_PATH)}&value=${encodeURIComponent(workflow)}`;

  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + WAIT_MS;
    const timer = setInterval(() => {
      if (Date.now() > until) return setWaiting(false);
      api
        .updates()
        .then(({ updates }) => {
          if (updates?.on) useShelf.getState().setUpdates(updates);
        })
        // A deploy in progress can fail a request; the next one tries again.
        .catch(() => {});
    }, ASK_EVERY_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  return (
    <>
      <p className="mb-3.5 text-[13.5px] leading-relaxed text-muted-foreground">
        Once a week your Quillipi's repository looks for a new release and opens an issue there when one is out, saying what's new; one click then updates it. GitHub needs one file for that, which Cloudflare couldn't add for you.
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ButtonLink variant="primary" href={href} target="_blank" rel="noopener noreferrer" onClick={() => setWaiting(true)}>
          Add the file on GitHub <ExternalLink className="size-3.5" aria-hidden="true" />
        </ButtonLink>
        {waiting && (
          <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground" role="status">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> Waiting for Cloudflare to deploy your commit…
          </span>
        )}
      </div>
      <p className="mt-3 text-[13.5px] leading-relaxed text-foreground/85 [&_b]:font-semibold [&_b]:text-foreground">
        GitHub opens with the file filled in. Press <b>Commit changes…</b>, then <b>Commit changes</b>. Cloudflare then deploys your Quillipi again, and in a minute or two this step ticks itself.
      </p>
      <details className="group mt-3 text-[13px] text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">GitHub says the page isn't found?</summary>
        <div className="mt-2 leading-relaxed [&_b]:font-semibold [&_b]:text-foreground">
          <p>
            Your repository may have another name than <b>{repository}</b>. Open it on GitHub, choose <b>Add file</b>, then <b>Create new file</b>, and name it:
          </p>
          <CopyLine text={WORKFLOW_PATH} className="my-2" />
          <p className="mb-2">Paste the file's text, then commit it.</p>
          <CopyText text={workflow} label="Copy the file's text" />
        </div>
      </details>
    </>
  );
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check className="size-3.5 text-added" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

function Item({ n, title, done, current, summary, last, children }: { n: number; title: string; done: boolean; current: boolean; summary: string; last: boolean; children: ReactNode }) {
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
        {done ? <Check className="size-3.5" strokeWidth={3} /> : n}
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
