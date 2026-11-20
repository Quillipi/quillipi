/**
 * Quillipi's access to GitHub, as the GitHub App installed on the organization for notebooks.
 *
 * The App proves who it is with a short JWT signed by its private key, and trades that for an
 * installation token, which lasts an hour and reaches only the one repo it was asked for. Every
 * request counts against a Budget, because a Worker on the free plan may make only 50 outgoing
 * requests per invocation; the mirror stops a step before the budget runs out and resumes later.
 */
const API = 'https://api.github.com';
const BRANCH = 'main';
/** A token is renewed when it has less than this left. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** A GitHub request that failed in a way that may pass if tried again later. */
export class GitHubError extends Error {}

/** The step's requests are used up; the work continues in the next step. */
export class OutOfRequests extends Error {
  constructor() {
    super('This step has used all its GitHub requests.');
  }
}

/** How many GitHub requests one invocation may still make. */
export class Budget {
  private used = 0;

  constructor(readonly limit: number) {}

  get left(): number {
    return this.limit - this.used;
  }

  spend(): void {
    if (this.used >= this.limit) throw new OutOfRequests();
    this.used++;
  }
}

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  /** The organization the notebook repos belong to; a notebook's repo has its ID as its name. */
  owner: string;
  /** Another address for GitHub's API, for a stand-in in tests. */
  api?: string;
  fetch?: (request: Request) => Promise<Response>;
  now?: () => number;
}

export class GitHubApp {
  readonly owner: string;
  private readonly api: string;
  private readonly send: (request: Request) => Promise<Response>;
  private readonly now: () => number;
  private key?: Promise<CryptoKey>;
  private installations = new Map<string, number>();
  private tokens = new Map<string, { token: string; expires: number }>();
  /** The token for making repos, which reaches the whole organization; kept apart from the per-repo ones. */
  private orgToken?: { token: string; expires: number };

  constructor(private readonly options: GitHubAppOptions) {
    this.owner = options.owner;
    this.api = (options.api ?? API).replace(/\/$/, '');
    this.send = options.fetch ?? ((request) => fetch(request));
    this.now = options.now ?? Date.now;
  }

  /** The App's installation on a repo, or undefined if the repo doesn't exist or the App isn't on it. */
  async installation(repo: string, budget: Budget): Promise<number | undefined> {
    const known = this.installations.get(repo);
    if (known) return known;
    const { status, body } = await this.call(budget, 'GET', `/repos/${this.owner}/${repo}/installation`, { jwt: true, accept: [404] });
    if (status === 404) return undefined;
    const id = Number((body as { id: number }).id);
    this.installations.set(repo, id);
    return id;
  }

  /**
   * Makes a private repo for a notebook in the organization, with GitHub's starter commit (an
   * empty README), because the Git Data API refuses a repo that has no commits. 'exists' when a
   * repo of that name is already there; whose it is, the caller checks.
   */
  async createRepo(name: string, description: string, budget: Budget): Promise<'made' | 'exists'> {
    const token = await this.organizationToken(budget);
    const body = { name, description, private: true, auto_init: true, has_issues: false, has_projects: false, has_wiki: false };
    const { status, body: reply } = await this.call(budget, 'POST', `/orgs/${this.owner}/repos`, { token, body, accept: [401, 422] });
    if (status === 401) {
      this.orgToken = undefined;
      throw new GitHubError(`GitHub refused the App's token for the organization ${this.owner}.`);
    }
    if (status === 422) {
      const said = JSON.stringify(reply ?? '');
      if (/already exists/i.test(said)) return 'exists';
      throw new GitHubError(`GitHub would not make ${this.owner}/${name}: ${(reply as { message?: string } | undefined)?.message ?? 'no reason given'}`);
    }
    return 'made';
  }

  /**
   * The App's installation on the organization, asked of GitHub with the App's own key, or
   * undefined if it isn't installed there. `allRepositories` is whether it reaches every repo in
   * it, which the repos Quillipi makes later need.
   */
  async organizationInstallation(budget: Budget): Promise<{ id: number; allRepositories: boolean } | undefined> {
    const found = await this.call(budget, 'GET', `/orgs/${this.owner}/installation`, { jwt: true, accept: [404] });
    if (found.status === 404) return undefined;
    const { id, repository_selection } = found.body as { id: number; repository_selection?: string };
    return { id: Number(id), allRepositories: repository_selection === 'all' };
  }

