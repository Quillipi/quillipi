/** The bell's "since your last visit", Home's backup meter, the notebooks' order and the Get started card (news.ts), which need no browser. */
import type { BackupState, NotebookCard, NotebookSummary, RepoInfo } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { backupDetail, backups, getStarted, homeNews, notebookNews, sortNotebooks } from '../src/news';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15, 12);

function card(id: string, summary: Partial<NotebookSummary> = {}, extra: Partial<NotebookCard> = {}): NotebookCard {
  return {
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    colour: '#c4413b',
    createdBy: 'Karan',
    createdAt: NOW - 30 * 24 * HOUR,
    from: 'new',
    archived: false,
    updatedAt: NOW - HOUR,
    summary: {
      title: id,
      sections: 3,
      folders: 0,
      commits: 2,
      uncommitted: 0,
      agentUncommitted: 0,
      held: 0,
      recent: [],
      agentCommits: [],
      backup: { state: 'backed-up', text: 'Backed up' } as BackupState,
      ...summary,
    },
    ...extra,
  };
}

function info(parts: Partial<RepoInfo>): RepoInfo {
  return {
    name: 'Gym rollup',
    person: { name: 'Karan', email: 'karan@example.com' },
    sections: [
      { id: 'plan', title: 'Plan', folder: '', depth: 0 },
      { id: 'pricing', title: 'Pricing', folder: 'research', depth: 1 },
    ],
    tree: [],
    commits: [],
    pending: [],
    held: [],
    activity: [],
    agents: [],
    ...parts,
  } as RepoInfo;
}

describe("Home's bell", () => {
  it('rings for AI commits since the last visit, and lists uncommitted work without ringing', () => {
    const cards = [
      card('gym', { agentCommits: [{ number: 4, agent: 'Claude via claude.ai', message: 'Add pricing', at: NOW - HOUR }, { number: 3, agent: 'Claude via claude.ai', message: 'Old', at: NOW - 30 * HOUR }], uncommitted: 2 }),
      card('kimet'),
    ];
    const news = homeNews(cards, NOW - 2 * HOUR, NOW);
    expect(news.items.map((item) => [item.text, item.ring, item.agent])).toEqual([
      ['Claude via claude.ai committed once in 1 notebook, last 1h ago', true, true],
      ['2 uncommitted changes in Gym', false, false],
    ]);
    expect(news.actions).toEqual([{ label: 'Open Gym', to: { page: 'notebook', id: 'gym', folder: '' } }]);
  });

  it('on the first visit counts every AI commit, and leads to the first change waiting for review', () => {
    const cards = [card('gym', { held: 2, heldSections: [{ id: 'plan', title: 'Plan', folder: '', count: 2, agent: true }], agentCommits: [{ number: 1, agent: 'Claude', message: 'Start', at: NOW - 100 * HOUR }] })];
    const news = homeNews(cards, undefined, NOW);
    expect(news.items.map((item) => item.text)).toEqual(['Claude committed once in 1 notebook, last 4d ago', '2 changes wait for your review']);
    expect(news.actions[0]).toEqual({ label: 'Review', to: { page: 'section', id: 'gym', section: 'plan' } });
  });

  it('says nothing about archived notebooks, and folds uncommitted work in many notebooks into one line', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id) => card(id, { uncommitted: 1 }));
    cards.push(card('old', { agentCommits: [{ number: 9, agent: 'Claude', message: 'x', at: NOW }] }, { archived: true }));
    const news = homeNews(cards, NOW - HOUR, NOW);
    expect(news.items.map((item) => item.text)).toEqual(['4 uncommitted changes in 4 notebooks']);
    expect(news.items.some((item) => item.ring)).toBe(false);
  });
});

