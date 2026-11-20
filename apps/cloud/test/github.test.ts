import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Budget, GitHubApp, GitHubError, OutOfRequests, fromBase64, importAppKey, toBase64 } from '../src/github.js';
import { FakeGitHub } from './fake-github.js';

const { privateKey: PKCS1, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const PKCS8 = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

async function signs(key: CryptoKey, publicPem: string): Promise<boolean> {
  const data = new TextEncoder().encode('hello');
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data));
  return verify('sha256', data, publicPem, signature);
}

function app(fake: FakeGitHub, overrides: Partial<ConstructorParameters<typeof GitHubApp>[0]> = {}): GitHubApp {
  return new GitHubApp({ appId: fake.appId, privateKey: fake.privateKey, owner: fake.owner, fetch: fake.fetch, now: () => fake.now(), ...overrides });
}

describe("the GitHub App's private key", () => {
  it('reads the PKCS#1 key GitHub hands out, and PKCS#8 too', async () => {
    expect(PKCS1).toContain('BEGIN RSA PRIVATE KEY');
    expect(await signs(await importAppKey(PKCS1), publicKey)).toBe(true);
    expect(await signs(await importAppKey(PKCS8.privateKey), PKCS8.publicKey)).toBe(true);
  });

  it('reads a key whose line breaks are written as \\n, in quotes, as in .dev.vars', async () => {
    const oneLine = `"${PKCS1.trim().replace(/\n/g, '\\n')}"`;
    expect(oneLine).not.toContain('\n');
    expect(await signs(await importAppKey(oneLine), publicKey)).toBe(true);
    expect(await signs(await importAppKey(PKCS1.replace(/\n/g, '\r\n')), publicKey)).toBe(true);
  });

  it('says plainly what is wrong with a bad key, without repeating it', async () => {
    await expect(importAppKey('not a key')).rejects.toThrow('should start with -----BEGIN RSA PRIVATE KEY-----');
    const damaged = PKCS1.replace(/\n[A-Za-z0-9+/]{20}/, '\nAAAA');
    const error = await importAppKey(damaged).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^GITHUB_APP_PRIVATE_KEY (could not be read|is damaged)/);
    expect((error as Error).message).not.toContain(PKCS1.split('\n')[1]!.slice(0, 16));
  });
});

describe('the GitHub App', () => {
  it('signs in with a JWT that GitHub accepts: RS256, its App ID, valid for nine minutes from a minute ago', async () => {
    const fake = new FakeGitHub();
    fake.createRepo('notes');
    const seen: string[] = [];
    fake.use((request, next) => (seen.push(request.headers.get('authorization')!), next(request)));
    expect(await app(fake).installation('notes', new Budget(5))).toBe(77);
    const claims = JSON.parse(Buffer.from(seen[0]!.split('.')[1]!, 'base64url').toString());
    expect(claims.iss).toBe(1234567);
    expect(claims.exp - claims.iat).toBe(600);
    expect(Math.floor(Date.now() / 1000) - claims.iat).toBeGreaterThanOrEqual(59);
  });

  it("is refused by GitHub when the key isn't the App's", async () => {
    const fake = new FakeGitHub();
    fake.createRepo('notes');
    await expect(app(fake, { privateKey: PKCS1 }).installation('notes', new Budget(5))).rejects.toThrow('GitHub answered 401');
  });

  it("finds its installation on a repo, and says when there isn't one", async () => {
    const fake = new FakeGitHub();
    fake.createRepo('notes');
    fake.createRepo('private', { installed: false });
    const github = app(fake);
    expect(await github.installation('notes', new Budget(5))).toBe(77);
    expect(await github.installation('private', new Budget(5))).toBeUndefined();
    expect(await github.installation('nowhere', new Budget(5))).toBeUndefined();
  });

  it('gets a token for one repo, keeps it, and renews it when it nearly expires', async () => {
    const fake = new FakeGitHub();
    fake.createRepo('notes');
    let now = Date.now();
    fake.now = () => now;
    const github = app(fake, { now: () => now });
    const budget = new Budget(40);
    for (let i = 0; i < 3; i++) expect(await github.repo('notes', budget).main()).toBe('empty');
    expect(fake.requests.filter((line) => line.includes('access_tokens'))).toHaveLength(1);
    expect(fake.requests.filter((line) => line.endsWith('/installation'))).toHaveLength(1);
    now += 56 * 60_000; // less than five minutes left
    await github.repo('notes', budget).main();
    expect(fake.requests.filter((line) => line.includes('access_tokens'))).toHaveLength(2);
  });

  it('sends the headers GitHub asks for', async () => {
    const fake = new FakeGitHub();
    fake.createRepo('notes');
    const requests: Request[] = [];
    fake.use((request, next) => (requests.push(request), next(request)));
    await app(fake).repo('notes', new Budget(5)).main();
    for (const request of requests) {
      expect(request.headers.get('user-agent')).toBe('Quillipi');
      expect(request.headers.get('accept')).toBe('application/vnd.github+json');
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
    }
    expect(requests.at(-1)!.headers.get('authorization')).toMatch(/^token ghs_/);
  });

  it('turns failures into plain errors that can be tried again', async () => {
    const fake = new FakeGitHub();
    fake.createRepo('notes');
    let mode: 'down' | 'broken' | 'revoked' | 'fine' = 'down';
    fake.use(async (request, next) => {
      if (!request.url.includes('/git/ref/')) return next(request);
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === 'broken') return new Response(JSON.stringify({ message: 'Server Error' }), { status: 502 });
      if (mode === 'revoked') return new Response('{}', { status: 401 });
      return next(request);
    });
    const github = app(fake);
    const budget = new Budget(40);
    const failure = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
    const down = await failure(github.repo('notes', budget).main());
    expect(down).toBeInstanceOf(GitHubError);
    expect((down as Error).message).toBe('GitHub could not be reached: fetch failed');
    mode = 'broken';
    expect(((await failure(github.repo('notes', budget).main())) as Error).message).toBe('GitHub answered 502 to GET /repos/OctoCat/notes/git/ref/heads/main: Server Error');
    mode = 'revoked';
    await expect(github.repo('notes', budget).main()).rejects.toThrow("GitHub refused the App's token");
    mode = 'fine';
    expect(await github.repo('notes', budget).main()).toBe('empty');
    expect(fake.requests.filter((line) => line.includes('access_tokens'))).toHaveLength(2); // a new token after the refusal
  });

  it('counts every request against the step’s budget', async () => {
    const fake = new FakeGitHub();
    fake.createRepo('notes');
    const budget = new Budget(3);
    const repo = app(fake).repo('notes', budget);
    await repo.main(); // installation, token, ref
    expect(budget.left).toBe(0);
    await expect(repo.main()).rejects.toBeInstanceOf(OutOfRequests);
    expect(fake.requests).toHaveLength(3);
  });
});

describe('base64', () => {
  it('round-trips any bytes, including large ones, and reads GitHub’s line-broken form', () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) % 256);
    expect(Buffer.from(fromBase64(toBase64(bytes))).equals(Buffer.from(bytes))).toBe(true);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(new TextDecoder().decode(fromBase64('aGVs\nbG8=\n'))).toBe('hello');
  });
});
