/**
 * A stand-in for GitHub, for testing the mirror in Node: the App's sign-in (it checks the JWT's
 * signature), installation tokens limited to one repo, and the Git Data API on in-memory Git
 * objects. It hashes blobs and commits in its own code, keeping messages byte for byte as GitHub
 * does, so a mistake in how the cloud sends a message or a date shows up as a different ID.
 * `laptopCommit` makes commits the way the laptop's Git would, for setting up a repo. It also
 * plays GitHub's side of signing in with the App (`authorize`, the code exchange and /user), with
 * PKCE checked as GitHub checks it, and of the first-time setup: accounts looked up by name, an
 * App made from a manifest (`createApp` and the conversion), and its install (`install`).
 */
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { treeId } from '@inklog/engine';

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, // as GitHub hands it out
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const INSTALLATION = 77;

interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; timestamp: number; tz: string };
  committer: { name: string; email: string; timestamp: number; tz: string };
}

export class FakeRepo {
  blobs = new Map<string, Uint8Array>();
  /** Trees as their files: path → blob ID. */
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, FakeCommit>();
  main?: string;
  private = true;
  description = '';
  /** Requests for main that answer 409 while GitHub is still making the repo. */
  makingFor = 0;

  constructor(public installed: boolean) {}

  addBlob(bytes: Uint8Array): string {
    const sha = gitHash('blob', bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }

  async addTree(files: Map<string, string>): Promise<string> {
    const sha = await treeId(files);
    this.trees.set(sha, new Map(files));
    return sha;
  }

  filesAt(commit: string): Map<string, string> {
    return new Map(this.trees.get(this.commits.get(commit)!.tree)!);
  }

  /** The first-parent chain from main, newest first. */
  history(): string[] {
    const chain: string[] = [];
    for (let sha = this.main; sha; sha = this.commits.get(sha)!.parents[0]) chain.push(sha);
    return chain;
  }

  isAncestor(older: string, newer: string): boolean {
    const seen = new Set<string>();
    const todo = [newer];
    while (todo.length) {
      const sha = todo.pop()!;
      if (sha === older) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      todo.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }
}

type Handler = (request: Request) => Promise<Response>;

/** An App as GitHub knows it after the manifest flow. */
export interface MadeApp {
  id: number;
  slug: string;
  name: string;
  owner: string;
  permissions: Record<string, string>;
  setupUrl: string;
}

export class FakeGitHub {
  appId = '1234567';
  /** The account the notebook repos are in: an organization for notebooks since step 3.3. */
  readonly owner: string;
  /** Whether the App is installed on the whole organization, which lets it make repos there. */
  orgInstalled = true;
  /** Requests for a new repo's main that answer 409, as GitHub does while it is still making the repo. */
  makingFor = 0;
  readonly privateKey = PRIVATE_KEY;
  repos = new Map<string, FakeRepo>();
  /** Every request, as "METHOD /path". */
  requests: string[] = [];
  now = () => Date.now();
  private tokens = new Map<string, { repo: string; expires: number }>();
  private layers: ((request: Request, next: Handler) => Promise<Response>)[] = [];

  /** The App as an OAuth client, for sign-in. */
  clientId = 'Iv23liTESTCLIENT';
  clientSecret = 'test-client-secret';
  callbacks = ['https://quillipi.example.workers.dev/callback'];
  /** Who the browser is signed in to GitHub as. */
  signedIn: { id: number; login: string; name?: string } = { id: 583231, login: 'OctoCat' };
  /** Accounts that `GET /users/<name>` finds, by their lowercase name. */
  accounts = new Map<string, { login: string; id: number; type: 'User' | 'Organization' }>();
  /** The App made from a manifest, once there is one. */
  app?: MadeApp;
  /** Which repositories the App's installation on the organization reaches. */
  selection: 'all' | 'selected' = 'all';
  /** Permissions GitHub drops from a manifest, to test an App made without one Quillipi needs. */
  dropPermissions: string[] = [];
  private manifestCodes = new Map<string, { expires: number }>();
  private codes = new Map<string, { challenge: string; redirectUri: string; user: { id: number; login: string }; expires: number }>();
  private userTokens = new Map<string, { id: number; login: string }>();

  constructor({ owner = 'OctoCat' }: { owner?: string } = {}) {
    this.owner = owner;
    this.addAccount(owner, 92_000_001, 'Organization');
    this.addAccount('OctoCat', 583231, 'User');
  }

  addAccount(login: string, id: number, type: 'User' | 'Organization'): void {
    this.accounts.set(login.toLowerCase(), { login, id, type });
  }

  /**
   * The browser at GitHub's New GitHub App page, posted from Quillipi's setup with a manifest, and
   * the person pressing Create GitHub App: the App is made in the organization, and GitHub sends
   * the browser to the manifest's redirect_url with a one-time code and the state.
   */
  createApp(action: URL, form: URLSearchParams): URL {
    const match = /^\/organizations\/([^/]+)\/settings\/apps\/new$/.exec(action.pathname);
    if (action.origin !== 'https://github.com' || !match) throw new Error(`Not GitHub's New GitHub App page: ${action.href}`);
    const org = this.accounts.get(decodeURIComponent(match[1]!).toLowerCase());
    if (org?.type !== 'Organization' || org.login.toLowerCase() !== this.owner.toLowerCase()) throw new Error('GitHub: Page not found (not an owner of that organization)');
    const manifest = JSON.parse(form.get('manifest') ?? 'null') as { name: string; url: string; redirect_url: string; callback_urls: string[]; setup_url: string; default_permissions: Record<string, string>; public: boolean };
    if (!manifest?.url || manifest.name.length > 34) throw new Error('GitHub: the manifest is not valid');
    const permissions = Object.fromEntries(Object.entries(manifest.default_permissions).filter(([name]) => !this.dropPermissions.includes(name)));
    this.appId = String(3_000_000 + this.requests.length);
    this.clientId = `Iv23li${randomBytes(5).toString('hex')}`;
    this.clientSecret = randomBytes(20).toString('hex');
    this.callbacks = manifest.callback_urls;
    this.orgInstalled = false;
    this.app = { id: Number(this.appId), slug: manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: manifest.name, owner: org.login, permissions, setupUrl: manifest.setup_url };
    const code = randomBytes(10).toString('hex');
    this.manifestCodes.set(code, { expires: this.now() + 3_600_000 });
    const back = new URL(manifest.redirect_url);
    back.searchParams.set('code', code);
    const state = action.searchParams.get('state');
    if (state) back.searchParams.set('state', state);
    return back;
  }

  /** The browser at the App's install page, and the person installing it on the organization; GitHub then sends it to the setup URL. */
  install(url: URL): URL {
    if (!this.app || url.origin !== 'https://github.com' || url.pathname !== `/apps/${this.app.slug}/installations/new`) throw new Error(`Not the App's install page: ${url.href}`);
    this.orgInstalled = true;
    const back = new URL(this.app.setupUrl);
    back.searchParams.set('installation_id', String(INSTALLATION));
    back.searchParams.set('setup_action', 'install');
    const state = url.searchParams.get('state');
    if (state) back.searchParams.set('state', state);
    return back;
  }

  createRepo(name: string, { installed = true } = {}): FakeRepo {
    const repo = new FakeRepo(installed);
    this.repos.set(name, repo);
    return repo;
  }

  /** Puts a layer in front of the routes, to fail, delay or change requests in a test. */
  use(layer: (request: Request, next: Handler) => Promise<Response>): void {
    this.layers.push(layer);
  }

  readonly fetch: Handler = (request) => {
    this.requests.push(`${request.method} ${new URL(request.url).pathname}`);
    const run = (index: number): Handler => (req) => (index < this.layers.length ? this.layers[index]!(req, run(index + 1)) : this.route(req));
    return run(0)(request);
  };

  /** GitHub's code exchange: refusals come back as 200 with an error, as GitHub sends them. */
  private async exchangeCode(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) {
      return reply(200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
    }
    const issued = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? ''); // codes work once
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (!issued || issued.expires < this.now() || issued.redirectUri !== form.get('redirect_uri') || issued.challenge !== challenge) {
      return reply(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
    }
    const token = `ghu_${randomBytes(12).toString('hex')}`;
    this.userTokens.set(token, issued.user);
    return reply(200, { access_token: token, token_type: 'bearer', scope: '' });
  }

  /** A commit made on the laptop and pushed: author and committer the same, message ending in a newline. */
  async laptopCommit(
    name: string,
    changes: Record<string, string | Uint8Array | null>,
    message: string,
    { at = 1_793_900_000, tz = '+0530', parents }: { at?: number; tz?: string; parents?: string[] } = {},
  ): Promise<string> {
    const repo = this.repos.get(name)!;
    const files = repo.main ? repo.filesAt(repo.main) : new Map<string, string>();
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, repo.addBlob(typeof content === 'string' ? new TextEncoder().encode(content) : content));
    }
    const who = { name: 'The Octocat', email: 'octocat@laptop.example', timestamp: at, tz };
    const sha = this.addCommit(repo, { tree: await repo.addTree(files), parents: parents ?? (repo.main ? [repo.main] : []), message: `${message}\n`, author: who, committer: who });
    repo.main = sha;
    return sha;
  }

