/**
 * App-wide state. `useApp` is the open notebook: what it looks like, which sections are open and
 * what is shown; it starts afresh whenever another notebook opens. `useShelf` is everything around
 * the notebooks: who is signed in and, in the cloud, the library's cards, kept live.
 */
import type { HomeData, Me, NotebookCard, RepoInfo, Updates } from '@inklog/core';
import { create } from 'zustand';
import { api } from './api';
import type { SaveState } from './editor/sync';
import { type Heading, moveTab } from './tree/model';

export type View = 'doc' | 'file' | 'agent';

interface AppState {
  /** The notebook open now, and its info once it has loaded. */
  notebook?: string;
  info?: RepoInfo;
  online: boolean;
  tabs: string[];
  active?: string;
  view: View;
  /** A commit shown read-only instead of the live section. */
  viewing?: string;
  /** A commit the margin compares against, instead of the last commit. */
  compareWith?: string;
  /** Whether the History panel shows, remembered; and a count that rises each time its commit message should take focus. */
  historyOpen: boolean;
  commitFocus: number;
  /** A new section or folder being named, and the folder it goes in ("" for the top). */
  naming?: Naming;
  /** The open section's save state, shown beside the tabs. */
  saveState: SaveState;
  /** The open section's headings, for its row in the tree, and the one being read now. */
  outline?: { section: string; headings: Heading[] };
  reading?: string;
  /** Tabs closed lately, newest last, so one can be opened again. */
  closed: string[];
  /**
   * When you opened this notebook before this time, for the bell's "since your last visit": null
   * the first time, undefined until the visit has been recorded.
   */
  visitedBefore?: number | null;
  /** The folders open in the tree, by path, remembered per notebook. */
  expanded: string[];
  /** Opens another notebook: its saved tabs come back, everything else starts afresh. */
  openNotebook(id: string | undefined): void;
  setInfo(info: RepoInfo): void;
  setOnline(online: boolean): void;
  open(id: string): void;
  close(id: string): void;
  setView(view: View): void;
  viewCommit(commit?: string): void;
  compare(commit?: string): void;
  /** Shows or hides the History panel; with `focus`, the caret goes to the commit message. */
  setHistoryOpen(open: boolean, focus?: boolean): void;
  setNaming(naming?: Naming): void;
  setSaveState(saveState: SaveState): void;
  setOutline(outline?: { section: string; headings: Heading[] }): void;
  setReading(reading?: string): void;
  moveTab(id: string, to: number): void;
  /** The tab closed most recently, if its section still exists. */
  reopen(): string | undefined;
  setExpanded(path: string, open: boolean): void;
}

export type Naming = { kind: 'section' | 'folder'; folder: string } | { kind: 'rename'; folder: string; name: string };

/** The open tabs are remembered per notebook, because one address serves several notebooks. */
const tabsKey = (id: string) => `inklog:${id}`;

function read(key: string): { tabs?: string[]; active?: string; expanded?: string[] } {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

const HISTORY_KEY = 'inklog:history';
/** From this width the History panel sits beside the page; below it, it lies over the page (Tailwind's `lg`). */
const HISTORY_BESIDE = 1024;

/**
 * The History panel starts open where there is room for it beside the page and the panel (1440 px),
 * and after that as it was left. Where it lies over the page it always starts closed.
 */
function historyStartsOpen(): boolean {
  if (window.innerWidth < HISTORY_BESIDE) return false;
  const saved = localStorage.getItem(HISTORY_KEY);
  return saved ? saved === 'open' : window.innerWidth >= 1440;
}

export const useApp = create<AppState>()((set, get) => ({
  online: false,
  tabs: [],
  view: 'doc',
  historyOpen: historyStartsOpen(),
  commitFocus: 0,
  saveState: 'saved',
  closed: [],
  expanded: [],
  openNotebook: (id) => {
    const saved = id ? read(tabsKey(id)) : {};
    set({
      notebook: id,
      info: undefined,
      online: false,
      tabs: saved.tabs ?? [],
      active: saved.active,
      expanded: saved.expanded ?? [],
      closed: [],
      view: 'doc',
      viewing: undefined,
      compareWith: undefined,
      naming: undefined,
      saveState: 'saved',
      outline: undefined,
      reading: undefined,
      visitedBefore: undefined,
    });
  },
  setInfo: (info) =>
    set((state) => {
      // Drop tabs for sections that no longer exist.
      const ids = new Set(info.sections.map((section) => section.id));
      const tabs = state.tabs.filter((id) => ids.has(id));
      const active = state.active && ids.has(state.active) ? state.active : tabs[0];
      return { info, tabs, active };
    }),
  setOnline: (online) => set({ online }),
  open: (id) => set((state) => ({ active: id, tabs: state.tabs.includes(id) ? state.tabs : [...state.tabs, id], viewing: undefined })),
  close: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab !== id);
      const index = state.tabs.indexOf(id);
      return {
        tabs,
        active: state.active === id ? (tabs[Math.max(0, index - 1)] ?? undefined) : state.active,
        closed: [...state.closed.filter((tab) => tab !== id), id].slice(-20),
      };
    }),
  setView: (view) => set({ view }),
  viewCommit: (viewing) => set({ viewing }),
  compare: (compareWith) => set({ compareWith, viewing: undefined }),
  setHistoryOpen: (historyOpen, focus = false) => {
    // Only a choice made beside the page is remembered: over the page, it is open just while it is used.
    if (window.innerWidth >= HISTORY_BESIDE) localStorage.setItem(HISTORY_KEY, historyOpen ? 'open' : 'closed');
    set((state) => ({ historyOpen, commitFocus: focus ? state.commitFocus + 1 : state.commitFocus }));
  },
  setNaming: (naming) => set({ naming }),
  setSaveState: (saveState) => set({ saveState }),
  setOutline: (outline) => set({ outline }),
  setReading: (reading) => set({ reading }),
  moveTab: (id, to) => set((state) => ({ tabs: moveTab(state.tabs, id, to) })),
  reopen: () => {
    const { closed, info } = get();
    const exists = new Set(info?.sections.map((section) => section.id));
    const id = [...closed].reverse().find((tab) => exists.has(tab));
    if (id) set((state) => ({ closed: state.closed.filter((tab) => tab !== id) }));
    return id;
  },
  setExpanded: (path, open) => set((state) => ({ expanded: open ? [...new Set([...state.expanded, path])] : state.expanded.filter((other) => other !== path) })),
}));

