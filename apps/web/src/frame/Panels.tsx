/**
 * The panel in the frame, as in Cloud Dock. On Home: « to hide it, search, the Home pill with its
 * two views under it, the notebooks with New notebook, and a card at the foot with a 3D picture:
 * when an AI last worked here, or how to connect one. Inside a notebook: the switcher, the
 * notebook's tree (NotebookTree), and the card says how its backup stands.
 */
import { type BackupState, type NotebookCard, formatAgo } from '@inklog/core';
import { Archive, ArrowRight, ChevronRight, ChevronsLeft, FileText, House, Plus, Search as SearchIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/cn';
import { backupDetail } from '../news';
import { href, useRoute } from '../router';
import { useApp, useShelf } from '../store';
import { ChangeMarks, AgentMark } from '../ui/Marks';
import { NotebookTile } from '../ui/NotebookTile';
import { Tooltip } from '../ui/Tooltip';
import { NotebookTree } from './NotebookTree';
import { follow } from './Rail';
import { Switcher } from './Switcher';

export const PANEL_ROW = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] text-muted-foreground outline-none transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring touch:h-11';
/** The pill for the place you are on, as Cloud Dock's Overview. */
export const PANEL_PILL =
  'flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-[14px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring touch:h-11 aria-[current=page]:bg-linear-to-b aria-[current=page]:from-[#8062f6] aria-[current=page]:to-[#6846ec] aria-[current=page]:text-white aria-[current=page]:shadow-[inset_0_1px_0_rgb(255_255_255/24%),0_10px_22px_-12px_rgb(115_80_242/90%)] not-aria-[current=page]:text-muted-foreground not-aria-[current=page]:hover:bg-accent/70 not-aria-[current=page]:hover:text-foreground';

export function HomePanel({ onHide }: { onHide(): void }) {
  const route = useRoute();
  const cards = useShelf((state) => state.cards);
  const lastVisit = useShelf((state) => state.lastVisit);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const words = query.trim().toLowerCase();
  const matches = (text: string) => !words || text.toLowerCase().includes(words);
  const live = cards.filter((card) => !card.archived);
  const archived = cards.filter((card) => card.archived);
  const shown = live.filter((card) => matches(`${card.title} ${card.about ?? ''}`));
  // Searching also finds sections edited lately in any notebook.
  const sections = words ? live.flatMap((card) => (card.summary?.recent ?? []).filter((edit) => matches(edit.title)).map((edit) => ({ card, edit }))) : [];
  const activity = live.reduce((sum, card) => sum + (card.summary?.agentCommits.filter((commit) => lastVisit === undefined || commit.at > lastVisit).length ?? 0), 0);

  return (
    <PanelShell>
      <PanelHeader onHide={onHide}>
        <h2 className="truncate text-[17px] font-semibold tracking-[-0.015em]">Home</h2>
      </PanelHeader>
      <PanelSearch value={query} onChange={setQuery} placeholder="Search" label="Search notebooks and sections" />
      <div className="scroll-quiet -mx-1 min-h-0 flex-1 overflow-y-auto px-1 pt-3">
        {!words && (
          <nav aria-label="Home">
            <a className={PANEL_PILL} href="/" aria-current={route.page === 'home' ? 'page' : undefined} onClick={follow}>
              <House className="size-[18px]" strokeWidth={1.9} aria-hidden="true" />
              Home
            </a>
            {live.length > 0 && (
              <div className="relative mt-1 ml-[21px] flex flex-col gap-0.5 border-l border-border pl-3">
                <a className={PANEL_ROW} href="/#recent" onClick={(event) => jump(event, 'recent')}>
                  <span className="flex-1 truncate">Recently edited</span>
                  <ChevronRight className="size-3.5 opacity-60" aria-hidden="true" />
                </a>
                <a className={PANEL_ROW} href="/#activity" onClick={(event) => jump(event, 'activity')}>
                  <span className="flex-1 truncate">Activity</span>
                  {activity > 0 && (
                    <span className="rounded-md bg-[#ff9f5a]/15 px-1.5 py-0.5 text-[11.5px] font-semibold text-[#ffb07a]" title="Commits by AI since your last visit">
                      {activity}
                    </span>
                  )}
                </a>
              </div>
            )}
            <hr className="mx-1 my-4 border-0 bg-linear-to-r from-transparent via-white/14 to-transparent pt-px" />
          </nav>
        )}
        <nav aria-label="Notebooks" className="flex flex-col gap-0.5">
          <PanelHeading
            actions={
              <Tooltip label="New notebook">
                <button type="button" aria-label="New notebook" className={HEADING_BUTTON} onClick={() => useShelf.getState().setCreating(true)}>
                  <Plus className="size-4" />
                </button>
              </Tooltip>
            }
          >
            Notebooks
          </PanelHeading>
          {shown.map((card) => (
            <NotebookRow key={card.id} card={card} />
          ))}
          {words && !shown.length && !sections.length && <p className="px-2.5 py-2 text-[13px] text-muted-foreground">Nothing matches “{query.trim()}”.</p>}
          {sections.length > 0 && <PanelHeading>Sections</PanelHeading>}
          {sections.map(({ card, edit }) => (
            <a key={`${card.id}/${edit.id}`} className={PANEL_ROW} href={href({ page: 'section', id: card.id, section: edit.id })} onClick={follow}>
              <FileText className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{edit.title}</span>
              <span className="max-w-[40%] truncate text-[12px] opacity-60">{card.title}</span>
            </a>
          ))}
          {!words && archived.length > 0 && (
            <>
              <button type="button" className={PANEL_ROW} aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
                <Archive className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex-1 truncate">Archived</span>
                <span className="text-[12px] opacity-60">{archived.length}</span>
                <ChevronRight className={cn('size-3.5 opacity-60 transition-transform', showArchived && 'rotate-90')} aria-hidden="true" />
              </button>
              {showArchived && archived.map((card) => <NotebookRow key={card.id} card={card} />)}
            </>
          )}
          {!words && <DashedAdd onClick={() => useShelf.getState().setCreating(true)}>New notebook</DashedAdd>}
        </nav>
      </div>
      <HomeStatus cards={live} />
    </PanelShell>
  );
}

