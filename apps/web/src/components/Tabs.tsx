/**
 * The bar across the top of a notebook's page: the open sections as tabs, the way a browser shows
 * its pages. The tab you are in is white and joins the page under it; the others lie on the bar.
 * The first tab is the notebook's overview and can't be closed. A tab shows its section's marks at
 * its end (✦ an AI's uncommitted change, a dot for uncommitted work) and × in their place when it
 * is pointed at, the way an editor shows unsaved files. At the bar's end: who is working here,
 * whether the page is saved, History, the bell and you.
 *
 * Tabs can be dragged into another order, closed with a middle-click, and the arrow keys move
 * between them. Shortcuts stay off the browser's own (Ctrl+W, Ctrl+T, Ctrl+Tab): Alt+W closes the
 * tab, Alt+Shift+T opens the last closed one again, and Alt+[ and Alt+] go to the tab before or
 * after. On a phone the tabs fold into one button that names the section and lists the others.
 */
import { Check, ChevronDown, CloudOff, FileText, History, House, LoaderCircle, Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Account, Bell, PanelButton, ROUND_BUTTON, UpdateButton } from '../frame/TopBar';
import { cn } from '../lib/cn';
import { href, navigate, useRoute } from '../router';
import { useApp } from '../store';
import { AgentMark, Face, WetDot } from '../ui/Marks';
import { MenuButton, type MenuItem } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

const TAB_TYPE = 'application/x-inklog-tab';
const SAVE_TEXT = { saved: 'Saved', saving: 'Saving…', offline: 'Not connected: kept here, saved when Quillipi is back' } as const;

const TAB =
  'group/tab relative flex h-9 min-w-0 shrink-0 items-center rounded-t-[11px] border border-b-0 border-transparent text-[13px] text-muted-foreground transition-colors select-none hover:bg-black/[0.035] hover:text-foreground';
const TAB_CURRENT = 'z-10 -mb-px h-[37px] border-border bg-background font-medium text-foreground hover:bg-background';

