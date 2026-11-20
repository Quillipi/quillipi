/**
 * The GitHub mirror: each cloud notebook keeps its history in the private repo named after its
 * ID, in the organization for notebooks, such as octo-notebooks/gym-rollup.
 *
 * - **Making the repo.** A notebook made in the cloud is usable at once; its repo is made in the
 *   background with GitHub's starter commit (GitHub refuses an empty repo), and main is then moved
 *   from that starter to the cloud's own first commit, so GitHub's history is exactly the cloud's.
 * - **Import.** The first tool call on a notebook the cloud doesn't have yet finds its repo and
 *   copies its history in, under GitHub's own commit IDs. Tool calls wait until it is done and
 *   say how far it has got.
 * - **Push.** After every new commit, the mirror recreates it on GitHub and checks that GitHub
 *   gives it the same ID. If an ID differs, or main moved without the cloud (the laptop pushed),
 *   the mirror stops and says so instead of letting the two histories split.
 *
 * A Worker on the free plan may make only 50 outgoing requests per invocation, so the work runs
 * in steps of at most `requestsPerStep` requests, from the Durable Object's alarm, saving its
 * progress as it goes. Failures are tried again after growing waits, from 30 seconds to 30 minutes.
 */
import type { BackupState } from '@inklog/core';
import { UserError, blobId, checkPath, commitMessage, treeId } from '@inklog/engine';
import type { CommitDetail, DurableStore, QueuedCommit } from './durable-store.js';
import { Budget, type GitHubApp, type ListedCommit, type NewTreeEntry, OutOfRequests, type RepoClient } from './github.js';

/** Requests per step, safely under the free plan's 50, which also counts the token request. */
export const REQUESTS_PER_STEP = 40;
/** A push waits this long after a commit, so a burst of commits goes out together. */
export const PUSH_DELAY_MS = 1000;
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 30 * 60_000;
/** Blobs fetched at once during an import. */
const PARALLEL = 8;
const STATE_KEY = 'mirror';
/** While GitHub is still making a new repo, look again this soon, for this long, before counting failures. */
const NEW_REPO_WAIT_MS = 2000;
const NEW_REPO_PATIENCE_MS = 2 * 60_000;

interface Creating {
  state: 'creating';
  /** When the notebook was made, in milliseconds since 1970. */
  since: number;
  /** GitHub's starter commit on main, once the repo is made and checked. */
  starter?: string;
}

interface Importing {
  state: 'importing';
  /** Where main was when the import began; the import copies the history up to here. */
  head: string;
}

interface Mirroring {
  state: 'mirroring';
  /** The latest commit that is on GitHub's main. */
  pushed: string;
  /** When GitHub confirmed it. */
  at?: number;
}

interface Stopped {
  state: 'stopped';
  reason: string;
  /** What carries on when a person retries. */
  resume: Creating | Importing | Mirroring;
}

interface Retrying {
  failures?: number;
  /** When the next try is due, in milliseconds since 1970. */
  retryAt?: number;
  lastError?: string;
}

export type MirrorState = (Creating | Importing | Mirroring | Stopped) & Retrying;

/** Something a person must look at; the mirror doesn't try again by itself. */
export class MirrorStop extends Error {}

/** GitHub is still making a new repo; look again in a moment. */
class NotReady extends Error {}

export interface MirrorOptions {
  app: GitHubApp;
  store: DurableStore;
  /** The notebook's ID, which is also its repo's name. */
  notebook: string;
  /** The line a new repo gets as its description on GitHub. */
  description?: () => Promise<string>;
  /** Asks for step() to run no later than `time` (the Durable Object's alarm). */
  schedule: (time: number) => Promise<void>;
  now?: () => number;
  requestsPerStep?: number;
}

