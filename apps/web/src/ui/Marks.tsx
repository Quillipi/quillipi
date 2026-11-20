/**
 * One set of marks, the same everywhere: a dot for uncommitted work, ✦ for an AI's change, faces
 * for who did something, and the backup's state in plain words. Each has a text equivalent for
 * screen readers, so colour and shape are never the only cue.
 */
import { type BackupState, formatAgo } from '@inklog/core';
import { Cloud, CloudAlert, CloudOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';

/** ✦: an AI did this. Drawn, not typed, so it looks the same in every font. */
export function AgentMark({ className, label = 'An AI changed it' }: { className?: string; label?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 text-agent-mark dark:text-[#ff9f5a]', className)} title={label}>
      <svg viewBox="0 0 16 16" className="size-[0.9em]" fill="currentColor" aria-hidden="true">
        <path d="M8 0c.5 4.4 3.6 7.5 8 8-4.4.5-7.5 3.6-8 8-.5-4.4-3.6-7.5-8-8 4.4-.5 7.5-3.6 8-8z" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A dot: uncommitted work. */
export function WetDot({ count, className }: { count?: number; className?: string }) {
  const label = count ? `${count} uncommitted` : 'Uncommitted';
  return (
    <span className={cn('inline-block size-1.5 shrink-0 rounded-full bg-brand dark:bg-[#a48fff]', className)} title={label}>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A section's marks together: ✦ when an AI changed it, then the dot. */
export function ChangeMarks({ count, agent, className }: { count: number; agent: boolean; className?: string }) {
  if (!count) return null;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {agent && <AgentMark label="An AI changed it; not committed yet" />}
      <WetDot count={count} />
    </span>
  );
}

const BACKUP_ICON = { off: CloudOff, making: RefreshCw, importing: RefreshCw, pushing: RefreshCw, 'backed-up': Cloud, retrying: CloudAlert, stopped: CloudAlert } as const;

/** How the backup to GitHub stands: its icon, its sentence, and when GitHub last confirmed a commit. */
export function BackupLine({ backup, className }: { backup: BackupState; className?: string }) {
  const trouble = backup.state === 'retrying' || backup.state === 'stopped';
  const busy = backup.state === 'pushing' || backup.state === 'making' || backup.state === 'importing';
  const Shape = BACKUP_ICON[backup.state];
  return (
    <p className={cn('flex items-center gap-1.5 text-[12.5px] text-muted-foreground', trouble && 'text-removed', className)} role="status">
      <Shape className={cn('size-3.5 shrink-0', busy && 'animate-spin-slow')} aria-hidden="true" />
      <span className="min-w-0">{backup.state === 'backed-up' && backup.at ? `Backed up to GitHub, ${formatAgo(backup.at, Date.now())}` : backup.text}</span>
    </p>
  );
}

/** A time as "2h ago", with the exact date and time on hover and for screen readers. */
export function Ago({ at }: { at: number }) {
  const date = new Date(at);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {formatAgo(at, Date.now())}
    </time>
  );
}

/** Who did something: a person, or an AI in orange with its mark. */
export function Who({ name, agent, className }: { name: string; agent: boolean; className?: string }) {
  return agent ? (
    <span className={cn('inline-flex items-center gap-1 text-agent', className)}>
      <AgentMark label="An AI" />
      {name}
    </span>
  ) : (
    <span className={className}>{name}</span>
  );
}

/**
 * A round face: a person by their GitHub picture when their login is known (falling back to their
 * initial), anyone else by their initial, an AI by its mark on orange.
 */
export function Face({ name, agent = false, login, size = 26, className }: { name: string; agent?: boolean; login?: string; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (agent) {
    return (
      <span className={cn('grid shrink-0 place-items-center rounded-full bg-linear-to-br from-[#ffb072] to-[#f0661a] text-white ring-2 ring-background', className)} style={style} title={name} aria-hidden="true">
        <svg viewBox="0 0 16 16" className="size-[52%]" fill="currentColor">
          <path d="M8 0c.5 4.4 3.6 7.5 8 8-4.4.5-7.5 3.6-8 8-.5-4.4-3.6-7.5-8-8 4.4-.5 7.5-3.6 8-8z" />
        </svg>
      </span>
    );
  }
  return (
    <span className={cn('grid shrink-0 place-items-center overflow-hidden rounded-full bg-linear-to-br from-[#b9a8f5] to-[#7c5cf5] font-semibold text-white ring-2 ring-background', className)} style={style} title={name} aria-hidden="true">
      {login && !broken ? (
        <img className="size-full object-cover" src={`https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=96`} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        name.trim().charAt(0).toUpperCase() || '?'
      )}
    </span>
  );
}

/** A small pill that says a state in words, such as "3 uncommitted". */
export function Pill({ tone = 'plain', children, className }: { tone?: 'plain' | 'wet' | 'agent' | 'good' | 'trouble'; children: React.ReactNode; className?: string }) {
  const tones = {
    plain: 'bg-secondary text-muted-foreground',
    wet: 'bg-brand-soft text-brand',
    agent: 'bg-agent-soft text-agent',
    good: 'bg-added/10 text-added',
    trouble: 'bg-removed/10 text-removed',
  };
  return <span className={cn('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

/** A keyboard key, as on the search boxes. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex h-5.5 shrink-0 items-center rounded-md border border-border bg-muted px-1.5 font-sans text-[11px] font-medium text-muted-foreground touch:hidden', className)}>{children}</kbd>;
}
