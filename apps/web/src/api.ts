/** Talking to the Quillipi that serves this page, on the laptop or in the cloud. */
import type {
  AgentConnection,
  Block,
  CommitDetails,
  CommitSummary,
  HomeData,
  LibraryMessage,
  Me,
  NotebookCard,
  NotebookOverview,
  RepoInfo,
  SectionData,
  ServerMessage,
} from '@inklog/core';

/** The notebook whose calls go out now; the app sets it when an address in a notebook opens. */
let notebook: string | undefined;

export function setNotebook(id: string | undefined): void {
  notebook = id;
}

/** Where this notebook's calls, files and live connection are. */
const calls = (id = notebook) => `/api/n/${encodeURIComponent(id ?? '')}`;

/** Quillipi answered, with an error. Other failures mean it couldn't be reached. */
export class AnswerError extends Error {}

/** The cloud asked the browser to sign in; the page is already on its way there. */
export class SignInNeeded extends AnswerError {}

/** A new Quillipi isn't set up yet; the page is already on its way to the setup. */
export class SetupNeeded extends AnswerError {}

/** Off to sign in, coming back to this address afterwards. */
export function signIn(): void {
  location.assign(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  // The cloud says where to sign in; the laptop's own refusal says to use the link it printed.
  if (response.status === 401 && body.signIn) {
    signIn();
    throw new SignInNeeded('Signing in…');
  }
  if (response.status === 503 && body.setup) {
    location.assign(body.setup);
    throw new SetupNeeded('Opening the setup…');
  }
  if (!response.ok) throw new AnswerError(body.error ?? `Quillipi answered with an error (${response.status}).`);
  return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export interface AgentView {
  map: string;
  read: string;
  tools: { name: string; description: string; tokens: number }[];
}

/** Which Quillipi this is. The cloud has many notebooks, Home and a signed-in person; the laptop program serves one notebook. */
export type Host = { kind: 'cloud'; me: Me } | { kind: 'laptop'; notebook: { id: string; name: string } };

export async function whichHost(): Promise<Host> {
  const answer = await request<Me | { laptop: { id: string; name: string } }>('/api/me');
  return 'laptop' in answer ? { kind: 'laptop', notebook: answer.laptop } : { kind: 'cloud', me: answer };
}

export const api = {
  // The cloud's library and the app around the notebooks
  home: () => request<HomeData>('/api/home'),
  notebooks: () => request<{ notebooks: { id: string; name: string }[] }>('/api/notebooks'),
  createNotebook: (details: { title: string; about?: string; colour?: string }) => post<NotebookCard>('/api/notebooks', details),
  addNotebook: (github: string) => post<NotebookCard>('/api/notebooks', { github }),
  archive: (id: string, archived: boolean) => post<NotebookCard>(`/api/notebooks/${encodeURIComponent(id)}/archive`, { archived }),
  setDefault: (id: string) => post('/api/default', { id }),
  agents: () => request<{ connections: AgentConnection[] }>('/api/agents'),
  disconnectAgent: (id: string) => post('/api/agents/disconnect', { id }),
  /** The AI instructions for every notebook, which the cloud's library keeps. */
  sharedInstructions: () => request<{ text: string; tokens: number }>('/api/instructions'),
  setSharedInstructions: (text: string) => post('/api/instructions', { text }),

  // The notebook that is open
  repo: () => request<RepoInfo>(`${calls()}/repo`),
  overview: () => request<NotebookOverview>(`${calls()}/overview`),
  visit: () => post<{ before: number | null }>(`${calls()}/visit`, {}),
  setDetails: (details: { name?: string; about?: string; colour?: string }) => post<{ commit: CommitSummary | null }>(`${calls()}/details`, details),
  section: (id: string) => request<SectionData>(`${calls()}/section?id=${encodeURIComponent(id)}`),
  snapshot: (commit: string) => request<{ sections: Record<string, Block[]> }>(`${calls()}/snapshot?commit=${encodeURIComponent(commit)}`),
  agentView: (section = '') => request<AgentView>(`${calls()}/agent-view?section=${encodeURIComponent(section)}`),
  createSection: (title: string, folder?: string) => post<{ id: string }>(`${calls()}/sections`, { title, folder }),
  createFolder: (name: string, folder = '') => post<{ lines: string[] }>(`${calls()}/organize`, { ops: [{ op: 'folder', name, in: folder }] }),
  organize: (ops: object[]) => post<{ lines: string[] }>(`${calls()}/organize`, { ops }),
  renameFolder: (path: string, name: string) => post<{ lines: string[] }>(`${calls()}/organize`, { ops: [{ op: 'rename', id: `${path}/`, name }] }),
  deleteSection: (section: string) => post(`${calls()}/delete`, { section }),
  deleteFolder: (folder: string) => post<{ sections: number }>(`${calls()}/delete`, { folder }),
  commit: (message: string) => post<{ commit: CommitSummary | null }>(`${calls()}/commit`, { message }),
  /** What a commit changed, for its row in the History panel, and the commits that changed one section. */
  commitDetails: (commit: string) => request<CommitDetails>(`${calls()}/commit?commit=${encodeURIComponent(commit)}`),
  sectionHistory: (section: string) => request<{ commits: string[] }>(`${calls()}/history?section=${encodeURIComponent(section)}`),
  undoCommit: (commit: string) => post<{ lines: string[] }>(`${calls()}/undo`, { commit }),
  /** This notebook's AI instructions: its own text, and everything an AI gets (with those for every notebook). */
  instructions: () => request<{ text: string; given: string; tokens: number }>(`${calls()}/instructions`),
  setInstructions: (text: string) => post(`${calls()}/instructions`, { text }),
  include: (section: string, key: string, included: boolean) => post(`${calls()}/include`, { section, key, included }),
  resolveHeld: (index: number, approve: boolean) => post(`${calls()}/held`, { index, approve }),
  uploadImage: (file: File) => request<{ src: string }>(`${calls()}/assets`, { method: 'POST', headers: { 'content-type': file.type }, body: file }),
  // Remote access belongs to the laptop program, which serves one notebook.
  disconnectRemote: (id: string) => post('/api/remote/disconnect', { id }),
  denyRemote: () => post('/api/remote/deny', {}),
};

/** A URL the browser can load for a file in the open notebook. Web addresses pass through. */
export function fileUrl(src: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) ? src : `${calls()}/files/${src.split('/').map(encodeURIComponent).join('/')}`;
}

/** Commit snapshots never change, so each is fetched once per notebook. */
const snapshots = new Map<string, Promise<Record<string, Block[]>>>();
export function snapshot(commit: string): Promise<Record<string, Block[]>> {
  const key = `${notebook} ${commit}`;
  let cached = snapshots.get(key);
  if (!cached) {
    cached = api.snapshot(commit).then((result) => result.sections);
    cached.catch(() => snapshots.delete(key));
    snapshots.set(key, cached);
  }
  return cached;
}

export type Saved = Extract<ServerMessage, { type: 'saved' }>;
export type LiveEvent = ServerMessage | { type: 'connected' };

/** A WebSocket to Quillipi that reconnects by itself, with growing waits, until it is closed. */
abstract class Socket<Message> {
  protected socket?: WebSocket;
  private retryDelay = 500;
  private connectedBefore = false;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly onStatus: (online: boolean) => void = () => {},
  ) {}

  protected start(): void {
    if (this.closed) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.path}`);
    socket.onopen = () => {
      this.retryDelay = 500;
      this.onStatus(true);
      // Quillipi was away and is back, perhaps a new version of it after a deploy (installable.ts).
      if (this.connectedBefore) window.dispatchEvent(new Event('inklog:reconnected'));
      this.opened(this.connectedBefore);
      this.connectedBefore = true;
    };
    socket.onmessage = (event) => this.received(JSON.parse(event.data) as Message);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.onStatus(false);
      this.lost();
      if (this.closed) return;
      setTimeout(() => this.start(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    };
    this.socket = socket;
  }

  /** Stops for good, such as when the page leaves the notebook, or Quillipi refused this page. */
  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  protected abstract received(message: Message): void;
  protected opened(_again: boolean): void {}
  protected lost(): void {}
}

/**
 * The live connection to the open notebook. Saves go out; changes made elsewhere (by agents, other
 * windows, other programs) come in. It reconnects by itself and announces each reconnection, so
 * open sections can catch up on what they missed.
 */
export class Live extends Socket<ServerMessage> {
  private nextRequest = 1;
  private waiting = new Map<number, { resolve: (saved: Saved) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(event: LiveEvent) => void>();

  constructor(id: string, onStatus: (online: boolean) => void) {
    super(`${calls(id)}/ws`, onStatus);
    this.start();
  }

  protected override opened(again: boolean): void {
    if (again) this.emit({ type: 'connected' });
  }

  protected override received(message: ServerMessage): void {
    if (message.type === 'saved' || message.type === 'error') {
      const waiter = this.waiting.get(message.request);
      this.waiting.delete(message.request);
      if (message.type === 'saved') waiter?.resolve(message);
      else waiter?.reject(new Error(message.error));
    } else {
      this.emit(message);
    }
  }

  protected override lost(): void {
    for (const waiter of this.waiting.values()) waiter.reject(new Error('The connection to Quillipi was lost.'));
    this.waiting.clear();
  }

  save(section: string, base: string, blocks: Block[]): Promise<Saved> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to Quillipi.'));
    const request = this.nextRequest++;
    this.socket.send(JSON.stringify({ type: 'save', request, section, base, blocks }));
    return new Promise((resolve, reject) => this.waiting.set(request, { resolve, reject }));
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LiveEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Home's live connection to the cloud's library: every card when it connects, then each change. */
export class LibraryLive extends Socket<LibraryMessage> {
  constructor(private readonly onMessage: (message: LibraryMessage) => void) {
    super('/api/library/ws');
    this.start();
  }

  protected override received(message: LibraryMessage): void {
    this.onMessage(message);
  }
}