export class Mirror {
  readonly repo: string;
  private readonly store: DurableStore;
  private readonly now: () => number;
  /** Mirror work runs one piece at a time, though a tool call and the alarm may both ask for it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MirrorOptions) {
    this.repo = `${options.app.owner}/${options.notebook}`;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  /**
   * Makes the notebook ready for a tool call: imports it on first use, and moves an import along.
   * Throws a UserError saying why, when the notebook can't be used yet.
   */
  ready(): Promise<void> {
    return this.serially(async () => {
      let state = this.load();
      const budget = this.budget();
      if (!state) {
        // A notebook that began in the cloud before the mirror existed has no repo to follow.
        if (this.store.commitCount() > 0) return;
        state = await this.link(budget);
      }
      if (state.state === 'importing' && !this.waiting(state)) state = await this.advance(state, budget);
      // A new notebook works at once; its repo is made in the background.
      const working = state.state === 'stopped' ? state.resume.state : state.state;
      if (working === 'mirroring' || working === 'creating') return;
      if (this.waiting(state)) await this.options.schedule(state.retryAt!);
      throw new UserError(`${this.options.notebook} is being imported from GitHub. ${this.describe(state)}`);
    });
  }

  /** For a notebook just made in the cloud: its repo is to be made, starting now. */
  async begin(): Promise<void> {
    await this.serially(async () => {
      if (this.load()) throw new Error('This notebook already has a GitHub mirror.');
      this.save({ state: 'creating', since: this.now() });
      await this.options.schedule(this.now());
    });
  }

  /**
   * For a notebook added from a repo already on GitHub: checks the repo and begins the import,
   * which then runs in the background. Throws a UserError saying what is missing.
   */
  adopt(): Promise<string> {
    return this.serially(async () => {
      let state = this.load();
      if (!state && this.store.commitCount() === 0) {
        state = await this.link(this.budget());
        await this.options.schedule(this.now());
      }
      return this.status();
    });
  }

  /** After a tool call: asks for a push if there are commits GitHub doesn't have yet. */
  async changed(): Promise<void> {
    const state = this.load();
    if (state?.state !== 'mirroring' || this.store.commitsSince(state.pushed).length === 0) return;
    await this.options.schedule(Math.max(this.now() + PUSH_DELAY_MS, state.retryAt ?? 0));
  }

  /** One step of importing or pushing, run by the alarm. */
  step(): Promise<void> {
    return this.serially(async () => {
      const state = this.load();
      if (!state || state.state === 'stopped') return;
      if (this.waiting(state)) return this.options.schedule(state.retryAt!);
      await this.advance(state, this.budget());
    });
  }

  /** Carries on after a stop or a failure, at once. */
  retry(): Promise<string> {
    return this.serially(async () => {
      const state = this.load();
      if (!state) return `Nothing to retry: ${this.status()}`;
      const resumed = state.state === 'stopped' ? state.resume : { ...state, failures: undefined, retryAt: undefined, lastError: undefined };
      this.save(resumed);
      await this.options.schedule(this.now());
      return `Retrying. ${this.describe(resumed)}`;
    });
  }

  /** One line on how the mirror stands. */
  status(): string {
    const state = this.load();
    if (state) return this.describe(state);
    return this.store.commitCount() > 0
      ? `${this.repo}: not linked, because this notebook began in the cloud before the GitHub mirror.`
      : `${this.repo}: not imported yet; the first tool call imports it.`;
  }

  /** How the backup stands, for the notebook's card on Home. */
  backup(): BackupState {
    const state = this.load();
    if (!state) {
      return this.store.commitCount() > 0
        ? { state: 'off', text: `Not backed up: this notebook began in the cloud before the GitHub mirror.` }
        : { state: 'importing', text: `${this.repo}: not imported yet.` };
    }
    const text = this.describe(state);
    if (state.state === 'stopped') return { state: 'stopped', text };
    if (state.failures) return { state: 'retrying', text, ...(state.state === 'mirroring' ? confirmed(state) : {}) };
    if (state.state === 'creating') return { state: 'making', text };
    if (state.state === 'importing') return { state: 'importing', text };
    const waiting = this.store.commitsSince(state.pushed).length > 0;
    return { state: waiting ? 'pushing' : 'backed-up', text, ...confirmed(state) };
  }

  /** A warning for agents when the mirror needs a person, or undefined when all is well. */
  notice(): string | undefined {
    const state = this.load();
    return state && (state.state === 'stopped' || state.failures) ? `⚠ GitHub mirror: ${this.describe(state)}` : undefined;
  }

  // Steps -----------------------------------------------------------------------