function NotebookRow({ card }: { card: NotebookCard }) {
  const lastVisit = useShelf((state) => state.lastVisit);
  const summary = card.summary;
  const byAgent = (summary?.agentUncommitted ?? 0) > 0 || (summary?.agentCommits.some((commit) => lastVisit === undefined || commit.at > lastVisit) ?? false);
  return (
    <a className={PANEL_ROW} href={href({ page: 'notebook', id: card.id, folder: '' })} onClick={follow}>
      <NotebookTile colour={card.colour} size={22} />
      <span className="min-w-0 flex-1 truncate">{card.title}</span>
      {byAgent && !summary?.uncommitted && <AgentMark label="An AI changed it since your last visit" />}
      <ChangeMarks count={summary?.uncommitted ?? 0} agent={byAgent} />
    </a>
  );
}

/** At the foot: when an AI last worked in any notebook, or how to connect one; both lead to Agents. */
function HomeStatus({ cards }: { cards: NotebookCard[] }) {
  const last = cards.flatMap((card) => (card.summary?.lastAgent ? [{ card, ...card.summary.lastAgent }] : [])).sort((a, b) => b.at - a.at)[0];
  if (!cards.length) return null;
  return last ? (
    <StatusCard art="/3d/sparkles_3d.png" title={last.agent} text={`Worked in ${last.card.title} ${formatAgo(last.at, Date.now())}.`} action={{ label: 'Agents', href: '/agents' }} />
  ) : (
    <StatusCard art="/3d/sparkles_3d.png" title="Connect an AI" text="Let Claude read and write your notebooks. Every change it makes is marked and committed with its name." action={{ label: 'Set up', href: '/agents' }} />
  );
}

export function NotebookPanel({ onHide }: { onHide(): void }) {
  const info = useApp((state) => state.info);
  const laptop = useShelf((state) => state.host) === 'laptop';
  if (!info) return <PanelShell>{null}</PanelShell>;
  return (
    <PanelShell>
      <PanelHeader onHide={onHide}>
        <Switcher />
      </PanelHeader>
      <NotebookTree />
      {info.backup ? (
        <BackupCard backup={info.backup} />
      ) : (
        laptop && <StatusCard art="/3d/cloud_3d.png" title="On this laptop" text="This program serves this one notebook. Home, New notebook and your other notebooks are in your Quillipi in the cloud." />
      )}
    </PanelShell>
  );
}

const BACKUP_TITLE: Record<BackupState['state'], string> = {
  off: 'Not backed up',
  making: 'Setting up the backup',
  importing: 'Setting up the backup',
  pushing: 'Backing up…',
  'backed-up': 'Backed up to GitHub',
  retrying: 'The backup is retrying',
  stopped: 'The backup stopped',
};