  /** The permissions the App has, by GitHub's names, such as `{ contents: 'write' }`. */
  async permissions(budget: Budget): Promise<Record<string, string>> {
    const { body } = await this.call(budget, 'GET', '/app', { jwt: true });
    return (body as { permissions?: Record<string, string> }).permissions ?? {};
  }

  /**
   * A token for the App's installation on the whole organization, used only to make repos. It asks
   * for no narrower permissions: GitHub's newer 'Repository creation' permission and the older
   * 'Administration' both allow making repos, and the App has only what its owner gave it.
   */
  private async organizationToken(budget: Budget): Promise<string> {
    if (this.orgToken && this.orgToken.expires - this.now() > TOKEN_MARGIN_MS) return this.orgToken.token;
    const found = await this.organizationInstallation(budget);
    if (!found) throw new GitHubError(`The GitHub App isn't installed on the organization ${this.owner}.`);
    const installation = found.id;
    const { body } = await this.call(budget, 'POST', `/app/installations/${installation}/access_tokens`, { jwt: true, body: {} });
    const { token, expires_at } = body as { token: string; expires_at: string };
    this.orgToken = { token, expires: Date.parse(expires_at) };
    return token;
  }

  /** The Git Data API on one notebook repo. */
  repo(repo: string, budget: Budget): RepoClient {
    return new RepoClient(this, repo, budget);
  }

  /** A request to GitHub, signed in as the App's installation on `repo`. */
  async repoCall(budget: Budget, repo: string, method: string, path: string, body?: unknown, accept: number[] = []): Promise<Reply> {
    const token = await this.token(repo, budget);
    const reply = await this.call(budget, method, `/repos/${this.owner}/${repo}${path}`, { token, body, accept: [401, ...accept] });
    if (reply.status === 401) {
      this.tokens.delete(repo); // revoked or expired early; the next try gets a new one
      throw new GitHubError(`GitHub refused the App's token for ${this.owner}/${repo}.`);
    }
    return reply;
  }

  /** An installation token for one repo, limited to its contents, reused until it nearly expires. */
  private async token(repo: string, budget: Budget): Promise<string> {
    const cached = this.tokens.get(repo);
    if (cached && cached.expires - this.now() > TOKEN_MARGIN_MS) return cached.token;
    const installation = await this.installation(repo, budget);
    if (!installation) throw new GitHubError(`The GitHub App isn't installed on ${this.owner}/${repo}.`);
    const { status, body } = await this.call(budget, 'POST', `/app/installations/${installation}/access_tokens`, {
      jwt: true,
      body: { repositories: [repo], permissions: { contents: 'write' } },
      accept: [404],
    });
    if (status === 404) {
      this.installations.delete(repo);
      throw new GitHubError(`The GitHub App's installation on ${this.owner}/${repo} is gone.`);
    }
    const { token, expires_at } = body as { token: string; expires_at: string };
    this.tokens.set(repo, { token, expires: Date.parse(expires_at) });
    return token;
  }

  private async call(budget: Budget, method: string, path: string, options: { jwt?: boolean; token?: string; body?: unknown; accept?: number[] }): Promise<Reply> {
    budget.spend();
    const auth = options.jwt ? `Bearer ${await this.jwt()}` : `token ${options.token}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: auth,
      'user-agent': 'Quillipi',
      'x-github-api-version': '2022-11-28',
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.send(new Request(`${this.api}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }));
    } catch (error) {
      throw new GitHubError(`GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    const body: unknown = text ? safeJson(text) : undefined;
    if (response.ok || options.accept?.includes(response.status)) return { status: response.status, body };
    const said = (body as { message?: string } | undefined)?.message;
    throw new GitHubError(`GitHub answered ${response.status} to ${method} ${path}${said ? `: ${said}` : ''}`);
  }

  /** The App's JWT: valid for nine minutes, dated a minute back in case the clocks differ. */
  private async jwt(): Promise<string> {
    this.key ??= importAppKey(this.options.privateKey);
    const now = Math.floor(this.now() / 1000);
    const iss = /^\d+$/.test(this.options.appId) ? Number(this.options.appId) : this.options.appId;
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss }))}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${base64url(new Uint8Array(signature))}`;
  }
}

export interface Reply {
  status: number;
  body: unknown;
}

export interface ListedCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; tree: { sha: string }; author: { name: string; email: string; date: string } };
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

