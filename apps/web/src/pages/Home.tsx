/**
 * Home, in the cloud, laid out like Cloud Dock's dashboard: the top bar says how the backups to
 * GitHub stand, with the bell for what happened since your last visit; the band under it holds
 * New notebook; then the sections edited lately as cards, the notebooks as folders, and a table of
 * sections with tabs: Recent, Needs review, Uncommitted and Activity (what AI did). Everything
 * comes from the library's cards, one request when the app opens and live after that, so no
 * notebook is woken to draw it.
 *
 * A click on a notebook's folder opens the notebook. New notebook is one press away in three
 * places: the band, the last folder, and the panel.
 *
 * A new Quillipi shows the Get started card first (GetStarted.tsx): connect Claude, then the first
 * notebook, until both are done.
 */
import type { NotebookCard, RecentEdit, SectionMark } from '@inklog/core';
import { ArrowUpDown, Check, ChevronDown, ChevronRight, Ellipsis, FileText, Plus, Search } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Problem } from '../App';
import { api } from '../api';
import { follow } from '../frame/Rail';
import { Band, TopBar } from '../frame/TopBar';
import { cn } from '../lib/cn';
import { type NotebookOrder, backups, getStarted, plural, sortNotebooks } from '../news';
import { href } from '../router';
import { loadHome, useShelf } from '../store';
import { Button, buttonStyles } from '../ui/Button';
import { AgentMark, Ago, Face, Kbd, Pill, WetDot } from '../ui/Marks';
import { MenuButton } from '../ui/Menu';
import { NotebookFolder } from '../ui/NotebookFolder';
import { NotebookTile } from '../ui/NotebookTile';
import { GetStarted } from './GetStarted';