  /** Finds the notebook's repo and begins the import. */
  private async link(budget: Budget): Promise<MirrorState> {
    const repo = this.options.app.repo(this.options.notebook, budget);
    try {
      if (!(await this.options.app.installation(this.options.notebook, budget))) {
        throw new UserError(
          `There is no notebook "${this.options.notebook}" yet. Its history lives in the GitHub repo ${this.repo}, which doesn't exist or doesn't have the GitHub App installed. Push the notebook there from the laptop, install the App on the repo, then try again.`,
        );
      }
      const main = await repo.main();
      if (main === 'empty' || main === undefined) {
        throw new UserError(`${this.repo} has ${main === 'empty' ? 'no commits' : 'no main branch'} yet. Push the notebook from the laptop, then try again.`);
      }
      if (!(await repo.hasFile('inklog.json', main))) throw new UserError(`${this.repo} isn't a Quillipi notebook: it has no inklog.json.`);
      const state: MirrorState = { state: 'importing', head: main };
      this.save(state);
      return state;
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(`Couldn't look for ${this.repo} on GitHub: ${message(error)}. Try again shortly.`);
    }
  }

  /** Runs one import or push step, and records how it ended. */
  private async advance(state: MirrorState, budget: Budget): Promise<MirrorState> {
    const repo = this.options.app.repo(this.options.notebook, budget);
    try {
      if (state.state === 'creating') await this.createStep(state, repo, budget);
      else if (state.state === 'importing') await this.importStep(state, repo, budget);
      else if (state.state === 'mirroring') await this.pushStep(state, repo, budget);
      return await this.settle(this.now());
    } catch (error) {
      const now = this.now();
      if (error instanceof OutOfRequests) return this.settle(now);
      const latest = this.load()!;
      if (error instanceof NotReady && latest.state === 'creating' && now - latest.since < NEW_REPO_PATIENCE_MS) {
        await this.options.schedule(now + NEW_REPO_WAIT_MS);
        return latest;
      }
      if (error instanceof MirrorStop) {
        const stopped: MirrorState = { state: 'stopped', reason: error.message, resume: latest.state === 'stopped' ? latest.resume : clean(latest) };
        this.save(stopped);
        return stopped;
      }
      const failures = (latest.failures ?? 0) + 1;
      const retryAt = now + Math.min(FIRST_WAIT_MS * 2 ** (failures - 1), LONGEST_WAIT_MS);
      const failed: MirrorState = { ...latest, failures, retryAt, lastError: message(error) };
      this.save(failed);
      await this.options.schedule(retryAt);
      return failed;
    }
  }

  /** After a step that went well: forgets earlier failures and asks for the next step if work is left. */
  private async settle(now: number): Promise<MirrorState> {
    const state = clean(this.load()!);
    this.save(state);
    if (state.state === 'importing' || (state.state === 'mirroring' && this.store.commitsSince(state.pushed).length)) await this.options.schedule(now);
    return state;
  }

  /**
   * Makes the repo and puts the notebook's first commit on it. GitHub makes it with a starter
   * commit, which is checked to be exactly that (one commit, only a README), so a repo that was
   * already there with someone's work is never overwritten; then main is moved, with force, from
   * the starter to the cloud's first commit. The commits after it go out as ordinary pushes.
   */
  private async createStep(state: Creating, repo: RepoClient, budget: Budget): Promise<void> {
    let starter = state.starter;
    if (!starter) {
      const description = (await this.options.description?.()) ?? '';
      const made = await this.options.app.createRepo(this.options.notebook, description, budget);
      const main = await repo.main();
      if (main === 'empty' || main === undefined) throw new NotReady(`${this.repo} is still being made on GitHub.`);
      if (!(await this.isStarter(main, repo))) {
        throw new MirrorStop(
          made === 'exists'
            ? `A repo called ${this.repo} was already on GitHub, with work that isn't this notebook's, so it was left alone. Rename or move that repo on GitHub, then retry.`
            : `GitHub made ${this.repo} with a first commit Quillipi didn't expect, so it was left alone.`,
        );
      }
      starter = main;
      this.save({ ...state, starter });
    }
    const [root] = this.store.commitsSince(undefined);
    if (!root) throw new MirrorStop('This notebook has no commits to put on GitHub.');
    const commit = this.store.commitDetail(root)!;
    const plan = this.treePlan(commit);
    if (budget.left < plan.uploads.length + 4) throw new OutOfRequests();
    await this.recreate(commit, plan, repo);
    if ((await repo.main()) !== starter) throw new MirrorStop(`On GitHub, main of ${this.repo} moved while Quillipi was setting it up, so it was left alone.`);
    await repo.replaceMain(root);
    this.save({ state: 'mirroring', pushed: root, at: this.now() });
  }