  /**
   * The browser at github.com/login/oauth/authorize. The person is signed in and has authorized
   * the App before, so GitHub sends them straight back to the callback with a code.
   */
  authorize(url: URL): URL {
    const params = url.searchParams;
    if (url.origin + url.pathname !== 'https://github.com/login/oauth/authorize') throw new Error(`Not GitHub's sign-in page: ${url.href}`);
    if (params.get('client_id') !== this.clientId) throw new Error('GitHub: unknown client_id');
    const redirectUri = params.get('redirect_uri')!;
    if (!this.callbacks.includes(redirectUri)) throw new Error('GitHub: redirect_uri_mismatch');
    if (params.get('code_challenge_method') !== 'S256' || params.get('code_challenge')?.length !== 43) throw new Error('GitHub: expected an S256 code challenge');
    const code = randomBytes(10).toString('hex');
    this.codes.set(code, { challenge: params.get('code_challenge')!, redirectUri, user: this.signedIn, expires: this.now() + 600_000 });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', params.get('state')!);
    return back;
  }

  // Routes ------------------------------------------------------------------------

  private async route(request: Request): Promise<Response> {
    if (!request.headers.get('user-agent')) return reply(403, { message: 'Please make sure your request has a User-Agent header.' });
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    let match: RegExpExecArray | null;

    if (path === '/login/oauth/access_token' && method === 'POST') return this.exchangeCode(request);
    if ((match = /^\/users\/([^/]+)$/.exec(path)) && method === 'GET') {
      const account = this.accounts.get(decodeURIComponent(match[1]!).toLowerCase());
      return account ? reply(200, account) : reply(404, { message: 'Not Found' });
    }
    if ((match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path)) && method === 'POST') {
      const issued = this.manifestCodes.get(match[1]!);
      this.manifestCodes.delete(match[1]!); // codes work once
      if (!issued || issued.expires < this.now() || !this.app) return reply(404, { message: 'Not Found' });
      const owner = this.accounts.get(this.app.owner.toLowerCase())!;
      return reply(201, {
        id: this.app.id,
        slug: this.app.slug,
        name: this.app.name,
        owner: { login: owner.login, id: owner.id, type: owner.type },
        client_id: this.clientId,
        client_secret: this.clientSecret,
        webhook_secret: null,
        pem: this.privateKey,
        permissions: this.app.permissions,
      });
    }
    if (path === '/app' && method === 'GET') {
      if (!this.appSignedIn(request)) return reply(401, { message: 'A JSON web token could not be decoded' });
      return reply(200, { id: Number(this.appId), slug: this.app?.slug, permissions: this.app?.permissions ?? {} });
    }
    if (path === '/user' && method === 'GET') {
      const user = this.userTokens.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      return user ? reply(200, { ...user, type: 'User' }) : reply(401, { message: 'Bad credentials' });
    }
    if ((match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path)) && method === 'GET') {
      if (!this.appSignedIn(request)) return reply(401, { message: 'A JSON web token could not be decoded' });
      const repo = match[1] === this.owner ? this.repos.get(match[2]!) : undefined;
      return repo?.installed ? reply(200, { id: INSTALLATION, app_id: Number(this.appId) }) : reply(404, { message: 'Not Found' });
    }
    if ((match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
      if (!this.appSignedIn(request)) return reply(401, { message: 'A JSON web token could not be decoded' });
      if (Number(match[1]) !== INSTALLATION) return reply(404, { message: 'Not Found' });
      const body = (await request.json()) as { repositories?: string[]; permissions?: Record<string, string> };
      if (body.repositories === undefined) {
        // A token for the whole installation on the organization, as Quillipi asks for to make repos.
        if (!this.orgInstalled) return reply(404, { message: 'Not Found' });
        const token = `ghs_${randomBytes(12).toString('hex')}`;
        const expires = this.now() + 3_600_000;
        this.tokens.set(token, { repo: '*', expires });
        return reply(201, { token, expires_at: new Date(expires).toISOString(), repository_selection: 'all' });
      }
      const [repo] = body.repositories;
      if (body.repositories?.length !== 1 || !this.repos.get(repo!)?.installed) return reply(422, { message: 'There is at least one repository that does not exist or is not accessible' });
      const token = `ghs_${randomBytes(12).toString('hex')}`;
      const expires = this.now() + 3_600_000;
      this.tokens.set(token, { repo: repo!, expires });
      return reply(201, { token, expires_at: new Date(expires).toISOString(), permissions: body.permissions });
    }

    if (path === `/orgs/${this.owner}/installation` && method === 'GET') {
      if (!this.appSignedIn(request)) return reply(401, { message: 'A JSON web token could not be decoded' });
      return this.orgInstalled ? reply(200, { id: INSTALLATION, app_id: Number(this.appId), repository_selection: this.selection }) : reply(404, { message: 'Not Found' });
    }
    if ((match = /^\/orgs\/([^/]+)\/repos$/.exec(path)) && method === 'POST') {
      const granted = this.tokens.get((request.headers.get('authorization') ?? '').replace(/^token /, ''));
      if (!granted || granted.repo !== '*' || granted.expires < this.now()) return reply(401, { message: 'Bad credentials' });
      if (match[1] !== this.owner) return reply(404, { message: 'Not Found' });
      const body = (await request.json()) as { name: string; private?: boolean; auto_init?: boolean; description?: string };
      if (this.repos.has(body.name)) return reply(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      const repo = this.createRepo(body.name, { installed: this.orgInstalled });
      repo.private = body.private === true;
      repo.description = body.description ?? '';
      repo.makingFor = this.makingFor;
      if (body.auto_init) {
        const readme = repo.addBlob(new TextEncoder().encode(`# ${body.name}\n`));
        const who = { name: 'GitHub', email: 'noreply@github.com', timestamp: Math.floor(this.now() / 1000), tz: '+0000' };
        repo.main = this.addCommit(repo, { tree: await repo.addTree(new Map([['README.md', readme]])), parents: [], message: 'Initial commit', author: who, committer: who });
      }
      return reply(201, { name: body.name, full_name: `${this.owner}/${body.name}`, private: repo.private });
    }

    match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    const repo = match && match[1] === this.owner ? this.repos.get(match[2]!) : undefined;
    if (!match || !repo) return reply(404, { message: 'Not Found' });
    const granted = this.tokens.get((request.headers.get('authorization') ?? '').replace(/^token /, ''));
    if (!granted || granted.repo !== match[2] || granted.expires < this.now()) return reply(401, { message: 'Bad credentials' });
    const rest = match[3]!;

    if (rest === '/git/ref/heads/main' && method === 'GET' && repo.makingFor > 0) {
      repo.makingFor--;
      return reply(409, { message: 'Git Repository is empty.' });
    }
    if (rest === '/git/ref/heads/main' && method === 'GET') {
      if (!repo.commits.size) return reply(409, { message: 'Git Repository is empty.' });
      return repo.main ? reply(200, { ref: 'refs/heads/main', object: { sha: repo.main, type: 'commit' } }) : reply(404, { message: 'Not Found' });
    }
    if (rest === '/git/refs/heads/main' && method === 'PATCH') {
      const { sha, force } = (await request.json()) as { sha: string; force?: boolean };
      if (!repo.commits.has(sha)) return reply(422, { message: 'Object does not exist' });
      if (!force && repo.main && !repo.isAncestor(repo.main, sha)) return reply(422, { message: 'Update is not a fast forward' });
      repo.main = sha;
      return reply(200, { ref: 'refs/heads/main', object: { sha, type: 'commit' } });
    }
    if ((match = /^\/contents\/(.+)$/.exec(rest)) && method === 'GET') {
      const commit = repo.commits.get(url.searchParams.get('ref') ?? repo.main ?? '');
      return commit && repo.trees.get(commit.tree)!.has(match[1]!) ? reply(200, { type: 'file', path: match[1] }) : reply(404, { message: 'Not Found' });
    }
    if (rest === '/commits' && method === 'GET') {
      return reply(200, this.listCommits(repo, url.searchParams.get('sha')!, Number(url.searchParams.get('per_page') ?? 30)));
    }
    if ((match = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const files = repo.trees.get(match[1]!);
      return files ? reply(200, { sha: match[1], tree: await treeListing(files), truncated: false }) : reply(404, { message: 'Not Found' });
    }
    if ((match = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const bytes = repo.blobs.get(match[1]!);
      if (!bytes) return reply(404, { message: 'Not Found' });
      // GitHub breaks its base64 into lines.
      const content = Buffer.from(bytes).toString('base64').replace(/.{60}/g, '$&\n');
      return reply(200, { sha: match[1], size: bytes.length, content, encoding: 'base64' });
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const { content, encoding } = (await request.json()) as { content: string; encoding: string };
      return reply(201, { sha: repo.addBlob(Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8')) });
    }
    if (rest === '/git/trees' && method === 'POST') {
      const body = (await request.json()) as { base_tree?: string; tree: { path: string; mode: string; type: string; sha?: string | null; content?: string }[] };
      const files = new Map(body.base_tree ? repo.trees.get(body.base_tree) : []);
      if (body.base_tree && !repo.trees.has(body.base_tree)) return reply(422, { message: 'base_tree is not a valid tree' });
      for (const entry of body.tree) {
        if (entry.mode !== '100644' || entry.type !== 'blob') return reply(422, { message: `Unexpected entry ${entry.path}` });
        if (entry.content !== undefined && entry.sha !== undefined) return reply(422, { message: 'Only one of content and sha may be given' });
        if (entry.content !== undefined) files.set(entry.path, repo.addBlob(new TextEncoder().encode(entry.content)));
        else if (entry.sha === null) files.delete(entry.path);
        else if (entry.sha && repo.blobs.has(entry.sha)) files.set(entry.path, entry.sha);
        else return reply(422, { message: `tree.sha ${entry.sha} is not a valid blob` });
      }
      return reply(201, { sha: await repo.addTree(files) });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const body = (await request.json()) as { message: string; tree: string; parents: string[]; author: Person; committer: Person };
      if (!repo.trees.has(body.tree) || body.parents.some((parent) => !repo.commits.has(parent))) return reply(422, { message: 'Tree or parent does not exist' });
      const sha = this.addCommit(repo, { tree: body.tree, parents: body.parents, message: body.message, author: parsePerson(body.author), committer: parsePerson(body.committer) });
      return reply(201, { sha, verification: { verified: false } });
    }
    return reply(404, { message: 'Not Found' });
  }

  /** Checks the App's JWT: RS256, signed by the App's key, for this App, valid now and for at most ten minutes. */
  private appSignedIn(request: Request): boolean {
    const [header, payload, signature] = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '').split('.');
    if (!header || !payload || !signature) return false;
    if (!verify('sha256', Buffer.from(`${header}.${payload}`), PUBLIC_KEY, Buffer.from(signature, 'base64url'))) return false;
    const { alg } = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg: string };
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: unknown };
    const now = Math.floor(this.now() / 1000);
    return alg === 'RS256' && claims.iss === Number(this.appId) && claims.iat <= now && claims.exp > now && claims.exp <= now + 600;
  }

  private addCommit(repo: FakeRepo, commit: Omit<FakeCommit, 'sha'>): string {
    const line = (who: FakeCommit['author']) => `${who.name} <${who.email}> ${who.timestamp} ${who.tz}`;
    const text = [`tree ${commit.tree}`, ...commit.parents.map((parent) => `parent ${parent}`), `author ${line(commit.author)}`, `committer ${line(commit.committer)}`, '', commit.message].join('\n');
    const sha = gitHash('commit', new TextEncoder().encode(text));
    repo.commits.set(sha, { ...commit, sha });
    return sha;
  }

  /** A commit and its ancestors, newest first, as GitHub lists them. */
  private listCommits(repo: FakeRepo, from: string, perPage: number): unknown[] {
    const found: FakeCommit[] = [];
    const seen = new Set<string>();
    const todo = [from];
    while (todo.length) {
      const sha = todo.shift()!;
      if (seen.has(sha) || !repo.commits.has(sha)) continue;
      seen.add(sha);
      found.push(repo.commits.get(sha)!);
      todo.push(...repo.commits.get(sha)!.parents);
    }
    found.sort((a, b) => b.committer.timestamp - a.committer.timestamp);
    return found.slice(0, Math.min(perPage, 100)).map((commit) => ({
      sha: commit.sha,
      parents: commit.parents.map((sha) => ({ sha })),
      commit: {
        message: commit.message.replace(/\n$/, ''),
        tree: { sha: commit.tree },
        author: { name: commit.author.name, email: commit.author.email, date: new Date(commit.author.timestamp * 1000).toISOString().replace('.000', '') },
      },
    }));
  }
}

interface Person {
  name: string;
  email: string;
  date: string;
}

/** A person and date as GitHub reads them, keeping the time zone the date was written in. */
function parsePerson(person: Person): FakeCommit['author'] {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(Z|([+-])(\d\d):(\d\d))$/.exec(person.date);
  if (!match) throw new Error(`Bad date ${person.date}`);
  const [, y, mo, d, h, mi, s, , sign, zh, zm] = match;
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000;
  const ahead = sign ? (sign === '-' ? -1 : 1) * (Number(zh) * 3600 + Number(zm) * 60) : 0;
  return { name: person.name, email: person.email, timestamp: local - ahead, tz: sign ? `${sign}${zh}${zm}` : '+0000' };
}

async function treeListing(files: Map<string, string>) {
  const entries: { path: string; mode: string; type: string; sha: string }[] = [];
  const folders = new Set<string>();
  for (const [path, sha] of files) {
    entries.push({ path, mode: '100644', type: 'blob', sha });
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  for (const folder of folders) {
    const inside = new Map([...files].filter(([path]) => path.startsWith(`${folder}/`)).map(([path, sha]) => [path.slice(folder.length + 1), sha]));
    entries.push({ path: folder, mode: '040000', type: 'tree', sha: await treeId(inside) });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function gitHash(type: string, body: Uint8Array): string {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

function reply(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}