export function Home() {
  const cards = useShelf((state) => state.cards);
  const loaded = useShelf((state) => state.homeLoaded);
  const claudeConnected = useShelf((state) => state.claudeConnected);
  const [error, setError] = useState<Error>();

  useEffect(() => {
    loadHome().catch(setError);
  }, []);

  if (error) return <Problem error={error} />;
  const live = cards.filter((card) => !card.archived);
  const progress = getStarted(cards, claudeConnected);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <TopBar>{loaded && <Backups cards={live} />}</TopBar>
      <Band>
        <nav aria-label="Where you are" className="text-[14px] font-medium">
          <span aria-current="page">Home</span>
        </nav>
        <span className="flex-1" />
        <Button variant="primary" onClick={create}>
          <Plus className="size-4" strokeWidth={2.2} aria-hidden="true" /> New notebook
        </Button>
      </Band>
      <div className="scroll-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-10 px-6 py-7 max-md:gap-8 max-md:px-4 max-md:py-5">
          {!loaded ? (
            <p className="text-muted-foreground">Opening…</p>
          ) : (
            <>
              {progress.show && <GetStarted progress={progress} alone={!live.length} />}
              {live.length > 0 && (
                <>
                  <RecentlyEdited cards={live} />
                  <Notebooks cards={live} />
                  <Sections cards={live} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** A top bar's left side, as Cloud Dock's storage meter: a 3D picture, a title with a figure, and a line or a meter under it. */
export function Context({ art, title, figure, children, hint }: { art: string; title: string; figure?: ReactNode; children?: ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3" title={hint}>
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface ring-1 ring-border">
        <img src={art} alt="" width={26} height={26} className="size-[26px] select-none" draggable={false} />
      </span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2.5 truncate text-[15px] leading-tight font-semibold tracking-[-0.01em]">
          {title}
          {figure && <span className="truncate text-[13px] font-normal text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground">{figure}</span>}
        </p>
        {children}
      </div>
    </div>
  );
}

/** How the backups stand: how many notebooks are safe on GitHub. */
function Backups({ cards }: { cards: NotebookCard[] }) {
  const { safe, total, trouble } = backups(cards);
  if (!total) return null;
  const notSafe = cards.filter((card) => card.summary && !['backed-up', 'pushing'].includes(card.summary.backup.state)).map((card) => card.title);
  const title = trouble ? 'Not all backed up' : safe === total ? 'Backed up to GitHub' : 'Backing up to GitHub';
  return (
    <Context
      art={trouble ? '/3d/cloud_with_lightning_3d.png' : '/3d/cloud_3d.png'}
      title={title}
      hint={notSafe.length ? `Not backed up yet: ${notSafe.join(', ')}` : 'Every notebook is on GitHub, with its whole history'}
      figure={
        <>
          <strong>{safe}</strong> / {plural(total, 'notebook')}
        </>
      }
    >
      <span
        className="mt-1.5 block h-1.5 w-[min(240px,44vw)] overflow-hidden rounded-full bg-secondary"
        role="meter"
        aria-label="Notebooks backed up"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={safe}
        aria-valuetext={`${safe} of ${plural(total, 'notebook')} backed up`}
      >
        <span className={cn('block h-full rounded-full transition-[width] duration-500', trouble ? 'bg-removed' : 'bg-linear-to-r from-[#9d86ff] to-brand')} style={{ width: `${(safe / total) * 100}%` }} />
      </span>
    </Context>
  );
}

function BlockHead({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h2 id={id} className="flex-1 text-[17px] font-semibold tracking-[-0.015em]">
        {title}
      </h2>
      {children}
    </div>
  );
}

/** The sections edited most recently, in any notebook, as cards like Cloud Dock's documents: a sheet in a tray. */
function RecentlyEdited({ cards }: { cards: NotebookCard[] }) {
  const edits = recentEdits(cards).slice(0, 4);
  if (!edits.length) return null;
  return (
    <section aria-labelledby="recent-title">
      <BlockHead id="recent-title" title="Recently edited">
        <Button size="sm" onClick={() => showTab('recent')}>
          View all <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
      </BlockHead>
      <ul className="grid grid-cols-4 gap-5 max-lg:grid-cols-2 max-md:gap-3">
        {edits.map(({ card, edit }) => (
          <li key={`${card.id}/${edit.id}`} className="min-w-0">
            <a className="group block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4" href={href({ page: 'section', id: card.id, section: edit.id })} onClick={follow}>
              <span className="relative block h-[128px] overflow-hidden rounded-2xl bg-surface px-3.5 pt-3.5 ring-1 ring-border max-md:h-[104px]" aria-hidden="true">
                <span className="flex h-full flex-col gap-2 rounded-t-xl bg-background px-3.5 pt-3.5 shadow-[0_0_0_1px_rgb(27_24_38/5%),0_10px_24px_-10px_rgb(27_24_38/22%)] transition-transform duration-200 ease-out group-hover:-translate-y-1 group-hover:blur-[1.5px]">
                  <span className="flex items-center gap-2">
                    <NotebookTile colour={card.colour} size={26} className="rounded-full!" />
                    <span className="truncate font-serif text-[13px] font-semibold">{edit.title}</span>
                  </span>
                  <span className="h-2 w-full rounded-full bg-secondary" />
                  <span className="h-2 w-11/12 rounded-full bg-secondary" />
                  <span className="h-2 w-3/5 rounded-full bg-secondary" />
                </span>
                <span className="absolute top-1/2 left-1/2 flex h-9 -translate-x-1/2 -translate-y-1/2 scale-95 items-center rounded-[10px] bg-[#1b1630] px-3.5 text-[12.5px] font-medium whitespace-nowrap text-white opacity-0 shadow-pop transition-[opacity,transform] duration-150 group-hover:scale-100 group-hover:opacity-100">
                  Open section
                </span>
              </span>
              <span className="mt-3 flex flex-col px-0.5">
                <span className="truncate text-[14.5px] font-medium">{edit.title}</span>
                <span className="flex items-center gap-1 truncate text-[12.5px] text-muted-foreground">
                  {edit.agent && <AgentMark label={`By ${edit.by}`} className="text-[10px]" />}
                  <span className="truncate">
                    Edited <Ago at={edit.at} /> · {card.title}
                  </span>
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ORDERS: { order: NotebookOrder; label: string }[] = [
  { order: 'changed', label: 'Last changed' },
  { order: 'title', label: 'Title' },
  { order: 'made', label: 'Newest' },
];
const ORDER_KEY = 'inklog:notebook-order';

/** The notebooks as folders, like Cloud Dock's Shared Folders. The first is the deep violet one. A click opens the notebook. */
function Notebooks({ cards }: { cards: NotebookCard[] }) {
  const [order, setOrder] = useState<NotebookOrder>(() => {
    const saved = localStorage.getItem(ORDER_KEY);
    return saved === 'title' || saved === 'made' ? saved : 'changed';
  });
  const sorted = sortNotebooks(cards, order);
  const choose = (next: NotebookOrder) => {
    setOrder(next);
    localStorage.setItem(ORDER_KEY, next);
  };
  const label = ORDERS.find((option) => option.order === order)!.label;

  return (
    <section aria-labelledby="notebooks-title">
      <BlockHead id="notebooks-title" title="Notebooks">
        <MenuButton
          label={`Sort notebooks by ${label.toLowerCase()}`}
          className={buttonStyles({ variant: 'soft', size: 'sm' })}
          align="end"
          items={ORDERS.map((option) => ({ label: option.label, icon: option.order === order ? <Check /> : <span />, onSelect: () => choose(option.order) }))}
        >
          <ArrowUpDown className="size-3.5" aria-hidden="true" />
          {label}
          <ChevronDown className="size-3.5 opacity-70" aria-hidden="true" />
        </MenuButton>
      </BlockHead>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-x-5 gap-y-7 pt-1 max-md:grid-cols-2 max-md:gap-x-3 max-md:gap-y-5">
        {sorted.map((card, index) => (
          <li key={card.id} className="min-w-0">
            <NotebookCardFolder card={card} deep={index === 0} />
          </li>
        ))}
        <li className="min-w-0">
          <NotebookFolder
            tone="add"
            href="#new-notebook"
            onClick={(event) => {
              event.preventDefault();
              create();
            }}
            icon={
              <span className="grid size-10 place-items-center rounded-full bg-linear-to-b from-[#8f74ff] to-[#6846ec] text-white shadow-[0_0_0_5px_rgb(115_80_242/14%)]">
                <Plus className="size-5" strokeWidth={2.2} aria-hidden="true" />
              </span>
            }
            title="New notebook"
            meta="With its own GitHub repo"
          />
        </li>
      </ul>
    </section>
  );
}

function NotebookCardFolder({ card, deep }: { card: NotebookCard; deep: boolean }) {
  const lastVisit = useShelf((state) => state.lastVisit);
  const me = useShelf((state) => state.me);
  const summary = card.summary;
  const byAgent = summary?.agentCommits.some((commit) => lastVisit === undefined || commit.at > lastVisit) ?? false;
  const madeByAgent = card.from === 'new' && card.createdBy.includes('Claude') && Date.now() - card.createdAt < 24 * 60 * 60 * 1000;
  // Its facts, and after them the one thing that needs you, if anything does.
  const meta = !summary ? (
    'Opening…'
  ) : (
    <span className="flex items-center gap-1.5">
      {summary.held ? (
        <span className={cn('flex min-w-0 items-center gap-1 font-medium', deep ? 'text-[#ffb07a]' : 'text-agent')}>
          <AgentMark label="" className="text-[10px]" /> <span className="truncate">{summary.held} to review</span>
        </span>
      ) : summary.uncommitted ? (
        <span className={cn('flex min-w-0 items-center gap-1.5 font-medium', deep ? 'text-[#c9bcff]' : 'text-brand')}>
          <WetDot className={deep ? 'bg-[#c9bcff]' : undefined} /> <span className="truncate">{summary.uncommitted} uncommitted</span>
        </span>
      ) : (
        <span className="truncate">
          {plural(summary.sections, 'section')} · {plural(summary.commits, 'commit')}
        </span>
      )}
      {madeByAgent && !summary.held && !summary.uncommitted && <AgentMark label={`Made by ${card.createdBy}`} className="text-[10px]" />}
    </span>
  );
  return (
    <NotebookFolder
      href={href({ page: 'notebook', id: card.id, folder: '' })}
      onClick={follow}
      tone={deep ? 'deep' : 'light'}
      icon={<NotebookTile colour={card.colour} size={38} />}
      title={card.title}
      meta={meta}
      sheets={(summary?.recent ?? []).map((edit) => edit.title)}
      people={
        <>
          {me && <Face name={me.name} login={me.login} size={24} className={deep ? 'ring-[#1e1736]' : undefined} />}
          {(byAgent || summary?.lastAgent) && <Face name={summary?.lastAgent?.agent ?? 'An AI'} agent size={24} className={deep ? 'ring-[#1e1736]' : undefined} />}
        </>
      }
      menu={
        <MenuButton
          label={`More for ${card.title}`}
          align="end"
          className={cn(
            'grid size-7 place-items-center rounded-lg opacity-0 outline-none transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring aria-expanded:opacity-100 touch:size-9 touch:opacity-100',
            deep ? 'text-white/70 hover:bg-white/12 hover:text-white' : 'text-muted-foreground hover:bg-black/[0.06] hover:text-foreground',
          )}
          items={[
            { label: 'Archive', hint: 'Hidden from Home and from Claude’s list', onSelect: () => void api.archive(card.id, true).then((next) => useShelf.getState().putCard(next)) },
          ]}
        >
          <Ellipsis className="size-4" aria-hidden="true" />
        </MenuButton>
      }
    />
  );
}

type Tab = 'recent' | 'review' | 'uncommitted' | 'activity';
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'recent', label: 'Recent' },
  { tab: 'review', label: 'Needs review' },
  { tab: 'uncommitted', label: 'Uncommitted' },
  { tab: 'activity', label: 'Activity' },
];

/** Shows a tab of Home's table and scrolls to it, as the panel's links under Home do. */
function showTab(tab: Tab): void {
  window.dispatchEvent(new CustomEvent('inklog:home-tab', { detail: tab }));
}

/** The sections table, like Cloud Dock's: tabs in a track, a search box, and the rows. */
function Sections({ cards }: { cards: NotebookCard[] }) {
  const lastVisit = useShelf((state) => state.lastVisit);
  const me = useShelf((state) => state.me);
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#activity' ? 'activity' : 'recent'));
  const [query, setQuery] = useState('');
  const find = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const chosen = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setTab(TABS.some((option) => option.tab === detail) ? (detail as Tab) : 'recent');
      requestAnimationFrame(() => document.getElementById('sections')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    };
    window.addEventListener('inklog:home-tab', chosen);
    if (location.hash) document.getElementById('sections')?.scrollIntoView();
    return () => window.removeEventListener('inklog:home-tab', chosen);
  }, []);

  // "/" searches the table, as in Cloud Dock, unless you are typing somewhere.
  useEffect(() => {
    const slash = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || target.closest('input, textarea, select, [contenteditable=true]')) return;
      event.preventDefault();
      find.current?.focus();
    };
    window.addEventListener('keydown', slash);
    return () => window.removeEventListener('keydown', slash);
  }, []);

  const words = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !words || texts.join(' ').toLowerCase().includes(words);
  const marked = (pick: (card: NotebookCard) => SectionMark[] | undefined) =>
    cards.flatMap((card) => (pick(card) ?? []).map((mark) => ({ card, mark }))).filter(({ card, mark }) => matches(mark.title, mark.folder, card.title));
  const review = marked((card) => card.summary?.heldSections);
  const uncommitted = marked((card) => card.summary?.pendingSections);
  const activity = cards
    .flatMap((card) => (card.summary?.agentCommits ?? []).map((commit) => ({ card, commit })))
    .filter(({ commit }) => lastVisit === undefined || commit.at > lastVisit)
    .filter(({ card, commit }) => matches(commit.message, commit.agent, card.title))
    .sort((a, b) => b.commit.at - a.commit.at);
  const recent = recentEdits(cards).filter(({ card, edit }) => matches(edit.title, edit.folder, card.title, edit.by));
  const counts: Record<Tab, number> = { recent: 0, review: review.length, uncommitted: uncommitted.length, activity: activity.length };
  const mine = (name: string) => (me && (name === me.name || name === me.login) ? me.login : undefined);
  const pending = new Map(cards.flatMap((card) => (card.summary?.pendingSections ?? []).map((mark) => [`${card.id}/${mark.id}`, mark])));
  const none = (text: string) => <p className="px-4 py-12 text-center text-[14px] text-muted-foreground">{words ? `Nothing matches “${query.trim()}”.` : text}</p>;

  return (
    <section id="sections" aria-label="Sections" className="scroll-mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="no-scrollbar flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-secondary p-1" role="tablist" aria-label="Sections">
          {TABS.map(({ tab: value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`tab-${value}`}
              aria-selected={tab === value}
              aria-controls="sections-panel"
              onClick={() => setTab(value)}
              className="group flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-tile touch:h-10"
            >
              <span className="hidden size-4 place-items-center rounded-full bg-brand text-white group-aria-selected:grid" aria-hidden="true">
                <Check className="size-2.5" strokeWidth={3.5} />
              </span>
              {label}
              {counts[value] > 0 && <span className={cn('rounded-md px-1.5 text-[11.5px] font-semibold', value === 'uncommitted' ? 'bg-brand-soft text-brand' : 'bg-agent-soft text-agent')}>{counts[value]}</span>}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label className="flex h-10 w-[260px] items-center gap-2 rounded-xl border border-input bg-background px-3 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/15 max-md:w-full">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            ref={find}
            type="search"
            value={query}
            placeholder="Search sections…"
            aria-label="Search the sections"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && (setQuery(''), event.currentTarget.blur())}
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-faint touch:text-[16px]"
          />
          <Kbd>/</Kbd>
        </label>
      </div>

      <div role="tabpanel" id="sections-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'recent' &&
          (recent.length ? (
            <Table head={['Section', 'Changed by', 'Status', 'Last change']} hide={[1, 3]}>
              {recent.map(({ card, edit }) => {
                const mark = pending.get(`${card.id}/${edit.id}`);
                return (
                  <tr key={`${card.id}/${edit.id}`} className={ROW}>
                    <td className={cn(CELL, 'pl-3')}>
                      <SectionName card={card} id={edit.id} title={edit.title} folder={edit.folder} />
                    </td>
                    <td className={cn(CELL, 'max-md:hidden')}>
                      <Person name={edit.by} agent={edit.agent} login={edit.agent ? undefined : mine(edit.by)} />
                    </td>
                    <td className={CELL}>
                      {mark ? (
                        <Pill tone="wet">
                          <WetDot /> {mark.count} uncommitted
                        </Pill>
                      ) : (
                        <Pill>Committed</Pill>
                      )}
                    </td>
                    <td className={cn(CELL, 'pr-4 text-right whitespace-nowrap text-muted-foreground max-md:hidden')}>
                      <Ago at={edit.at} />
                    </td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            none('No section has been edited yet.')
          ))}
        {(tab === 'review' || tab === 'uncommitted') &&
          ((tab === 'review' ? review : uncommitted).length ? (
            <Table head={['Section', 'Changed by', 'Status']} hide={[1]}>
              {(tab === 'review' ? review : uncommitted).map(({ card, mark }) => (
                <tr key={`${card.id}/${mark.id}`} className={ROW}>
                  <td className={cn(CELL, 'pl-3')}>
                    <SectionName card={card} id={mark.id} title={mark.title} folder={mark.folder} />
                  </td>
                  <td className={cn(CELL, 'max-md:hidden')}>{mark.agent ? <Person name="AI and you" agent /> : <Person name="You" login={me?.login} />}</td>
                  <td className={cn(CELL, 'pr-4')}>
                    {tab === 'review' ? (
                      <Pill tone="agent">
                        <AgentMark label="" className="text-[10px]" /> {mark.count} to review
                      </Pill>
                    ) : (
                      <Pill tone="wet">
                        <WetDot /> {mark.count} uncommitted
                      </Pill>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            none(tab === 'review' ? 'Nothing waits for your review.' : 'Everything is committed.')
          ))}
        {tab === 'activity' &&
          (activity.length ? (
            <Table head={['Commit', 'By', 'When']} hide={[]}>
              {activity.map(({ card, commit }) => (
                <tr key={`${card.id}/${commit.number}`} className={ROW}>
                  <td className={cn(CELL, 'pl-3')}>
                    <span className="flex items-center gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-agent-soft text-[15px]">
                        <AgentMark label="" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <a className={ROW_LINK} href={href({ page: 'notebook', id: card.id, folder: '' })} onClick={follow}>
                          <span className="mr-1.5 font-mono text-[12px] font-normal text-faint">#{commit.number}</span>
                          {commit.message}
                        </a>
                        <span className="truncate text-[12.5px] text-muted-foreground">{card.title}</span>
                      </span>
                    </span>
                  </td>
                  <td className={cn(CELL, 'max-md:hidden')}>
                    <Person name={commit.agent} agent />
                  </td>
                  <td className={cn(CELL, 'pr-4 text-right whitespace-nowrap text-muted-foreground')}>
                    <Ago at={commit.at} />
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            none('No AI has committed since your last visit.')
          ))}
      </div>
    </section>
  );
}

export const ROW = 'group relative border-b border-border transition-colors last:border-b-0 hover:bg-surface';
export const CELL = 'h-[60px] py-2 pr-3 align-middle';
export const ROW_LINK = 'truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset';

/** A table like Cloud Dock's: a grey head with small capitals, and rows with a line between them. */
export function Table({ head, hide, children }: { head: string[]; hide: number[]; children: ReactNode }) {
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-[13.5px]">
      <thead>
        <tr>
          {head.map((label, index) => (
            <th
              key={label}
              scope="col"
              className={cn(
                'h-10 bg-surface px-0 pr-3 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase first:rounded-l-xl first:pl-4 last:rounded-r-xl last:pr-4',
                index === 0 ? 'w-[44%] max-md:w-[58%]' : index === head.length - 1 && head.length > 2 ? 'w-[120px] text-right max-md:w-auto max-md:text-left' : '',
                hide.includes(index) && 'max-md:hidden',
              )}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="[&_td]:border-b [&_td]:border-border [&_tr:last-child_td]:border-b-0">{children}</tbody>
    </table>
  );
}

/** A section's name in a table: a tile in its notebook's colour, its title, and where it is under it. */
function SectionName({ card, id, title, folder }: { card: NotebookCard; id: string; title: string; folder: string }) {
  return (
    <span className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-[11px] border border-border bg-background shadow-[0_1px_2px_rgb(27_24_38/5%)]" style={{ color: card.colour }} aria-hidden="true">
        <FileText className="size-[18px]" />
      </span>
      <span className="flex min-w-0 flex-col">
        <a className={ROW_LINK} href={href({ page: 'section', id: card.id, section: id })} onClick={follow}>
          {title}
        </a>
        <span className="truncate text-[12.5px] text-muted-foreground">
          {card.title}
          {folder && <> › {folder}</>}
        </span>
      </span>
    </span>
  );
}

/** Who, as a face and a name. */
export function Person({ name, agent = false, login }: { name: string; agent?: boolean; login?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', agent && 'text-agent')}>
      <Face name={name} agent={agent} login={login} size={24} className="ring-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

function create(): void {
  useShelf.getState().setCreating(true);
}

/** Every notebook's recently edited sections together, newest first. */
function recentEdits(cards: NotebookCard[]): { card: NotebookCard; edit: RecentEdit }[] {
  return cards.flatMap((card) => (card.summary?.recent ?? []).map((edit) => ({ card, edit }))).sort((a, b) => b.edit.at - a.edit.at);
}