  /** Whether main is GitHub's starter commit and nothing more: one commit holding only a README. */
  private async isStarter(main: string, repo: RepoClient): Promise<boolean> {
    const [first, ...more] = await repo.commits(main);
    if (!first || more.length || first.parents.length) return false;
    const { entries } = await repo.tree(first.commit.tree.sha);
    return entries.length === 1 && entries[0]!.path === 'README.md' && entries[0]!.type === 'blob';
  }

  /**
   * Lists the history from GitHub into the import queue, then imports the commits oldest first:
   * each commit's tree, every blob not yet stored, and a check that the files give GitHub's tree
   * ID. Progress lives in the queue and the commits, so a step can stop anywhere.
   */
  private async importStep(state: Importing, repo: RepoClient, budget: Budget): Promise<void> {
    for (let next = this.listFrom(state); next; next = this.listFrom(state)) {
      this.store.queueImport(firstParents(next, await repo.commits(next)));
    }
    for (let commit = this.store.nextImport(); commit; commit = this.store.nextImport()) {
      const files = await this.filesOf(commit, repo, budget);
      if (!files) return; // the step's requests ran out halfway through this commit's blobs
      if ((await treeId(files)) !== commit.tree) throw new MirrorStop(`The files of commit ${short(commit.oid)} don't give GitHub's tree ${short(commit.tree)}.`);
      this.store.importCommit(commit, files);
    }
    if ((await this.store.head()) !== state.head) throw new MirrorStop(`The import ended at ${short(await this.store.head())}, not at ${short(state.head)}.`);
    this.store.checkout(state.head);
    this.save({ state: 'mirroring', pushed: state.head, at: this.now() });
  }

  /** Where listing carries on: the parent of the oldest commit queued, or undefined when it's done. */
  private listFrom(state: Importing): string | undefined {
    if (this.store.commitCount() > 0) return undefined;
    const oldest = this.store.nextImport();
    return oldest ? oldest.parent : state.head;
  }

  /** A commit's files as path → blob ID, fetching any blob not yet stored; undefined if requests run out first. */
  private async filesOf(commit: QueuedCommit, repo: RepoClient, budget: Budget): Promise<Map<string, string> | undefined> {
    const previous = commit.parent ? this.store.commitDetail(commit.parent) : undefined;
    if (previous?.tree === commit.tree) return new Map(previous.files);
    if (budget.left < 2) throw new OutOfRequests();
    const tree = await repo.tree(commit.tree);
    if (tree.truncated) throw new MirrorStop(`Commit ${short(commit.oid)} has too many files for GitHub to list at once.`);
    const files = new Map<string, string>();
    for (const entry of tree.entries) {
      if (entry.type === 'tree') continue;
      if (entry.type !== 'blob' || entry.mode !== '100644') {
        throw new MirrorStop(`${entry.path} in commit ${short(commit.oid)} is ${entry.type === 'commit' ? 'a submodule' : `a file with mode ${entry.mode}`}; Quillipi notebooks hold only plain files.`);
      }
      files.set(safePath(entry.path, commit), entry.sha);
    }
    const missing = [...new Set(files.values())].filter((id) => !this.store.hasBlob(id));
    while (missing.length) {
      if (budget.left === 0) return undefined;
      const batch = missing.splice(0, Math.min(PARALLEL, budget.left));
      const fetched = await Promise.all(batch.map(async (id) => [id, await repo.blob(id)] as const));
      for (const [id, bytes] of fetched) {
        if ((await blobId(bytes)) !== id) throw new MirrorStop(`GitHub sent content for blob ${short(id)} that has a different ID.`);
        this.store.putBlob(id, bytes);
      }
    }
    return files;
  }