// Written only when what is remembered changed, not on every keystroke's save state or scroll.
useApp.subscribe((state, before) => {
  if (!state.notebook) return;
  if (state.notebook === before.notebook && state.tabs === before.tabs && state.active === before.active && state.expanded === before.expanded) return;
  localStorage.setItem(tabsKey(state.notebook), JSON.stringify({ tabs: state.tabs, active: state.active, expanded: state.expanded }));
});

/** The notebook last open, for the rail's Notebook button. */
const LAST_KEY = 'inklog:last';

export function lastNotebook(): string | undefined {
  return localStorage.getItem(LAST_KEY) ?? undefined;
}

export function rememberNotebook(id: string): void {
  localStorage.setItem(LAST_KEY, id);
}

interface ShelfState {
  /** Which Quillipi this is: the cloud, with many notebooks, or the laptop, with one. */
  host?: 'cloud' | 'laptop';
  me?: Me;
  /** In the cloud, every notebook's card, kept live by the library's connection. */
  cards: NotebookCard[];
  /** Whether the cards have come in at least once, and whether Home's own data (with the last visit) has. */
  loaded: boolean;
  homeLoaded: boolean;
  /** Home's "since your last visit": the visit before this time the app was opened. */
  lastVisit?: number;
  default?: string;
  /** Whether Claude has connected at least once: Home's Get started card asks until it has. */
  claudeConnected: boolean;
  /** A copy's update check, for Get started's Turn on updates; missing where there is no step. */
  updates?: Updates;
  /** The New notebook dialog, opened from the rail, Home, the switcher and the New tile. */
  creating: boolean;
  setHome(home: HomeData): void;
  setCards(cards: NotebookCard[]): void;
  putCard(card: NotebookCard): void;
  removeCard(id: string): void;
  setClaudeConnected(): void;
  setUpdates(updates: Updates | undefined): void;
  setCreating(creating: boolean): void;
}

export const useShelf = create<ShelfState>()((set) => ({
  cards: [],
  loaded: false,
  homeLoaded: false,
  claudeConnected: false,
  creating: false,
  setHome: ({ me, cards, lastVisit, default: fallback, claudeConnected, updates }) => set({ me, cards: sortCards(cards), loaded: true, homeLoaded: true, lastVisit, default: fallback, claudeConnected, updates }),
  setCards: (cards) => set({ cards: sortCards(cards), loaded: true }),
  putCard: (card) => set((state) => ({ cards: sortCards([card, ...state.cards.filter((other) => other.id !== card.id)]) })),
  removeCard: (id) => set((state) => ({ cards: state.cards.filter((card) => card.id !== id) })),
  setClaudeConnected: () => set({ claudeConnected: true }),
  setUpdates: (updates) => set({ updates }),
  setCreating: (creating) => set({ creating }),
}));

/**
 * Home's data, asked for once per app load, by Home or by Agents (for the default notebook):
 * the answer records a visit, so asking again would move "since your last visit" to now.
 */
let homeLoad: Promise<void> | undefined;

export function loadHome(): Promise<void> {
  homeLoad ??= api.home().then((home) => useShelf.getState().setHome(home));
  homeLoad.catch(() => {
    homeLoad = undefined;
  });
  return homeLoad;
}

/** The notebook changed most recently first, as the library sends them. */
function sortCards(cards: NotebookCard[]): NotebookCard[] {
  return [...cards].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
