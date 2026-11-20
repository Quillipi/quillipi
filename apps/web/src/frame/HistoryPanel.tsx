/**
 * The History panel, on the right of every page in a notebook (step 3.4c). Top to bottom:
 *
 * - Waiting for you: changes an AI wants to commit that need your approval, such as big deletions.
 * - Now: the uncommitted changes by section, each with its kind and who made it. A tick includes
 *   or leaves out a section or a single change; pressing a change shows it in the text. Under
 *   them, the message and Commit.
 * - The history, newest first: every commit with its time, its message, who made it and its
 *   number. Its node's shape says who (a dot for you, a diamond for an AI) and its fill says
 *   whether GitHub has it yet. A commit opens in place: what it touched, and View this version,
 *   Compare with now, Undo this commit, Copy ID and View on GitHub.
 *
 * It is beside the page on a wide screen, a drawer from the right on a narrower one and a sheet
 * from the bottom on a phone. Ctrl+Enter anywhere opens it with the caret in the message.
 */
import { type Block, type CommitDetails, type CommitSummary, INSTRUCTIONS_CHANGE, LAYOUT_CHANGE, type PendingChange, type RepoInfo, formatAgo, inlineToPlain } from '@inklog/core';
import { ArrowLeftRight, ArrowUpDown, Check, ChevronRight, ChevronsRight, Copy, Eye, FileText, ExternalLink, FolderTree, type LucideIcon, Minus, PenLine, Plus, Search, Settings2, Sparkles, Undo2, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { cn } from '../lib/cn';
import { plural } from '../news';
import { folderName } from './NotebookTree';
import { navigate, useRoute } from '../router';
import { useApp, useShelf } from '../store';
import { Button } from '../ui/Button';
import { AgentMark, BackupLine, Face, Pill } from '../ui/Marks';
import { Drop } from '../ui/NotebookTile';
import { Tooltip } from '../ui/Tooltip';

type Filter = 'all' | 'mine' | 'ai' | 'section';

const KINDS: Record<PendingChange['change'], { label: string; icon: LucideIcon; colour: string }> = {
  added: { label: 'added', icon: Plus, colour: 'text-added' },
  modified: { label: 'edited', icon: PenLine, colour: 'text-edited' },
  moved: { label: 'moved', icon: ArrowUpDown, colour: 'text-moved' },
  removed: { label: 'removed', icon: Minus, colour: 'text-removed' },
};

/** How many commits the history shows before "Show older". */
const PAGE = 60;

export function HistoryPanel() {
  const open = useApp((state) => state.historyOpen);
  const info = useApp((state) => state.info);
  const close = () => useApp.getState().setHistoryOpen(false);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      // Ctrl+Enter: commit. The panel opens with the caret in the message.
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !(event.target as HTMLElement).closest('[data-commit-message]')) {
        event.preventDefault();
        useApp.getState().setHistoryOpen(true, true);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  // Over the page (a narrow screen), the panel has done its job once you have gone somewhere.
  const route = useRoute();
  useEffect(() => {
    if (matchMedia('(max-width: 1023.98px)').matches) useApp.getState().setHistoryOpen(false);
  }, [route]);

  if (!open || !info) return null;
  return (
    <>
      <div className="absolute inset-0 z-30 animate-fade bg-[#14111b]/40 lg:hidden" aria-hidden="true" onClick={close} />
      <aside
        aria-label="History"
        className={cn(
          'z-40 flex w-[352px] shrink-0 flex-col border-l border-border bg-[#fbfafd]',
          'max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:max-w-[92vw] max-lg:shadow-pop',
          'max-md:inset-x-0 max-md:top-auto max-md:h-[min(80dvh,calc(100%-56px))] max-md:w-full max-md:max-w-none max-md:animate-sheet max-md:rounded-t-[22px] max-md:border-l-0',
        )}
      >
        <Panel info={info} onClose={close} />
      </aside>
    </>
  );
}

function Panel({ info, onClose }: { info: RepoInfo; onClose(): void }) {
  const route = useRoute();
  const notebook = useApp((state) => state.notebook)!;
  const viewing = useApp((state) => state.viewing);
  const compareWith = useApp((state) => state.compareWith);
  const github = useShelf((state) => state.me?.github);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState('');
  const section = route.page === 'section' ? route.section : undefined;
  const shown = info.commits.find((commit) => commit.oid === (viewing ?? compareWith));

  useEffect(() => {
    if (filter === 'section' && !section) setFilter('all');
  }, [filter, section]);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
        <h2 className="flex-1 text-[15px] font-semibold tracking-[-0.01em]">History</h2>
        <Tooltip label="Search the commit messages">
          <button type="button" aria-label="Search the commit messages" aria-pressed={searching} className={ICON_BUTTON} onClick={() => (setSearching(!searching), setQuery(''))}>
            <Search className="size-4" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Hide History">
          <button type="button" aria-label="Hide History" className={ICON_BUTTON} onClick={onClose}>
            <ChevronsRight className="size-4 max-md:hidden" aria-hidden="true" />
            <X className="size-4 md:hidden" aria-hidden="true" />
          </button>
        </Tooltip>
      </header>

      {shown && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-xl border border-brand-tint bg-brand-soft py-1.5 pr-1.5 pl-3 text-[12.5px]">
          <Eye className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {viewing ? 'Showing' : 'Comparing with'} <strong className="font-semibold">#{shown.number}</strong>
          </span>
          <Button
            size="sm"
            variant="primary"
            className="h-7 rounded-lg px-2.5 text-[12px]"
            onClick={() => {
              useApp.getState().viewCommit(undefined);
              useApp.getState().compare(undefined);
            }}
          >
            Back to now
          </Button>
        </div>
      )}

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-4" data-history-scroll>
        {info.held.length > 0 && <Waiting info={info} />}
        <Now info={info} notebook={notebook} message={message} setMessage={setMessage} />

        <div className="mt-5 mb-1 flex items-center gap-1">
          {searching ? (
            <label className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-muted-foreground focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/15">
              <Search className="size-3.5 shrink-0" aria-hidden="true" />
              <input
                autoFocus
                type="search"
                value={query}
                placeholder="Search messages, or #12"
                aria-label="Search the commit messages"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Escape' && (setSearching(false), setQuery(''))}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint touch:text-[16px]"
              />
            </label>
          ) : (
            <div role="radiogroup" aria-label="Which commits" className="flex min-w-0 flex-1 gap-0.5 rounded-[10px] bg-secondary p-0.5">
              {(
                [
                  ['all', 'All'],
                  ['mine', 'Mine'],
                  ['ai', 'AI'],
                  ...(section ? ([['section', 'This section']] as const) : []),
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={filter === value}
                  onClick={() => setFilter(value)}
                  className="h-7 min-w-0 flex-1 truncate rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-tile touch:h-9"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <Timeline
          info={info}
          notebook={notebook}
          filter={filter}
          query={query}
          section={section}
          onUndone={(commit) => !message.trim() && setMessage(`Undo #${commit.number}: ${commit.message}`)}
        />
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
        {info.backup ? <BackupLine backup={info.backup} className="min-w-0 flex-1" /> : <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">History is real Git, in this notebook’s folder.</p>}
        {info.backup && github && (
          <a className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" href={`https://github.com/${github}/${notebook}`} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-3.5" aria-hidden="true" />
            GitHub
          </a>
        )}
      </footer>
    </>
  );
}

const ICON_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-brand-soft aria-pressed:text-brand touch:size-10';

/** A name for a pending change's group: its section, or what it stands for when it has none. */
function groupOf(change: PendingChange): string {
  return change.section || ` ${change.key}`;
}

function useTitles(info: RepoInfo) {
  return useMemo(() => {
    const sections = new Map(info.sections.map((section) => [section.id, section]));
    return {
      title: (group: string) => (group === ` ${INSTRUCTIONS_CHANGE.key}` ? 'AI instructions' : group === ` ${LAYOUT_CHANGE.key}` || group.trim() === '' ? 'Folders and order' : (sections.get(group)?.title ?? group)),
      folder: (group: string) => {
        const path = sections.get(group)?.folder ?? '';
        return path ? folderName(info.tree, path) : '';
      },
    };
  }, [info.sections, info.tree]);
}

/** Changes an AI wants to commit that wait for the person: what they are, Approve and commit, or Undo. */
function Waiting({ info }: { info: RepoInfo }) {
  const { title } = useTitles(info);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = (index: number, approve: boolean) => {
    setBusy(true);
    api
      .resolveHeld(index, approve)
      .then(() => setError(undefined), (failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <section aria-label="Waiting for you" className="mb-3" id="history-waiting">
      <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wider text-agent uppercase">
        Waiting for you
        <span className="rounded-full bg-agent-soft px-1.5 text-[11px]">{info.held.length}</span>
      </h3>
      <div className="flex flex-col gap-2">
        {info.held.map((held, index) => (
          <article key={`${held.section}-${held.at}`} className="rounded-2xl border border-agent-mark/25 bg-agent-soft/60 p-3">
            <p className="flex items-start gap-2 text-[13px] leading-snug">
              <Face name={held.agent} agent size={22} className="mt-px ring-0" />
              <span>
                <strong className="font-semibold text-agent">{held.agent}</strong> wants to commit “{held.message}” in {title(held.section)}.
              </span>
            </p>
            <p className="mt-1.5 pl-[30px] text-[12.5px] leading-snug text-muted-foreground">It {held.reasons.join('; ')}.</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5 pl-[30px]">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => run(index, true)}>
                Approve and commit
              </Button>
              <Button size="sm" disabled={busy} onClick={() => run(index, false)}>
                Undo
              </Button>
            </div>
          </article>
        ))}
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </section>
  );
}

/** The uncommitted changes, by section, with ticks, the message and Commit. */
function Now({ info, notebook, message, setMessage }: { info: RepoInfo; notebook: string; message: string; setMessage(message: string): void }) {
  const { title, folder } = useTitles(info);
  const focus = useApp((state) => state.commitFocus);
  const box = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string[]>([]);
  const changes = info.pending.filter((change) => !change.held);
  const included = changes.filter((change) => change.included).length;

  // In the notebook's order, with the changes that have no section of their own last.
  const groups = useMemo(() => {
    const found = new Map<string, PendingChange[]>();
    for (const change of changes) found.set(groupOf(change), [...(found.get(groupOf(change)) ?? []), change]);
    const order = new Map(info.sections.map((section, index) => [section.id, index]));
    return [...found].sort(([a], [b]) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6));
  }, [info.pending, info.sections]);

  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setError(undefined);
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (included && (await run(() => api.commit(message)))) setMessage('');
  };
  const include = (list: PendingChange[], value: boolean) =>
    void run(async () => {
      for (const change of list) if (change.included !== value) await api.include(change.section, change.key, value);
    });
  const draft = groups.length ? `Update ${groups.filter(([, list]) => list.some((change) => change.included)).map(([group]) => title(group)).slice(0, 3).join(', ')}` : '';

  return (
    <section aria-label="Now" className="rounded-2xl border border-border bg-background shadow-[0_1px_2px_rgb(27_24_38/4%)]">
      <header className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
        <Drop size={16} className={cn(!changes.length && 'opacity-40 grayscale')} />
        <h3 className="flex-1 text-[13.5px] font-semibold">Now</h3>
        {changes.length ? <Pill tone="wet">{plural(changes.length, 'uncommitted change')}</Pill> : null}
      </header>

      {!changes.length ? (
        <p className="flex items-center gap-1.5 px-3.5 pb-3.5 text-[13px] text-muted-foreground">
          <Check className="size-3.5 text-added" aria-hidden="true" />
          Everything is committed.
        </p>
      ) : (
        <>
          <ul className="px-1.5 pb-1">
            {groups.map(([group, list]) => {
              const on = list.filter((change) => change.included).length;
              const isOpen = expanded.includes(group);
              const real = !group.startsWith(' ');
              return (
                <li key={group}>
                  <div className="flex min-h-9 items-center gap-1 rounded-lg pr-2 pl-1 hover:bg-muted">
                    <Tick checked={on === list.length} mixed={on > 0 && on < list.length} disabled={busy} label={`Include ${title(group)} in the commit`} onChange={(value) => include(list, value)} />
                    <button
                      type="button"
                      aria-expanded={real ? isOpen : undefined}
                      onClick={() => real && setExpanded(isOpen ? expanded.filter((other) => other !== group) : [...expanded, group])}
                      className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring', !real && 'cursor-default')}
                    >
                      {real ? <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : group === ` ${INSTRUCTIONS_CHANGE.key}` ? <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <FolderTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                      <span className="min-w-0 truncate font-medium">{title(group)}</span>
                      {folder(group) && <span className="max-w-[30%] shrink-0 truncate text-[12px] text-faint">{folder(group)}</span>}
                      {list.some((change) => change.by.includes('agent')) && <AgentMark label="An AI made some of these" className="text-[11px]" />}
                    </button>
                    {real && <Counts counts={countKinds(list)} />}
                    {real && <ChevronRight className={cn('size-3.5 shrink-0 text-faint transition-transform', isOpen && 'rotate-90')} aria-hidden="true" />}
                  </div>
                  {real && isOpen && <SectionChanges notebook={notebook} section={group} changes={list} busy={busy} onInclude={(change, value) => include([change], value)} />}
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border p-2.5">
            <textarea
              ref={box}
              data-commit-message
              rows={2}
              value={message}
              placeholder={draft || 'What changed, and why'}
              aria-label="Commit message"
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void commit();
                }
              }}
              className="block w-full resize-none rounded-xl border border-input bg-background px-3 py-2 text-[13.5px] leading-snug outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-brand focus:ring-[3px] focus:ring-brand/15 touch:text-[16px]"
            />
            <Button variant="primary" className="mt-2 w-full" disabled={busy || !included} onClick={() => void commit()}>
              {included ? `Commit ${plural(included, 'change')}` : 'Nothing is ticked'}
              {included > 0 && <kbd className="ml-1 font-sans text-[11.5px] font-normal text-white/70 touch:hidden">Ctrl ↵</kbd>}
            </Button>
          </div>
        </>
      )}
      {error && <ErrorLine className="px-3.5 pb-3">{error}</ErrorLine>}
    </section>
  );
}

/** One section's changes, each with its kind, its first words and who made it. Pressing one shows it in the text. */
function SectionChanges({ notebook, section, changes, busy, onInclude }: { notebook: string; section: string; changes: PendingChange[]; busy: boolean; onInclude(change: PendingChange, included: boolean): void }) {
  const [blocks, setBlocks] = useState<Map<string, Block>>();
  const keys = changes.map((change) => change.key).join(' ');

  useEffect(() => {
    let current = true;
    void api.section(section).then((data) => {
      if (!current) return;
      // A removed block is only in the last commit's text.
      setBlocks(new Map([...data.head, ...data.blocks].map((block) => [block.id, block])));
    });
    return () => {
      current = false;
    };
  }, [section, keys]);

  const show = (change: PendingChange) => {
    const id = change.key.replace(/^removed:/, '');
    useApp.getState().viewCommit(undefined);
    navigate({ page: 'section', id: notebook, section });
    window.dispatchEvent(new CustomEvent('inklog:show-block', { detail: { section, id } }));
  };

  return (
    <ul className="mb-1 ml-[15px] border-l border-border pl-1.5">
      {changes.map((change) => {
        const kind = KINDS[change.change];
        const block = blocks?.get(change.key.replace(/^removed:/, ''));
        return (
          <li key={change.key} className="flex min-h-8 items-center gap-1 rounded-lg pr-2 hover:bg-muted">
            <Tick checked={change.included} disabled={busy} label={`Include this ${kind.label} block`} onChange={(value) => onInclude(change, value)} small />
            <button type="button" onClick={() => show(change)} title="Show it in the text" className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <kind.icon className={cn('size-3.5 shrink-0', kind.colour)} strokeWidth={2.4} aria-hidden="true" />
              <span className="sr-only">{kind.label}:</span>
              <span className={cn('min-w-0 flex-1 truncate', change.change === 'removed' && 'text-muted-foreground line-through', !change.included && 'opacity-55')}>{block ? snippet(block) : kind.label}</span>
              {change.by.includes('agent') && <AgentMark label="An AI made this change" className="text-[10px]" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A block's first words, or what it is when it has none. */
function snippet(block: Block): string {
  const text = inlineToPlain(block.text).trim();
  if (text) return text;
  return { table: 'A table', canvas: 'A drawing', image: 'An image', hr: 'A divider', code: 'A code block' }[block.type as string] ?? 'An empty block';
}

function countKinds(changes: PendingChange[]): Record<PendingChange['change'], number> {
  const counts = { added: 0, modified: 0, moved: 0, removed: 0 };
  for (const change of changes) counts[change.change]++;
  return counts;
}

/** How many blocks of each kind, each kind with its own shape and colour. */
function Counts({ counts }: { counts: Record<PendingChange['change'], number> }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium tabular-nums">
      {(Object.keys(KINDS) as PendingChange['change'][]).map((key) => {
        const kind = KINDS[key];
        return counts[key] ? (
          <span key={key} className={cn('flex items-center gap-px', kind.colour)} title={`${counts[key]} ${kind.label}`}>
            <kind.icon className="size-3" strokeWidth={2.6} aria-hidden="true" />
            {counts[key]}
            <span className="sr-only"> {kind.label}</span>
          </span>
        ) : null;
      })}
    </span>
  );
}

/** A tick box that can also be half ticked, with a target big enough for a finger. */
function Tick({ checked, mixed = false, disabled, label, onChange, small = false }: { checked: boolean; mixed?: boolean; disabled?: boolean; label: string; onChange(checked: boolean): void; small?: boolean }) {
  return (
    <label className={cn('grid shrink-0 cursor-pointer place-items-center touch:size-10', small ? 'size-7' : 'size-8')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        ref={(input) => {
          if (input) input.indeterminate = mixed;
        }}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 cursor-pointer rounded-[5px] accent-brand"
      />
    </label>
  );
}

function ErrorLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn('mt-2 text-[12.5px] leading-snug text-removed', className)}>
      {children}
    </p>
  );
}

/** The commits, newest first, under day labels, with Now and anything waiting above them. */
function Timeline({ info, notebook, filter, query, section, onUndone }: { info: RepoInfo; notebook: string; filter: Filter; query: string; section?: string; onUndone(commit: CommitSummary): void }) {
  const viewing = useApp((state) => state.viewing);
  const compareWith = useApp((state) => state.compareWith);
  const [open, setOpen] = useState<string>();
  const [limit, setLimit] = useState(PAGE);
  const [inSection, setInSection] = useState<Set<string>>();
  const head = info.commits[0]?.oid;
  // The commits GitHub doesn't have yet are those newer than the last one it confirmed.
  // Only where a backup is set up: on the laptop, or with no GitHub App, there is nothing to wait for.
  const tracks = info.backup !== undefined && info.backup.state !== 'off';
  const pushedAt = tracks ? info.commits.findIndex((commit) => commit.oid === info.backup!.pushed) : 0;
  const unpushed = tracks ? (pushedAt < 0 ? info.commits.length : pushedAt) : 0;
  // Commits made while the panel is open rise in; those already there when it opened don't.
  const known = useRef(new Set(info.commits.map((commit) => commit.oid)));

  useEffect(() => {
    if (filter !== 'section' || !section) return setInSection(undefined);
    let current = true;
    void api.sectionHistory(section).then(({ commits }) => current && setInSection(new Set(commits)));
    return () => {
      current = false;
    };
  }, [filter, section, head]);

  const words = query.trim().toLowerCase();
  const rows = info.commits
    .map((commit, index) => ({ commit, onGitHub: index >= unpushed }))
    .filter(({ commit }) => (filter === 'mine' ? !commit.agent : filter === 'ai' ? Boolean(commit.agent) : filter === 'section' ? (inSection?.has(commit.oid) ?? false) : true))
    .filter(({ commit }) => !words || commit.message.toLowerCase().includes(words) || `#${commit.number}` === words || (commit.agent ?? '').toLowerCase().includes(words));
  const shown = rows.slice(0, limit);
  const now = Date.now();
  let day = '';

  return (
    <ol className="relative" aria-label="Commits, newest first">
      {filter === 'all' && !words && (
        <>
          <li className="relative grid grid-cols-[44px_20px_minmax(0,1fr)] items-center pt-2 pb-1">
            <Line kind="wet" from="middle" />
            <span className="pr-2 text-right text-[11px] font-medium text-faint">Now</span>
            <span className="relative z-10 grid place-items-center bg-[#fbfafd] py-0.5">
              <Drop size={14} className={cn(!info.pending.length && 'opacity-40 grayscale')} />
            </span>
            <span className="truncate pl-2 text-[12.5px] text-muted-foreground">{info.pending.length ? plural(info.pending.length, 'uncommitted change') : 'Nothing uncommitted'}</span>
          </li>
          {info.held.map((held) => (
            <li key={`${held.section}-${held.at}`} className="relative grid grid-cols-[44px_20px_minmax(0,1fr)] items-start py-1">
              <Line kind="wet" />
              <span />
              <span className="relative z-10 grid place-items-center bg-[#fbfafd] py-1">
                <Node agent ghost />
              </span>
              <button
                type="button"
                className="rounded-md pl-2 text-left text-[12.5px] leading-snug text-agent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => document.getElementById('history-waiting')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
              >
                {held.agent} wants to commit “{held.message}” · waits for you
              </button>
            </li>
          ))}
        </>
      )}

      {shown.map(({ commit, onGitHub }, index) => {
        const label = dayLabel(commit.at, now);
        const heading = label !== day ? label : undefined;
        day = label;
        const fresh = !known.current.has(commit.oid);
        const next = shown[index + 1];
        return (
          <li key={commit.oid} className={cn(fresh && 'animate-pop')}>
            {heading && <p className="pt-3 pb-1 pl-[64px] text-[10.5px] font-semibold tracking-wider text-faint uppercase">{heading}</p>}
            <CommitRow
              commit={commit}
              info={info}
              notebook={notebook}
              onGitHub={onGitHub}
              tracks={tracks}
              first={commit.number === 1}
              last={index === shown.length - 1 && rows.length <= limit}
              lineBelow={next ? (next.onGitHub ? 'solid' : 'dashed') : 'solid'}
              open={open === commit.oid}
              current={viewing === commit.oid || compareWith === commit.oid}
              onToggle={() => setOpen(open === commit.oid ? undefined : commit.oid)}
              onUndone={() => onUndone(commit)}
            />
          </li>
        );
      })}

      {!rows.length && <li className="py-6 text-center text-[13px] text-muted-foreground">{words ? `No commit matches “${query.trim()}”.` : filter === 'ai' ? 'No AI has committed here yet.' : filter === 'section' && !inSection ? 'Looking…' : 'No commits here.'}</li>}
      {rows.length > limit && (
        <li className="pt-2 pl-[64px]">
          <Button size="sm" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, rows.length - limit)} older
          </Button>
        </li>
      )}
    </ol>
  );
}

/** The line that joins the nodes: solid between commits GitHub has, dashed above the last it has, dotted up to Now. */
function Line({ kind, from = 'top', to = 'bottom' }: { kind: 'solid' | 'dashed' | 'wet'; from?: 'top' | 'middle'; to?: 'bottom' | 'middle' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute left-[53.5px] w-0 border-l-[1.5px]',
        from === 'top' ? 'top-0' : 'top-1/2',
        to === 'bottom' ? 'bottom-0' : 'bottom-1/2',
        kind === 'solid' ? 'border-solid' : kind === 'dashed' ? 'border-dashed' : 'border-dotted border-brand/50',
      )}
      style={kind === 'wet' ? undefined : { borderColor: 'var(--line-strong)' }}
    />
  );
}

/** A commit's node: a dot for a person, a diamond for an AI; filled once GitHub has it; dashed while it only waits for approval. */
function Node({ agent, hollow = false, ghost = false, first = false }: { agent: boolean; hollow?: boolean; ghost?: boolean; first?: boolean }) {
  const colour = agent ? 'var(--agent-mark)' : 'var(--accent)';
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      {agent ? (
        <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.6" transform="rotate(45 8 8)" fill={hollow || ghost ? '#fbfafd' : colour} stroke={colour} strokeWidth="1.6" strokeDasharray={ghost ? '2.2 1.8' : undefined} />
      ) : (
        <circle cx="8" cy="8" r="4.6" fill={hollow ? '#fbfafd' : colour} stroke={colour} strokeWidth="1.6" />
      )}
      {first && <circle cx="8" cy="8" r="1.5" fill="#fff" />}
    </svg>
  );
}

function CommitRow({
  commit,
  info,
  notebook,
  onGitHub,
  tracks,
  first,
  last,
  lineBelow,
  open,
  current,
  onToggle,
  onUndone,
}: {
  commit: CommitSummary;
  info: RepoInfo;
  notebook: string;
  onGitHub: boolean;
  /** Whether this notebook is backed up to GitHub at all. */
  tracks: boolean;
  first: boolean;
  last: boolean;
  lineBelow: 'solid' | 'dashed';
  open: boolean;
  current: boolean;
  onToggle(): void;
  onUndone(): void;
}) {
  const who = commit.agent ?? (commit.author === info.person.name ? 'You' : commit.author);
  const date = new Date(commit.at);
  const state = !tracks ? '' : onGitHub ? ', on GitHub' : ', not on GitHub yet';
  return (
    <div className="relative">
      <Line kind={onGitHub ? 'solid' : 'dashed'} to="middle" />
      {!last && <Line kind={lineBelow} from="middle" />}
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          'relative grid w-full grid-cols-[44px_20px_minmax(0,1fr)_auto] items-start rounded-xl py-1.5 pr-2 text-left outline-none transition-colors hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-ring',
          (open || current) && 'bg-black/[0.035]',
          current && 'ring-1 ring-brand-tint',
        )}
      >
        <time dateTime={date.toISOString()} title={`${date.toLocaleString()} (${formatAgo(commit.at, Date.now())})`} className="pt-[3px] pr-2 text-right text-[11px] text-faint tabular-nums">
          {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
        </time>
        <span className="relative z-10 mt-[1px] grid place-items-center bg-[#fbfafd] py-0.5">
          <Node agent={Boolean(commit.agent)} hollow={!onGitHub} first={first} />
          <span className="sr-only">
            {commit.agent ? 'AI commit' : 'Commit'}
            {state}
          </span>
        </span>
        <span className="min-w-0 pl-2">
          <span className="line-clamp-2 text-[13px] leading-snug font-medium">{commit.message}</span>
          <span className={cn('mt-0.5 flex items-center gap-1 truncate text-[12px] text-muted-foreground', commit.agent && 'text-agent')}>
            {commit.agent && <AgentMark label="" className="text-[10px]" />}
            <span className="min-w-0 truncate">{who}</span>
            {first ? <span className="shrink-0 text-faint">· started the notebook</span> : tracks && !onGitHub ? <span className="shrink-0 text-faint">· not on GitHub yet</span> : null}
          </span>
        </span>
        <span className="pt-[3px] pl-2 font-mono text-[11px] text-faint">#{commit.number}</span>
      </button>
      {open && <CommitOpen commit={commit} info={info} notebook={notebook} first={first} onGitHub={tracks && onGitHub} onUndone={onUndone} />}
    </div>
  );
}

/** A commit, opened in place: what it touched, and what can be done with it. */
function CommitOpen({ commit, info, notebook, first, onGitHub, onUndone }: { commit: CommitSummary; info: RepoInfo; notebook: string; first: boolean; onGitHub: boolean; onUndone(): void }) {
  const route = useRoute();
  const github = useShelf((state) => state.me?.github);
  const [details, setDetails] = useState<CommitDetails>();
  const [error, setError] = useState<string>();
  const [undone, setUndone] = useState<string[]>();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const here = new Set(info.sections.map((section) => section.id));
  const onSection = route.page === 'section';

  useEffect(() => {
    let current = true;
    api.commitDetails(commit.oid).then(
      (found) => current && setDetails(found),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [commit.oid]);

  const view = (section: string) => {
    navigate({ page: 'section', id: notebook, section });
    useApp.getState().viewCommit(commit.oid);
  };
  const undo = () => {
    setConfirming(false);
    api.undoCommit(commit.oid).then(
      ({ lines }) => {
        setUndone(lines);
        onUndone();
      },
      (failure: Error) => setError(failure.message),
    );
  };
  const other = details ? [details.layout && 'Folders and order', details.instructions && 'AI instructions', details.details && 'The notebook’s name, line or colour'].filter(Boolean) : [];

  return (
    <div className="relative z-10 mt-1 mb-2 ml-[64px] rounded-xl border border-border bg-background p-2.5 text-[12.5px] shadow-[0_1px_2px_rgb(27_24_38/4%)]">
      {!details && !error && <p className="text-muted-foreground">Looking at what it changed…</p>}
      {details && (
        <ul className="flex flex-col">
          {details.sections.map((section) => {
            const exists = here.has(section.id) && section.what !== 'deleted';
            return (
              <li key={section.id}>
                <button
                  type="button"
                  disabled={!exists}
                  onClick={() => view(section.id)}
                  title={exists ? `See ${section.title} as it was in #${commit.number}` : undefined}
                  className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-1 text-left outline-none enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default touch:min-h-10"
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 truncate">
                    {section.folder && <span className="text-faint">{folderName(info.tree, section.folder)} › </span>}
                    <span className="font-medium">{section.title}</span>
                  </span>
                  {section.what && <span className="shrink-0 rounded bg-secondary px-1 text-[11px] text-muted-foreground">{section.what === 'made' ? 'new' : section.what}</span>}
                  <span className="flex-1" />
                  <Counts counts={{ added: section.added, modified: section.edited, moved: section.moved, removed: section.removed }} />
                </button>
              </li>
            );
          })}
          {other.map((line) => (
            <li key={String(line)} className="flex min-h-7 items-center gap-1.5 px-1 text-muted-foreground">
              <Settings2 className="size-3.5 shrink-0" aria-hidden="true" />
              {line}
            </li>
          ))}
          {!details.sections.length && !other.length && <li className="px-1 text-muted-foreground">It changed no text.</li>}
        </ul>
      )}

      {undone ? (
        <div className="mt-2 rounded-lg bg-brand-soft p-2 leading-snug">
          {undone.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="mt-1 text-muted-foreground">These are uncommitted changes now, under Now: look them over, then commit.</p>
        </div>
      ) : confirming ? (
        <div className="mt-2 rounded-lg bg-muted p-2 leading-snug">
          <p>Turn #{commit.number}’s changes back into uncommitted changes? Anything written since stays, and nothing is committed until you commit.</p>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="primary" onClick={undo}>
              Undo #{commit.number}
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1 border-t border-border pt-2">
          {onSection && (
            <Action icon={Eye} onClick={() => useApp.getState().viewCommit(commit.oid)}>
              View this version
            </Action>
          )}
          {onSection && (
            <Action icon={ArrowLeftRight} onClick={() => useApp.getState().compare(commit.oid)}>
              Compare with now
            </Action>
          )}
          {!first && (
            <Action icon={Undo2} onClick={() => setConfirming(true)}>
              Undo this commit
            </Action>
          )}
          <Action
            icon={copied ? Check : Copy}
            onClick={() =>
              void navigator.clipboard.writeText(commit.oid).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? 'Copied' : `Copy ID ${commit.oid.slice(0, 7)}`}
          </Action>
          {github && onGitHub && (
            <a className={ACTION} href={`https://github.com/${github}/${notebook}/commit/${commit.oid}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-3.5" aria-hidden="true" />
              View on GitHub
            </a>
          )}
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}

const ACTION = 'flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring touch:h-10';

function Action({ icon: Shape, onClick, children }: { icon: LucideIcon; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" className={ACTION} onClick={onClick}>
      <Shape className="size-3.5" aria-hidden="true" />
      {children}
    </button>
  );
}

/** Today, Yesterday, or the day as "Mon 4 Nov" (with the year when it isn't this one). */
function dayLabel(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}
