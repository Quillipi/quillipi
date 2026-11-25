/**
 * What the Quillipi program and the editor send each other. Both sides import these types,
 * so a change here is checked in both places.
 */
import type { Block } from './blocks.js';
import type { Change } from './diff.js';
import type { TreeItem } from './layout.js';

export type Author = 'person' | 'agent';
export type Actor = { kind: 'person' } | { kind: 'agent'; agent: string };

export interface Person {
  name: string;
  email: string;
}

/** The pending change that stands for the notebook's arrangement: its folders, their names, and the order. */
export const LAYOUT_CHANGE = { section: '', key: 'layout' } as const;

/** The pending change that stands for the notebook's AI instructions, its AGENTS.md. Only the person makes it. */
export const INSTRUCTIONS_CHANGE = { section: '', key: 'instructions' } as const;

export interface PendingChange {
  /** A section's ID, or "" for the arrangement (LAYOUT_CHANGE) and the AI instructions (INSTRUCTIONS_CHANGE). */
  section: string;
  /** A block ID, `removed:<id>` for a removed block, `layout` for the arrangement, or `instructions`. */
  key: string;
  change: Change | 'removed';
  by: Author[];
  included: boolean;
  /** Held for the person to review before an agent's commit. */
  held: boolean;
}

export interface CommitSummary {
  oid: string;
  /** Position in history, starting at 1. */
  number: number;
  message: string;
  author: string;
  /** Set when an agent made the change, such as "Claude via Claude Desktop". */
  agent?: string;
  at: number;
}

export interface HeldChange {
  section: string;
  keys: string[];
  reasons: string[];
  message: string;
  agent: string;
  at: number;
}

export interface Activity {
  at: number;
  agent: string;
  text: string;
}

/** Remote access, when Quillipi was started with a public address. See apps/inklog/src/remote.ts. */
export interface RemoteStatus {
  /** The address to add as a connector in Claude. */
  url: string;
  /** An app waiting for the person to type this code on the approval page. */
  pending?: { app: string; code: string; expiresAt: number };
  /** Apps that were approved and can use the notebook. */
  connections: { id: string; app: string; since: number; lastUsed: number }[];
}

export interface RepoInfo {
  name: string;
  /** The notebook's line about what it is for, and its colour, from inklog.json. */
  about?: string;
  colour?: string;
  person: Person;
  /** Every section in tree order, with the folder it is in ("" for the top) and how deep that is. */
  sections: { id: string; title: string; folder: string; depth: number }[];
  /** The folders and sections, as inklog.json keeps them (layout.ts). */
  tree: TreeItem[];
  /** Newest first. */
  commits: CommitSummary[];
  pending: PendingChange[];
  held: HeldChange[];
  activity: Activity[];
  /** Agents that used the tools in the last 15 minutes. */
  agents: string[];
  remote?: RemoteStatus;
  /** How the notebook's backup to GitHub stands, where it has one (the cloud). */
  backup?: BackupState;
}

/** A section a commit touched: how many blocks it added, edited, moved and removed there. */
export interface CommitSection {
  id: string;
  title: string;
  /** Its folder's path after the commit (before it, for a deleted section); "" for the top. */
  folder: string;
  added: number;
  edited: number;
  moved: number;
  removed: number;
  /** Set when the commit made the section, deleted it, or moved it to another folder. */
  what?: 'made' | 'deleted' | 'moved';
}

/** What one commit changed, for the History panel. A commit never changes, so this is worked out once. */
export interface CommitDetails {
  oid: string;
  sections: CommitSection[];
  /** It changed the folders, their names or the order. */
  layout: boolean;
  /** It changed the notebook's AI instructions. */
  instructions: boolean;
  /** It renamed the notebook, or changed its line or colour. */
  details: boolean;
}

/** The notebook's overview: the last commit that changed each section, by section ID. */
export interface NotebookOverview {
  last: Record<string, CommitSummary>;
}

export interface SectionData {
  /** Names this state of the section's text. Opaque: only equality matters (see engine.ts). */
  version: string;
  blocks: Block[];
  /** The section as of the last commit. */
  head: Block[];
}

export interface SaveMessage {
  type: 'save';
  request: number;
  section: string;
  /** The version the editor's blocks are based on. */
  base: string;
  blocks: Block[];
}

/** The engine's answer to a save. after-save.ts says what the editor does with it. */
export interface SaveReply {
  /** The section's version now: the base for the editor's next save. */
  version: string;
  /** The section's text, when it differs from what the editor sent. */
  blocks?: Block[];
  /**
   * The engine didn't know the save's base version (it restarted since, or the version is too old),
   * so it changed nothing and sent its current text instead.
   */
  stale?: true;
}