  /**
   * Recreates the cloud's new commits on GitHub, oldest first: a tree on top of the parent's tree,
   * then the commit, each checked against the cloud's own ID, then one fast-forward of main.
   */
  private async pushStep(state: Mirroring, repo: RepoClient, budget: Budget): Promise<void> {
    let pending = this.store.commitsSince(state.pushed);
    if (!pending.length) return;
    const main = await repo.main();
    if (main !== state.pushed) {
      // main may already be at one of these commits, if a step moved it and then stopped before saving.
      const at = main && main !== 'empty' ? pending.indexOf(main) : -1;
      if (at < 0) {
        const where = main === undefined ? 'main is gone' : main === 'empty' ? 'the repo is empty' : `main moved to ${short(main)}`;
        throw new MirrorStop(`On GitHub, ${where} without the cloud (did the laptop push?). The cloud's commits after ${short(state.pushed)} wait until merging arrives in Phase 4.`);
      }
      this.save({ state: 'mirroring', pushed: pending[at]! });
      pending = pending.slice(at + 1);
    }
    let verified: string | undefined;
    let failure: unknown;
    try {
      for (const oid of pending) {
        const commit = this.store.commitDetail(oid)!;
        const plan = this.treePlan(commit);
        // The tree, the commit and moving main come after any blobs.
        if (budget.left < plan.uploads.length + 3) break;
        await this.recreate(commit, plan, repo);
        verified = oid;
      }
    } catch (error) {
      failure = error;
    }
    if (verified) {
      if (!(await repo.moveMain(verified))) throw new MirrorStop(`GitHub's main moved while the cloud was pushing (did the laptop push?). Merging arrives in Phase 4.`);
      this.save({ state: 'mirroring', pushed: verified, at: this.now() });
    }
    if (failure) throw failure;
  }

  /** What a commit changed since its parent, as tree entries, and the blobs GitHub must be sent first. */
  private treePlan(commit: CommitDetail): { entries: NewTreeEntry[]; uploads: string[]; base?: string } {
    // A first commit has no parent: every file is new, and the tree is built from nothing.
    const parent = commit.parent ? this.store.commitDetail(commit.parent)! : { files: new Map<string, string>(), tree: undefined };
    const known = new Set(parent.files.values());
    const entries: NewTreeEntry[] = [];
    const uploads: string[] = [];
    for (const [path, id] of commit.files) {
      if (parent.files.get(path) === id) continue;
      // Content GitHub already has is named by its ID; new text goes inline; anything else is sent as a blob first.
      const text = known.has(id) ? undefined : asText(this.store.readBlob(id)!);
      if (text !== undefined) entries.push({ path, mode: '100644', type: 'blob', content: text });
      else entries.push({ path, mode: '100644', type: 'blob', sha: id });
      if (!known.has(id) && text === undefined) uploads.push(id);
    }
    for (const path of parent.files.keys()) if (!commit.files.has(path)) entries.push({ path, mode: '100644', type: 'blob', sha: null });
    return { entries, uploads: [...new Set(uploads)], base: parent.tree };
  }

  private async recreate(commit: CommitDetail, plan: { entries: NewTreeEntry[]; uploads: string[]; base?: string }, repo: RepoClient): Promise<void> {
    for (const id of plan.uploads) {
      const sha = await repo.createBlob(this.store.readBlob(id)!);
      if (sha !== id) throw new MirrorStop(`GitHub stored a file of commit ${short(commit.oid)} as blob ${short(sha)}, not ${short(id)}.`);
    }
    // A commit that changed no file keeps its parent's tree; a first commit always has files.
    const tree = plan.base && !plan.entries.length ? plan.base : await repo.createTree(plan.base, plan.entries);
    if (tree !== commit.tree) throw new MirrorStop(`GitHub made tree ${short(tree)} for commit ${short(commit.oid)}, where the cloud has ${short(commit.tree)}.`);
    const author = { name: commit.author.name, email: commit.author.email, date: gitDate(commit.timestamp, commit.timezone) };
    const sha = await repo.createCommit({ message: commit.message, tree, parents: commit.parent ? [commit.parent] : [], author });
    if (sha !== commit.oid) throw new MirrorStop(`GitHub gave commit ${short(commit.oid)} the ID ${short(sha)}, so the histories would split.`);
  }