/** An entry for a new tree: a file by its content or by a blob ID, or a deletion (sha null). */
export type NewTreeEntry = { path: string; mode: '100644'; type: 'blob' } & ({ content: string } | { sha: string | null });

export interface NewCommit {
  message: string;
  tree: string;
  parents: string[];
  author: { name: string; email: string; date: string };
}

/** The calls the mirror makes on one repo, through Git's own objects. */
export class RepoClient {
  constructor(
    private readonly app: GitHubApp,
    readonly name: string,
    private readonly budget: Budget,
  ) {}

  get fullName(): string {
    return `${this.app.owner}/${this.name}`;
  }

  /** Where main points, 'empty' for a repo without commits, or undefined if there is no main. */
  async main(): Promise<string | 'empty' | undefined> {
    const { status, body } = await this.call('GET', `/git/ref/heads/${BRANCH}`, undefined, [404, 409]);
    if (status === 409) return 'empty';
    return status === 404 ? undefined : (body as { object: { sha: string } }).object.sha;
  }

  /** Moves main forward to `sha`. False if main has moved on since, so it isn't a fast-forward. */
  async moveMain(sha: string): Promise<boolean> {
    const { status } = await this.call('PATCH', `/git/refs/heads/${BRANCH}`, { sha, force: false }, [422]);
    return status !== 422;
  }

  /** Points main at `sha` even though it doesn't follow from where main is: only over GitHub's starter commit. */
  async replaceMain(sha: string): Promise<void> {
    await this.call('PATCH', `/git/refs/heads/${BRANCH}`, { sha, force: true });
  }

  async hasFile(path: string, ref: string): Promise<boolean> {
    const { status } = await this.call('GET', `/contents/${path}?ref=${ref}`, undefined, [404]);
    return status !== 404;
  }

  /** A commit and up to 99 of its ancestors. */
  async commits(from: string): Promise<ListedCommit[]> {
    return (await this.call('GET', `/commits?sha=${from}&per_page=100`)).body as ListedCommit[];
  }

  /** Every file and folder in a tree, at any depth. */
  async tree(sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const body = (await this.call('GET', `/git/trees/${sha}?recursive=1`)).body as { tree: TreeEntry[]; truncated: boolean };
    return { entries: body.tree, truncated: body.truncated };
  }

  async blob(sha: string): Promise<Uint8Array> {
    const body = (await this.call('GET', `/git/blobs/${sha}`)).body as { content: string; encoding: string };
    if (body.encoding !== 'base64') throw new GitHubError(`GitHub sent blob ${sha} as ${body.encoding}, not base64.`);
    return fromBase64(body.content);
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    return this.sha(await this.call('POST', '/git/blobs', { content: toBase64(bytes), encoding: 'base64' }));
  }

  /** A tree: the changes on top of `base`, or, for a notebook's first commit, every file. */
  async createTree(base: string | undefined, entries: NewTreeEntry[]): Promise<string> {
    return this.sha(await this.call('POST', '/git/trees', base ? { base_tree: base, tree: entries } : { tree: entries }));
  }

  async createCommit(commit: NewCommit): Promise<string> {
    return this.sha(await this.call('POST', '/git/commits', { ...commit, committer: commit.author }));
  }

  private call(method: string, path: string, body?: unknown, accept?: number[]): Promise<Reply> {
    return this.app.repoCall(this.budget, this.name, method, path, body, accept);
  }

  private sha(reply: Reply): string {
    return (reply.body as { sha: string }).sha;
  }
}

/** Whether an App's permissions let it make repos: GitHub's newer 'Repository creation', or the older 'Administration'. */
export function canMakeRepos(permissions: Record<string, string>): boolean {
  return permissions.contents === 'write' && (permissions.repository_creation === 'write' || permissions.administration === 'write');
}

// For the first-time setup, before Quillipi has an App of its own -------------------------

/** How the setup reaches GitHub: another address and fetch in tests. */
export interface GitHubAccess {
  api?: string;
  fetch?: (request: Request) => Promise<Response>;
}

/** A GitHub account by its name, as GitHub spells it, or what kept Quillipi from finding it. */
export type Account = { kind: 'organization' | 'user'; login: string; id: number } | { kind: 'missing' } | { kind: 'unknown'; reason: string };