function BackupCard({ backup }: { backup: BackupState }) {
  const ok = backup.state === 'backed-up' || backup.state === 'pushing' || backup.state === 'making' || backup.state === 'importing';
  return (
    <StatusCard
      art={ok ? '/3d/cloud_3d.png' : '/3d/cloud_with_lightning_3d.png'}
      title={BACKUP_TITLE[backup.state]}
      text={backup.state === 'backed-up' && backup.at ? `GitHub confirmed the last commit ${formatAgo(backup.at, Date.now())}.` : backupDetail(backup.text, BACKUP_TITLE[backup.state])}
      trouble={!ok}
    />
  );
}

/** A card with a 3D picture at the panel's foot, like the offer at the foot of Cloud Dock's panel. */
function StatusCard({ art, title, text, action, trouble = false }: { art: string; title: string; text: string; action?: { label: string; href: string }; trouble?: boolean }) {
  return (
    <section aria-label={title} role="status" className="relative mt-3 shrink-0 rounded-[18px] border border-white/8 bg-linear-to-b from-[#2b2244] to-[#1b1628] px-4 pt-9 pb-4 max-md:hidden">
      <span className={cn('pointer-events-none absolute inset-x-6 top-0 h-16 rounded-full blur-2xl', trouble ? 'bg-[#ff5d7a]/25' : 'bg-[#8a6cff]/30')} aria-hidden="true" />
      <img className="absolute -top-5 left-3 size-[60px] drop-shadow-[0_10px_14px_rgb(0_0_0/45%)] select-none" src={art} alt="" width={60} height={60} draggable={false} />
      <h3 className="relative text-[14.5px] leading-snug font-semibold text-white">{title}</h3>
      <p className="relative mt-1 text-[12.5px] leading-[1.45] text-white/60">{text}</p>
      {action && (
        <a
          href={action.href}
          onClick={follow}
          className="relative mt-3 flex h-9 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.07] text-[13px] font-medium text-white outline-none transition-colors hover:bg-white/[0.12] focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      )}
    </section>
  );
}

export function PanelShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col px-2 pt-1.5 pb-1 max-md:pb-3 xl:pr-3">{children}</div>;
}

function PanelHeader({ onHide, children }: { onHide(): void; children: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5">
      <Tooltip label="Hide the panel">
        <button
          type="button"
          aria-label="Hide the panel"
          onClick={onHide}
          className="grid size-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-white/70 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring touch:size-11"
        >
          <ChevronsLeft className="size-[18px]" aria-hidden="true" />
        </button>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </header>
  );
}

const HEADING_BUTTON = 'grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring touch:size-10';

export function PanelHeading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <p className="flex h-8 items-center justify-between pr-1 pl-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
      {actions && <span className="flex items-center gap-0.5">{actions}</span>}
    </p>
  );
}

/** The dashed button under a list, as Cloud Dock's New Folder. */
export function DashedAdd({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group mt-2 flex h-10 w-full shrink-0 items-center gap-2.5 rounded-xl border border-dashed border-white/16 px-3 text-[13.5px] font-medium text-muted-foreground outline-none transition-colors hover:border-white/30 hover:bg-white/[0.03] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring touch:h-11"
    >
      <span className="grid size-5 place-items-center rounded-full bg-linear-to-b from-[#8f74ff] to-[#6846ec] text-white shadow-[0_0_0_3px_rgb(115_80_242/18%)]" aria-hidden="true">
        <Plus className="size-3" strokeWidth={2.6} />
      </span>
      {children}
    </button>
  );
}

/** The panel's search, as Cloud Dock's: a quiet row with the shortcut at its end, and a line under it. */
export function PanelSearch({ value, onChange, placeholder, label, onKeyDown }: { value: string; onChange(value: string): void; placeholder: string; label: string; onKeyDown?(event: React.KeyboardEvent<HTMLInputElement>): void }) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <label className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-2 text-muted-foreground transition-colors focus-within:border-white/25 focus-within:text-foreground">
      <SearchIcon className="size-[17px] shrink-0" aria-hidden="true" />
      <input
        data-panel-search
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation();
            onChange('');
          }
          onKeyDown?.(event);
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground touch:text-[16px]"
      />
      <kbd className="shrink-0 rounded-md border border-white/8 bg-white/[0.06] px-1.5 py-0.5 font-sans text-[11px] font-medium text-white/60 touch:hidden">{mac ? '⌘ K' : 'Ctrl K'}</kbd>
    </label>
  );
}

/** The views under Home lead to Home's table, on the tab they name. */
function jump(event: React.MouseEvent<HTMLAnchorElement>, tab: string): void {
  follow(event);
  window.dispatchEvent(new CustomEvent('inklog:home-tab', { detail: tab }));
}