describe("a notebook's bell", () => {
  it('knows nothing until the visit is recorded, then counts AI commits after it', () => {
    const commits = [
      { oid: 'c', number: 3, message: 'Add pricing', author: 'Karan', agent: 'Claude via claude.ai', at: NOW - HOUR },
      { oid: 'b', number: 2, message: 'Fix the plan', author: 'Karan', at: NOW - 2 * HOUR },
      { oid: 'a', number: 1, message: 'Start', author: 'Karan', agent: 'Claude via claude.ai', at: NOW - 50 * HOUR },
    ];
    expect(notebookNews(info({ commits }), 'gym', undefined).items).toEqual([]);
    expect(notebookNews(info({ commits }), 'gym', NOW - 3 * HOUR).items.map((item) => item.text)).toEqual(['Claude via claude.ai committed once: #3 Add pricing']);
    expect(notebookNews(info({ commits }), 'gym', null).items.map((item) => item.text)).toEqual(['Claude via claude.ai committed 2 times: #3 Add pricing; #1 Start']);
  });

  it("names the sections an AI changed, and leads to the change waiting for review first", () => {
    const pending = [
      { section: 'pricing', key: 'k1', change: 'edited', by: ['agent'], included: true, held: false },
      { section: '', key: 'layout', change: 'edited', by: ['agent'], included: true, held: false },
      { section: 'plan', key: 'k2', change: 'edited', by: ['person'], included: true, held: false },
    ] as unknown as RepoInfo['pending'];
    const held = [{ section: 'plan', keys: ['k2'], reasons: ['deletes a lot'], message: 'Trim', agent: 'Claude' }] as unknown as RepoInfo['held'];
    const news = notebookNews(info({ pending, held }), 'gym', NOW);
    expect(news.items.map((item) => [item.text, item.ring])).toEqual([
      ['An AI changed Pricing, not committed yet', true],
      ['1 change waits for your review', true],
    ]);
    expect(news.actions).toEqual([{ label: 'Review changes', to: { page: 'section', id: 'gym', section: 'plan' } }]);
  });
});

describe("Home's backup meter", () => {
  it('counts the notebooks safe on GitHub, and those in trouble, leaving out archived ones and ones not reported yet', () => {
    const state = (value: BackupState['state']) => ({ backup: { state: value, text: '' } as BackupState });
    const cards = [card('a', state('backed-up')), card('b', state('pushing')), card('c', state('making')), card('d', state('stopped')), card('e', state('backed-up'), { archived: true }), { ...card('f'), summary: undefined }];
    expect(backups(cards)).toEqual({ safe: 2, total: 4, trouble: 1 });
  });
});

describe("the backup card's sentence", () => {
  it("drops its first words when they say the card's title again", () => {
    expect(backupDetail('Not backed up: the GitHub App is not set up here.', 'Not backed up')).toBe('The GitHub App is not set up here.');
    expect(backupDetail('owner/gym: 2 commit(s) waiting to be pushed.', 'Backing up…')).toBe('owner/gym: 2 commit(s) waiting to be pushed.');
  });
});

describe("Home's notebooks", () => {
  it('sort by last change, by title ignoring case, or newest made', () => {
    const cards = [card('beta', {}, { updatedAt: 3, createdAt: 1 }), card('alpha', {}, { updatedAt: 1, createdAt: 3, title: 'alpha' }), card('gamma', {}, { updatedAt: 2, createdAt: 2 })];
    expect(sortNotebooks(cards, 'changed').map((each) => each.id)).toEqual(['beta', 'gamma', 'alpha']);
    expect(sortNotebooks(cards, 'title').map((each) => each.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sortNotebooks(cards, 'made').map((each) => each.id)).toEqual(['alpha', 'gamma', 'beta']);
    expect(cards.map((each) => each.id)).toEqual(['beta', 'alpha', 'gamma']);
  });
});

describe("Home's Get started card", () => {
  it('ticks Claude and a notebook that isn’t archived, and goes once both are done', () => {
    expect(getStarted([], false)).toEqual({ claude: false, notebook: false, done: 0, total: 2, show: true });
    expect(getStarted([card('gym', {}, { archived: true })], true)).toEqual({ claude: true, notebook: false, done: 1, total: 2, show: true });
    expect(getStarted([card('gym')], false)).toEqual({ claude: false, notebook: true, done: 1, total: 2, show: true });
    expect(getStarted([card('gym'), card('plan', {}, { archived: true })], true)).toEqual({ claude: true, notebook: true, done: 2, total: 2, show: false });
  });

  it("has Turn on updates first in a copy, and comes back for it in a copy that was set up before it existed", () => {
    const off = { repository: 'Ki-met/quillipi', on: false };
    expect(getStarted([], false, off)).toEqual({ updates: false, claude: false, notebook: false, done: 0, total: 3, show: true });
    // Like the copy from the newcomer test: Claude and a notebook done, the workflow never added.
    expect(getStarted([card('kimet-plan')], true, off)).toEqual({ updates: false, claude: true, notebook: true, done: 2, total: 3, show: true });
    expect(getStarted([card('kimet-plan')], true, { ...off, on: true })).toMatchObject({ updates: true, done: 3, total: 3, show: false });
  });
});