/**
 * Looks an account up in GitHub's public API, with no key: an organization, a person, or no one.
 * GitHub allows a few such requests an hour from one address, so a refusal is 'unknown', not 'missing'.
 */
export async function findAccount(name: string, access: GitHubAccess = {}): Promise<Account> {
  let response: Response;
  try {
    response = await send(access, new Request(`${apiOf(access)}/users/${encodeURIComponent(name)}`, { headers: HEADERS }));
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 404) return { kind: 'missing' };
  const body = (await response.json().catch(() => undefined)) as { login?: unknown; id?: unknown; type?: unknown; message?: unknown } | undefined;
  if (!response.ok || typeof body?.login !== 'string' || typeof body.id !== 'number') {
    return { kind: 'unknown', reason: `GitHub answered ${response.status}${typeof body?.message === 'string' ? `: ${body.message}` : ''}` };
  }
  return { kind: body.type === 'Organization' ? 'organization' : 'user', login: body.login, id: body.id };
}

/** A GitHub App as GitHub hands it over at the end of the manifest flow, with its keys. */
export interface NewApp {
  id: number;
  slug: string;
  name: string;
  owner: { login: string; id: number };
  clientId: string;
  clientSecret: string;
  privateKey: string;
  permissions: Record<string, string>;
}

/**
 * Trades the one-time code GitHub gives after a person creates an App from Quillipi's manifest for
 * the App itself: its ID, its keys and its owner. GitHub needs no key for this; the code works
 * once, within an hour.
 */
export async function appFromManifest(code: string, access: GitHubAccess = {}): Promise<NewApp> {
  let response: Response;
  try {
    response = await send(access, new Request(`${apiOf(access)}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: HEADERS }));
  } catch (error) {
    throw new GitHubError(`GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const owner = body?.owner as { login?: unknown; id?: unknown } | undefined;
  if (response.status !== 201 || !body || typeof body.id !== 'number' || typeof body.pem !== 'string' || typeof owner?.login !== 'string') {
    throw new GitHubError(`GitHub didn't hand the App over (it answered ${response.status}${typeof body?.message === 'string' ? `: ${body.message}` : ''}).`);
  }
  return {
    id: body.id,
    slug: String(body.slug),
    name: String(body.name),
    owner: { login: owner.login, id: Number(owner.id) },
    clientId: String(body.client_id),
    clientSecret: String(body.client_secret),
    privateKey: body.pem,
    permissions: (body.permissions as Record<string, string> | undefined) ?? {},
  };
}

const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'Quillipi', 'x-github-api-version': '2022-11-28' };

function apiOf(access: GitHubAccess): string {
  return (access.api ?? API).replace(/\/$/, '');
}

function send(access: GitHubAccess, request: Request): Promise<Response> {
  return access.fetch ? access.fetch(request) : fetch(request);
}

/**
 * Reads the App's private key. GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"), but Web
 * Crypto reads only PKCS#8, so a PKCS#1 key is wrapped into PKCS#8 here. The key may arrive with
 * its line breaks written as \n, as it does from a .dev.vars file.
 */
export async function importAppKey(pem: string): Promise<CryptoKey> {
  const text = pem.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!match) throw new Error('GITHUB_APP_PRIVATE_KEY is not a private key: it should start with -----BEGIN RSA PRIVATE KEY-----.');
  let der: Uint8Array;
  try {
    der = fromBase64(match[2]!);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY is damaged: its middle is not base64.');
  }
  const pkcs8 = match[1] ? wrapPkcs1(der) : der;
  try {
    return await crypto.subtle.importKey('pkcs8', pkcs8 as Uint8Array<ArrayBuffer>, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY could not be read as an RSA key.');
  }
}

/** PKCS#8 around a PKCS#1 RSA key: SEQUENCE { 0, { rsaEncryption, NULL }, OCTET STRING key }. */
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryption = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return der(0x30, concat([version, rsaEncryption, der(0x04, pkcs1)]));
}

/** One DER element: its tag, its length, then its content. */
function der(tag: number, content: Uint8Array): Uint8Array {
  const length = content.length;
  const lengthBytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) lengthBytes.unshift(rest & 0xff);
  const head = length < 0x80 ? [tag, length] : [tag, 0x80 | lengthBytes.length, ...lengthBytes];
  return concat([Uint8Array.from(head), content]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In slices, because String.fromCharCode takes only so many arguments at once.
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/\s+/g, '')), (char) => char.charCodeAt(0));
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
