/**
 * What the bell says ("since your last visit") and how Home's top bar reads the backups, worked out
 * from the library's cards and a notebook's info. Kept apart from the components, so it is tested
 * in Node.
 *
 * The bell shows a dot only for what happened while you were away: an AI committed, or a change
 * waits for your review. Uncommitted work is listed, as it always was, but it is yours, so it
 * doesn't ring the bell.
 */
import { type NotebookCard, type RepoInfo, type Updates, formatAgo } from '@inklog/core';
import type { Route } from './router';

export interface NewsItem {
  key: string;
  text: string;
  /** An AI did it: drawn with ✦ in orange. */
  agent: boolean;
  /** Something that happened while you were away, which puts the dot on the bell. */
  ring: boolean;
}

export interface News {
  items: NewsItem[];
  /** At most two: the first is the main one. */
  actions: { label: string; to: Route }[];
}

/** Home's news, across every notebook not archived. `lastVisit` is missing on the first visit. */
export function homeNews(cards: NotebookCard[], lastVisit: number | undefined, now: number): News {
  const live = cards.filter((card) => !card.archived);
  const commits = live
    .flatMap((card) => (card.summary?.agentCommits ?? []).filter((commit) => lastVisit === undefined || commit.at > lastVisit).map((commit) => ({ card, commit })))
    .sort((a, b) => b.commit.at - a.commit.at);
  const waiting = live.filter((card) => (card.summary?.held ?? 0) > 0);
  const held = waiting.reduce((sum, card) => sum + (card.summary?.held ?? 0), 0);
  const uncommitted = live.filter((card) => (card.summary?.uncommitted ?? 0) > 0);
  const items: NewsItem[] = [];

  if (commits.length) {
    const agents = [...new Set(commits.map(({ commit }) => commit.agent))].join(', ');
    const notebooks = new Set(commits.map(({ card }) => card.id)).size;
    items.push({ key: 'commits', agent: true, ring: true, text: `${agents} committed ${times(commits.length)} in ${plural(notebooks, 'notebook')}, last ${formatAgo(commits[0]!.commit.at, now)}` });
  }
  if (held) items.push({ key: 'held', agent: true, ring: true, text: waits(held) });
  if (uncommitted.length > 3) {
    const total = uncommitted.reduce((sum, card) => sum + card.summary!.uncommitted, 0);
    items.push({ key: 'wet', agent: false, ring: false, text: `${plural(total, 'uncommitted change')} in ${plural(uncommitted.length, 'notebook')}` });
  } else {
    for (const card of uncommitted) items.push({ key: `wet:${card.id}`, agent: false, ring: false, text: `${plural(card.summary!.uncommitted, 'uncommitted change')} in ${card.title}` });
  }

  const actions: News['actions'] = [];
  const review = waiting[0];
  if (review) {
    const section = review.summary?.heldSections?.[0];
    actions.push({ label: 'Review', to: section ? { page: 'section', id: review.id, section: section.id } : { page: 'notebook', id: review.id, folder: '' } });
  }
  const changed = commits[0]?.card ?? uncommitted[0];
  if (changed) actions.push({ label: `Open ${changed.title}`, to: { page: 'notebook', id: changed.id, folder: '' } });
  return { items, actions };
}

/**
 * A notebook's news: what AIs committed since you last opened it (`before`: null the first time,
 * undefined until the visit is known), what an AI changed that isn't committed, and what waits for
 * your review.
 */
export function notebookNews(info: RepoInfo, notebook: string, before: number | null | undefined): News {
  const commits = before === undefined ? [] : info.commits.filter((commit) => commit.agent && (before === null || commit.at > before));
  const changed = [...new Set(info.pending.filter((change) => change.section && change.by.includes('agent')).map((change) => change.section))];
  const titles = new Map(info.sections.map((section) => [section.id, section.title]));
  const items: NewsItem[] = [];

  if (commits.length) {
    const agents = [...new Set(commits.map((commit) => commit.agent!))].join(', ');
    const latest = commits.slice(0, 2).map((commit) => `#${commit.number} ${commit.message}`).join('; ');
    items.push({ key: 'commits', agent: true, ring: true, text: `${agents} committed ${times(commits.length)}: ${latest}${commits.length > 2 ? '…' : ''}` });
  }
  if (changed.length) {
    const names = changed.slice(0, 3).map((id) => titles.get(id) ?? id).join(', ');
    items.push({ key: 'changed', agent: true, ring: true, text: `An AI changed ${names}${changed.length > 3 ? '…' : ''}, not committed yet` });
  }
  if (info.held.length) items.push({ key: 'held', agent: true, ring: true, text: waits(info.held.length) });

  const review = info.held.find((change) => change.section)?.section || changed[0];
  return { items, actions: review ? [{ label: 'Review changes', to: { page: 'section', id: notebook, section: review } }] : [] };
}

/** How the notebooks' backups to GitHub stand, for Home's top bar. */
export function backups(cards: NotebookCard[]): { safe: number; total: number; trouble: number } {
  const states = cards.filter((card) => !card.archived && card.summary).map((card) => card.summary!.backup.state);
  return {
    safe: states.filter((state) => state === 'backed-up' || state === 'pushing').length,
    total: states.length,
    trouble: states.filter((state) => state === 'off' || state === 'retrying' || state === 'stopped').length,
  };
}

/**
 * The backup's sentence for a card under `title`, without its first words when they say the title
 * again: "Not backed up: the GitHub App is not set up here." under "Not backed up" reads "The
 * GitHub App is not set up here."
 */
export function backupDetail(text: string, title: string): string {
  const prefix = `${title}:`.toLowerCase();
  if (!text.toLowerCase().startsWith(prefix)) return text;
  const rest = text.slice(prefix.length).trim();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export type NotebookOrder = 'changed' | 'title' | 'made';

/** The notebooks in the order Home's row is sorted by: last changed, by title, or newest made. */
export function sortNotebooks(cards: NotebookCard[], order: NotebookOrder): NotebookCard[] {
  const sorted = [...cards];
  if (order === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (order === 'made') sorted.sort((a, b) => b.createdAt - a.createdAt);
  else sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted;
}

function times(n: number): string {
  return n === 1 ? 'once' : `${n} times`;
}

function waits(n: number): string {
  return n === 1 ? '1 change waits for your review' : `${n} changes wait for your review`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Home's Get started card: which of its steps are done, and whether it shows at all. A copy made
 * with the Deploy to Cloudflare button has a first step, Turn on updates, until its build finds
 * the update workflow; a Quillipi with no copy's repository has only the other two.
 */
export interface GetStarted {
  /** Missing where there is no Turn on updates step. */
  updates?: boolean;
  claude: boolean;
  /** A notebook that isn't archived. */
  notebook: boolean;
  done: number;
  total: number;
  show: boolean;
}

export function getStarted(cards: NotebookCard[], claudeConnected: boolean, updates?: Updates): GetStarted {
  const notebook = cards.some((card) => !card.archived);
  const steps = [...(updates ? [updates.on] : []), claudeConnected, notebook];
  const done = steps.filter(Boolean).length;
  return { ...(updates ? { updates: updates.on } : {}), claude: claudeConnected, notebook, done, total: steps.length, show: done < steps.length };
}