export function TabBar() {
  const route = useRoute();
  const info = useApp((state) => state.info)!;
  const notebook = useApp((state) => state.notebook)!;
  const tabs = useApp((state) => state.tabs);
  const reopenable = useApp((state) => state.closed.length > 0);
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [dropAt, setDropAt] = useState<number>();
  const current = route.page === 'section' ? route.section : undefined;
  const onOverview = route.page === 'notebook';
  const title = (id: string) => info.sections.find((section) => section.id === id)?.title ?? id;
  const marks = (id: string) => {
    const changes = info.pending.filter((change) => change.section === id);
    return { count: changes.length, agent: changes.some((change) => change.by.includes('agent')) };
  };

  const shut = (id: string) => {
    useApp.getState().close(id);
    const next = useApp.getState().active;
    if (id === current) navigate(next ? { page: 'section', id: notebook, section: next } : { page: 'notebook', id: notebook, folder: '' }, { replace: true });
  };
  const reopen = () => {
    const id = useApp.getState().reopen();
    if (id) navigate({ page: 'section', id: notebook, section: id });
  };

  // Shortcuts that don't clash with the browser's. `code` is the key's place, so Option on a Mac works too.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const open = useApp.getState().tabs;
      const at = current ? open.indexOf(current) : -1;
      if (event.code === 'KeyW' && !event.shiftKey && current) shut(current);
      else if (event.code === 'KeyT' && event.shiftKey) reopen();
      else if ((event.code === 'BracketLeft' || event.code === 'BracketRight') && open.length) {
        const step = event.code === 'BracketLeft' ? -1 : 1;
        const next = open[(at + step + open.length) % open.length];
        if (next) navigate({ page: 'section', id: notebook, section: next });
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [current, notebook]);

  // The tab you are in stays in sight, and a list of all tabs appears once they don't fit.
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    // Scrolled sideways here only: scrollIntoView would move the page around the strip too.
    const tab = element.querySelector<HTMLElement>('[aria-selected=true]')?.closest<HTMLElement>('[data-tab]');
    if (tab && tab.offsetLeft < element.scrollLeft) element.scrollLeft = tab.offsetLeft;
    else if (tab && tab.offsetLeft + tab.offsetWidth > element.scrollLeft + element.clientWidth) element.scrollLeft = tab.offsetLeft + tab.offsetWidth - element.clientWidth;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tabs, current]);

  const go = (event: React.MouseEvent<HTMLAnchorElement>, to: Parameters<typeof navigate>[0]) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };

  // Left and Right move between tabs, Home and End to the ends; one Tab stop for the whole row.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const all = [...(strip.current?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    all[(to + all.length) % all.length]?.focus();
  };

  const list: MenuItem[] = tabs.map((id) => ({ label: title(id), hint: id === current ? 'Open now' : undefined, icon: <FileText />, onSelect: () => navigate({ page: 'section', id: notebook, section: id }) }));
  const overview: MenuItem = { label: 'Overview', icon: <House />, onSelect: () => navigate({ page: 'notebook', id: notebook, folder: '' }) };
  const reopenItem: MenuItem = { label: 'Reopen closed tab', keys: 'Alt+Shift+T', onSelect: reopen };

  return (
    <header className="flex h-12 shrink-0 items-end gap-1 border-b border-border bg-surface pr-3 pl-2 max-md:h-14 max-md:items-center max-md:gap-2 max-md:px-3">
      <PanelButton className="mb-1.5 max-md:mb-0" />

      {/* A phone: one button that names where you are and lists the open sections. */}
      <MenuButton
        label={`Open sections: ${tabs.length}`}
        className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 text-[14px] font-medium outline-none md:hidden"
        items={[overview, ...(list.length ? ['divider' as const, ...list] : []), ...(reopenable ? ['divider' as const, reopenItem] : [])]}
      >
        {tabs.length > 0 && <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-md bg-brand-soft px-1 text-[11.5px] font-semibold text-brand">{tabs.length}</span>}
        <span className="min-w-0 flex-1 truncate text-left">{current ? title(current) : 'Overview'}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </MenuButton>

      <div ref={strip} role="tablist" aria-label="Open sections" onKeyDown={onKeyDown} className="no-scrollbar flex min-w-0 items-end gap-0.5 self-stretch overflow-x-auto overflow-y-hidden pt-[11px] max-md:hidden">
        <div data-tab className={cn(TAB, onOverview && TAB_CURRENT)}>
          <a
            role="tab"
            aria-selected={onOverview}
            tabIndex={onOverview || !current ? 0 : -1}
            href={href({ page: 'notebook', id: notebook, folder: '' })}
            title={`Overview of ${info.name}`}
            onClick={(event) => go(event, { page: 'notebook', id: notebook, folder: '' })}
            className="flex h-full items-center gap-2 rounded-t-[10px] px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <House className={cn('size-[15px] shrink-0', onOverview && 'text-brand')} aria-hidden="true" />
            Overview
          </a>
        </div>
        {tabs.map((id, index) => {
          const mark = marks(id);
          const selected = id === current;
          return (
            <div
              key={id}
              data-tab
              className={cn(
                TAB,
                'max-w-[220px] min-w-[96px]',
                selected && TAB_CURRENT,
                dropAt === index && 'shadow-[-2px_0_0_var(--accent)]',
                dropAt === tabs.length && index === tabs.length - 1 && 'shadow-[2px_0_0_var(--accent)]',
              )}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_TYPE, id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(TAB_TYPE)) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                setDropAt(event.clientX < box.left + box.width / 2 ? index : index + 1);
              }}
              onDragLeave={() => setDropAt(undefined)}
              onDrop={(event) => {
                event.preventDefault();
                const moved = event.dataTransfer.getData(TAB_TYPE);
                if (moved && dropAt !== undefined) useApp.getState().moveTab(moved, dropAt);
                setDropAt(undefined);
              }}
              onDragEnd={() => setDropAt(undefined)}
            >
              <a
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                href={href({ page: 'section', id: notebook, section: id })}
                title={title(id)}
                onClick={(event) => go(event, { page: 'section', id: notebook, section: id })}
                onAuxClick={(event) => {
                  // A middle-click closes a tab, as in a browser.
                  if (event.button === 1) {
                    event.preventDefault();
                    shut(id);
                  }
                }}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-tl-[10px] pr-1 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <FileText className={cn('size-[15px] shrink-0', selected && 'text-brand')} aria-hidden="true" />
                <span className="truncate">{title(id)}</span>
              </a>
              {/* The marks, and × in their place when the tab is pointed at or focused. */}
              <span className="relative mr-1.5 grid size-6 shrink-0 place-items-center">
                <span className={cn('flex items-center gap-1 transition-opacity group-focus-within/tab:opacity-0 group-hover/tab:opacity-0', !mark.count && 'hidden')}>
                  {mark.agent && <AgentMark label="An AI changed it; not committed yet" className="text-[11px]" />}
                  <WetDot count={mark.count} />
                </span>
                <button
                  type="button"
                  aria-label={`Close ${title(id)}`}
                  title="Close (Alt+W)"
                  onClick={() => shut(id)}
                  className={cn(
                    'absolute inset-0 grid place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-black/[0.07] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/tab:opacity-100',
                    selected && !mark.count && 'opacity-100',
                  )}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      <div className="mb-1.5 flex shrink-0 items-center gap-0.5 max-md:hidden">
        <Tooltip label="New section">
          <button type="button" aria-label="New section" className={BAR_BUTTON} onClick={() => useApp.getState().setNaming({ kind: 'section', folder: '' })}>
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </Tooltip>
        {(overflow || reopenable) && (
          <MenuButton label="All open sections" className={BAR_BUTTON} align="end" items={[...list, ...(reopenable ? [...(list.length ? ['divider' as const] : []), reopenItem] : [])]}>
            <ChevronDown className="size-4" aria-hidden="true" />
          </MenuButton>
        )}
      </div>

      <span className="flex-1 max-md:hidden" />
      <div className="mb-1.5 flex shrink-0 items-center gap-2 max-md:mb-0">
        <Status />
        <HistoryButton />
        <UpdateButton />
        <Bell />
        <Account />
      </div>
    </header>
  );
}

const BAR_BUTTON = 'grid size-8 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-black/[0.05]';

/** Who is working here, and whether the page is saved. */
function Status() {
  const route = useRoute();
  const agents = useApp((state) => state.info?.agents ?? []);
  const online = useApp((state) => state.online);
  const saveState = useApp((state) => state.saveState);
  return (
    <span className="flex items-center gap-2.5" role="status">
      {agents.length > 0 && (
        <Tooltip label={`${agents.join(', ')} ${agents.length === 1 ? 'is' : 'are'} working here`}>
          <span className="flex items-center gap-1.5 rounded-full bg-agent-soft py-0.5 pr-2.5 pl-0.5 text-[12.5px] font-medium text-agent max-lg:pr-0.5" tabIndex={0}>
            <span className="flex -space-x-1.5">
              {agents.slice(0, 3).map((agent) => (
                <Face key={agent} name={agent} agent size={22} className="ring-agent-soft" />
              ))}
            </span>
            <span className="max-lg:hidden">{agents.length === 1 ? agents[0]!.replace(/^Claude via /, '') : `${agents.length} AIs`} here</span>
            <span className="sr-only">{agents.join(', ')} working here</span>
          </span>
        </Tooltip>
      )}
      {!online ? (
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-removed">
          <CloudOff className="size-3.5" aria-hidden="true" />
          <span className="max-lg:sr-only">Reconnecting…</span>
        </span>
      ) : route.page === 'section' ? (
        <span className={cn('flex items-center gap-1 text-[12.5px] text-muted-foreground', saveState === 'offline' && 'text-removed')} title={SAVE_TEXT[saveState]}>
          {saveState === 'saved' ? <Check className="size-3.5 text-added" aria-hidden="true" /> : saveState === 'saving' ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <CloudOff className="size-3.5" aria-hidden="true" />}
          <span className="max-lg:sr-only">{saveState === 'offline' ? 'Not connected' : SAVE_TEXT[saveState]}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Opens and closes the History panel; it carries the number of uncommitted changes, and ✦ when a change waits for you. */
function HistoryButton() {
  const open = useApp((state) => state.historyOpen);
  const pending = useApp((state) => state.info?.pending.length ?? 0);
  const held = useApp((state) => state.info?.held.length ?? 0);
  const label = `History${pending ? `: ${pending} uncommitted` : ''}${held ? `, ${held} waiting for you` : ''}`;
  return (
    <Tooltip label={open ? 'Hide History' : 'History and commit'} keys="Ctrl ↵">
      <button type="button" aria-label={label} aria-pressed={open} onClick={() => useApp.getState().setHistoryOpen(!open)} className={cn(ROUND_BUTTON, 'flex w-auto min-w-9 items-center justify-center gap-1.5 px-2.5 touch:w-auto touch:min-w-10')}>
        <History className="size-[17px]" aria-hidden="true" />
        {pending > 0 && <span className="text-[12.5px] font-semibold tabular-nums">{pending}</span>}
        {held > 0 && <AgentMark label="A change waits for you" className="text-[11px]" />}
      </button>
    </Tooltip>
  );
}