export type ServerMessage =
  | ({ type: 'saved'; request: number; section: string } & SaveReply)
  | { type: 'error'; request: number; error: string }
  | { type: 'section'; section: string; version: string; blocks: Block[]; actor: Actor }
  | { type: 'repo'; info: RepoInfo };

// ---------------------------------------------------------------------------
// The library: the cloud's list of notebooks, one card each (step 3.3)

/** How a notebook's backup to its GitHub repo stands, in words a person can read. */
export interface BackupState {
  state: 'off' | 'making' | 'importing' | 'pushing' | 'backed-up' | 'retrying' | 'stopped';
  /** One plain sentence, such as "Backed up to octo-notebooks/gym-rollup." or why it stopped. */
  text: string;
  /** The newest commit GitHub has confirmed, so the history can show which commits are safe. */
  pushed?: string;
  /** When GitHub last confirmed a commit, in milliseconds since 1970. */
  at?: number;
}

/** A section with uncommitted changes, or with changes held for the person's review, for Home's tables. */
export interface SectionMark {
  id: string;
  title: string;
  folder: string;
  /** How many changes. */
  count: number;
  /** Whether an agent made any of them. */
  agent: boolean;
}

/** A section someone edited lately, for Home's "Pick up where you left off". */
export interface RecentEdit {
  id: string;
  title: string;
  /** Its folder's path, "" for the top. */
  folder: string;
  /** Who edited it: the owner's name, or an agent such as "Claude via claude.ai". */
  by: string;
  agent: boolean;
  at: number;
}

/**
 * What a notebook's room tells the library about itself after a change, so Home can draw every
 * notebook from one request without waking them.
 */
export interface NotebookSummary {
  title: string;
  about?: string;
  colour?: string;
  sections: number;
  folders: number;
  commits: number;
  /** The latest commit. */
  last?: { number: number; message: string; agent?: string; at: number };
  /** Uncommitted changes, those an agent made, and changes held for the person's review. */
  uncommitted: number;
  agentUncommitted: number;
  held: number;
  /** The four sections edited most recently, newest first. */
  recent: RecentEdit[];
  /** Recent commits made by agents, newest first, for "since your last visit". */
  agentCommits: { number: number; agent: string; message: string; at: number }[];
  /** The sections with uncommitted changes, and those with changes held for review, at most 20 each. */
  pendingSections?: SectionMark[];
  heldSections?: SectionMark[];
  /** The agent that used the notebook's tools last, and when. */
  lastAgent?: { agent: string; at: number };
  backup: BackupState;
}

/** A notebook in the library. Its ID is permanent: its address, its room's name and its repo's name. */
export interface NotebookCard {
  id: string;
  title: string;
  about?: string;
  colour: string;
  /** Who made or added it: the owner's name, or an agent such as "Claude via claude.ai". */
  createdBy: string;
  /**
   * Whether an AI made or added it, from a chat. Cards from before 0.5.0 don't say; for them,
   * `createdBy` is the owner's name when the owner did (madeByAgent in apps/web/src/news.ts).
   */
  byAgent?: boolean;
  createdAt: number;
  /** Made here, or added from a repo already on GitHub. */
  from: 'new' | 'github';
  archived: boolean;
  /** The room's latest report; missing until the room has reported once. */
  summary?: NotebookSummary;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// The app in the cloud (step 3.4a)

/** Who is signed in to the app, and where the notebooks' repos are. */
export interface Me {
  login: string;
  name: string;
  /** The GitHub organization that holds the notebooks' repos. */
  github: string;
}

/** Everything Home draws, in one request. */
export interface HomeData {
  me: Me;
  cards: NotebookCard[];
  /** When the person last opened Home before now; missing on the first visit. */
  lastVisit?: number;
  /** The notebook tools use when they name none. */
  default?: string;
  /** Whether an AI app has connected to this Quillipi at least once, for Home's Get started card. */
  aiConnected: boolean;
  /** A copy's weekly update check, for Get started's Turn on updates; missing where there is no copy's repository to add it to. */
  updates?: Updates;
}

/** A copy's update check: its GitHub repository, and whether its last build found the workflow there. */
export interface Updates {
  /** "owner/name". */
  repository: string;
  on: boolean;
}

/** An AI app connected to Quillipi's door, for the Agents page. */
export interface AgentConnection {
  id: string;
  /** How its work is credited, such as "Claude via claude.ai". */
  app: string;
  since: number;
}

/**
 * What the library tells Home's live connection: every card when it connects, then each change,
 * and `ai` the first time an AI app connects.
 */
export type LibraryMessage = { type: 'cards'; cards: NotebookCard[] } | { type: 'card'; card: NotebookCard } | { type: 'removed'; id: string } | { type: 'ai' };