  // Inside ------------------------------------------------------------------------

  private describe(state: MirrorState): string {
    let text: string;
    if (state.state === 'creating') {
      text = `${this.repo}: making the repo on GitHub.`;
    } else if (state.state === 'importing') {
      const done = this.store.commitCount();
      const queued = this.store.importQueueSize();
      text = this.listFrom(state) ? `listing commits, ${queued} found so far` : `${done} of ${done + queued} commits imported`;
      text = `${this.repo}: importing, ${text}.`;
    } else if (state.state === 'mirroring') {
      const waiting = this.store.commitsSince(state.pushed).length;
      text = waiting ? `${this.repo}: ${waiting} commit(s) waiting to be pushed.` : `${this.repo}: up to date at ${short(state.pushed)}.`;
    } else {
      text = `${this.repo}: stopped. ${state.reason} Retrying carries on from there once that is sorted out.`;
    }
    if (state.failures) {
      const at = new Date(state.retryAt!).toISOString().slice(11, 16);
      text += ` After ${state.failures} failed tr${state.failures === 1 ? 'y' : 'ies'} it tries again at ${at} UTC. Last error: ${state.lastError}`;
    }
    return text;
  }

  private waiting(state: MirrorState): boolean {
    return state.retryAt !== undefined && state.retryAt > this.now();
  }

  private budget(): Budget {
    return new Budget(this.options.requestsPerStep ?? REQUESTS_PER_STEP);
  }

  private load(): MirrorState | undefined {
    const saved = this.store.getMeta(STATE_KEY);
    return saved ? (JSON.parse(saved) as MirrorState) : undefined;
  }

  private save(state: MirrorState): void {
    this.store.setMeta(STATE_KEY, JSON.stringify(state));
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Walks the first-parent chain from `from` through a page of listed commits, newest first. */
function firstParents(from: string, page: readonly ListedCommit[]): QueuedCommit[] {
  const bySha = new Map(page.map((commit) => [commit.sha, commit]));
  const chain: QueuedCommit[] = [];
  for (let listed = bySha.get(from); listed; listed = listed.parents[0] && bySha.get(listed.parents[0].sha)) {
    const { author, message, tree } = listed.commit;
    chain.push({
      oid: listed.sha,
      ...(listed.parents[0] ? { parent: listed.parents[0].sha } : {}),
      tree: tree.sha,
      message: commitMessage(message),
      author: { name: author.name, email: author.email },
      timestamp: Math.floor(Date.parse(author.date) / 1000),
    });
  }
  if (!chain.length) throw new MirrorStop(`GitHub's list of commits from ${short(from)} didn't include it.`);
  return chain;
}

function safePath(path: string, commit: QueuedCommit): string {
  try {
    return checkPath(path);
  } catch {
    throw new MirrorStop(`Commit ${short(commit.oid)} has a file at "${path}", which isn't a path Quillipi can keep.`);
  }
}

/** A date as GitHub takes it, in the commit's own time zone, so GitHub hashes the same time Git did. */
export function gitDate(timestamp: number, timezone: number): string {
  const ahead = -timezone;
  const local = new Date((timestamp + ahead * 60) * 1000).toISOString().slice(0, 19);
  if (ahead === 0) return `${local}Z`;
  const minutes = Math.abs(ahead);
  return `${local}${ahead < 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The text of a file, if it is UTF-8 that GitHub will store byte for byte; otherwise undefined. */
function asText(bytes: Uint8Array): string | undefined {
  // A byte-order mark or a NUL byte could be changed or refused on the way, so those go as blobs.
  if ((bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) || bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The newest commit GitHub has confirmed, and when. */
function confirmed(state: Mirroring): Pick<BackupState, 'pushed' | 'at'> {
  return { pushed: state.pushed, ...(state.at ? { at: state.at } : {}) };
}

/** The state without its record of failures. */
function clean<T extends MirrorState>(state: T): T {
  const { failures: _failures, retryAt: _retryAt, lastError: _lastError, ...rest } = state;
  return rest as T;
}

function short(oid: string | undefined): string {
  return oid ? oid.slice(0, 7) : 'nothing';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
