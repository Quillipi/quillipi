/**
 * The service worker (sw/service-worker.ts), run in Node against a stand-in for the browser's
 * worker scope: which requests it takes over (the Worker's own pages only to answer them once), how it answers them online, offline and on a slow
 * network, how a new build waits and takes over, and the build's list and name (sw/plugin.ts).
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildId, precacheList, withBuildName } from '../sw/plugin';
import { type Build, CACHE_PREFIX, PAGE_WAIT_MS, isAppPage, planFor, serve } from '../sw/service-worker';
import { parseJsonc } from '../../../deploy/build.mjs';
import { parseRoute } from '../src/router';

const ORIGIN = 'https://quillipi.example.workers.dev';
const BUILD: Build = { id: 'b1', files: ['/', '/assets/index-abc.js', '/assets/index-abc.css', '/icons/icon-192.png'] };
const kept = new Set(BUILD.files);

const navigation = (path: string, method = 'GET') => ({ method, url: ORIGIN + path, mode: 'navigate' });
const resource = (path: string) => ({ method: 'GET', url: ORIGIN + path, mode: 'no-cors' });

describe('which requests the worker takes over', () => {
  it('opens the app’s pages, network first', () => {
    for (const path of ['/', '/agents', '/n/inklog', '/n/inklog/s/start-here', '/n/inklog/f/plans/later']) expect(planFor(navigation(path), ORIGIN, kept)).toBe('page');
  });

  it('serves the app’s files from its copy, even when one is opened as a page', () => {
    expect(planFor(resource('/assets/index-abc.js'), ORIGIN, kept)).toBe('file');
    expect(planFor(resource('/assets/a-file-of-a-newer-build.js'), ORIGIN, kept)).toBe('file');
    expect(planFor(navigation('/icons/icon-192.png'), ORIGIN, kept)).toBe('file');
  });

  it('hands the Worker’s own pages the request the browser already sent, and leaves alone calls that change something, other sites and notebook files', () => {
    for (const path of ['/signin', '/signin/callback', '/authorize', '/callback', '/setup', '/setup/callback', '/status', '/api/me', '/mcp', '/.well-known/oauth-authorization-server', '/n/']) {
      expect(planFor(navigation(path), ORIGIN, kept)).toBe('worker');
    }
    expect(planFor(navigation('/', 'POST'), ORIGIN, kept)).toBe('pass');
    expect(planFor(resource('/'), ORIGIN, kept)).toBe('pass');
    expect(planFor(resource('/api/n/inklog/files/assets/a.png'), ORIGIN, kept)).toBe('pass');
    expect(planFor({ method: 'GET', url: 'https://avatars.githubusercontent.com/u/1', mode: 'no-cors' }, ORIGIN, kept)).toBe('pass');
  });

  it('reads addresses as the app’s router does', () => {
    const paths = ['/', '/agents', '/agents/', '/agents/x', '/n', '/n/', '/n/a', '/n/a/', '/n/a/s', '/n/a/s/b', '/n/a/s/b/c', '/n/a/f', '/n/a/f/x', '/n/a/f/x/y', '/n/a/x', '/x', '/signin', '/assets/a.js'];
    for (const path of paths) expect(isAppPage(path), path).toBe(parseRoute(path).page !== 'unknown');
  });

  it('never takes a page the Worker answers first (wrangler.jsonc, run_worker_first)', () => {
    const config = fs.readFileSync(new URL('../../cloud/wrangler.jsonc', import.meta.url), 'utf8');
    const routes: string[] = parseJsonc(config).assets.run_worker_first;
    expect(routes.length).toBeGreaterThan(5);
    for (const route of routes) {
      const path = route.replace(/\*$/, 'anything');
      expect(isAppPage(path), route).toBe(false);
      expect(planFor(navigation(path), ORIGIN, kept), route).toBe('worker');
    }
  });
});

describe('the worker at work', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps every file of its build when it installs, fetched past the browser’s cache', async () => {
    const worker = start();
    await worker.fire('install');
    expect(worker.fetched.map((request) => [new URL(request.url).pathname, request.cache])).toEqual(BUILD.files.map((file) => [file, 'reload']));
    expect([...worker.cache(`${CACHE_PREFIX}b1`).keys()]).toEqual(BUILD.files);
    // Pages still open may need their own build's files, so a new worker waits to be told.
    expect(worker.skippedWaiting).toBe(false);
  });

  it('opens a page from the network when it answers', async () => {
    const worker = start();
    await worker.fire('install');
    worker.network = () => page('fresh');
    expect(await (await worker.request(navigation('/n/inklog'))).text()).toBe('fresh');
  });

  it('uses the page the browser started fetching while the worker woke', async () => {
    const worker = start();
    worker.network = () => page('fetched twice');
    expect(await (await worker.request(navigation('/'), { preload: page('preloaded') })).text()).toBe('preloaded');
  });

  it('opens the kept page when the network fails', async () => {
    const worker = start();
    await worker.fire('install');
    worker.network = () => Promise.reject(new TypeError('Failed to fetch'));
    const response = await worker.request(navigation('/n/inklog/s/start-here'));
    expect(await response.text()).toBe('kept /');
  });

  it('opens the kept page when the network takes too long', async () => {
    const worker = start();
    await worker.fire('install');
    vi.useFakeTimers();
    worker.network = () => new Promise(() => {});
    const answer = worker.request(navigation('/'));
    await vi.advanceTimersByTimeAsync(PAGE_WAIT_MS - 1);
    expect(worker.answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await answer).text()).toBe('kept /');
  });

  it('says plainly that it can’t open a page offline before it has kept one', async () => {
    const worker = start();
    worker.network = () => Promise.reject(new TypeError('Failed to fetch'));
    expect((await worker.request(navigation('/'))).type).toBe('error');
  });

  it('serves a kept file without the network, and keeps a new one, but never a page in a file’s place', async () => {
    const worker = start();
    await worker.fire('install');
    worker.fetched.length = 0;
    expect(await (await worker.request(resource('/assets/index-abc.js'))).text()).toBe('kept /assets/index-abc.js');
    expect(worker.fetched).toEqual([]);

    worker.network = (request) => Promise.resolve(new Response('new', { headers: { 'content-type': 'text/javascript' } }));
    await worker.request(resource('/assets/index-new.js'));
    expect(worker.cache(`${CACHE_PREFIX}b1`).has('/assets/index-new.js')).toBe(true);

    // A file of an older build is gone after a deploy: the address gets the app's page instead.
    worker.network = () => page('<!doctype html>');
    await worker.request(resource('/assets/index-old.js'));
    expect(worker.cache(`${CACHE_PREFIX}b1`).has('/assets/index-old.js')).toBe(false);
  });

  it('asks the Worker for its own page once: the request the browser sent early is the answer', async () => {
    const worker = start();
    // GitHub's return to sign-in carries a code that works once (a second request failed live, 2026-11-17).
    const back = await worker.request(navigation('/signin/callback?code=once&state=s'), { preload: page('signed in') });
    expect(await back.text()).toBe('signed in');
    expect(worker.fetched).toEqual([]);
    // Without an early request, one request to the network, kept nowhere.
    expect(await (await worker.request(navigation('/setup'))).text()).toBe('kept /setup');
    expect(worker.fetched.map((request) => new URL(request.url).pathname)).toEqual(['/setup']);
    expect(worker.cache(`${CACHE_PREFIX}b1`).has('/setup')).toBe(false);
  });

  it('lets everything else go to the network untouched', async () => {
    const worker = start();
    await worker.request({ method: 'POST', url: `${ORIGIN}/api/n/inklog/commit`, mode: 'cors' });
    await worker.request(navigation('/signin', 'POST'));
    await worker.request({ method: 'GET', url: 'https://github.com/login', mode: 'navigate' });
    expect(worker.respondedWith).toBe(0);
  });

  it('when it takes over, removes older builds’ copies and nothing else, and takes over open pages', async () => {
    const worker = start();
    worker.cache(`${CACHE_PREFIX}old`);
    worker.cache('someone-else');
    await worker.fire('install');
    await worker.fire('activate');
    expect([...worker.caches.keys()].sort()).toEqual([`${CACHE_PREFIX}b1`, 'someone-else']);
    expect(worker.preloadEnabled).toBe(true);
    expect(worker.claimed).toBe(true);
  });

  it('says which build it is, and takes over only when the app says so', async () => {
    const worker = start();
    const port = { postMessage: vi.fn() };
    await worker.fire('message', { data: { type: 'build' }, ports: [port] });
    expect(port.postMessage).toHaveBeenCalledWith({ build: 'b1' });
    expect(worker.skippedWaiting).toBe(false);
    await worker.fire('message', { data: { type: 'activate' }, ports: [] });
    expect(worker.skippedWaiting).toBe(true);
  });
});

describe('the build’s list and name', () => {
  it('lists the page as / first, then every other file once, in order, without the header rules or the worker', () => {
    expect(precacheList(['index.html', 'assets/b.js', '_headers', 'assets/a.css', 'sw.js', 'icons/icon-192.png', 'assets/b.js'])).toEqual(['/', '/assets/a.css', '/assets/b.js', '/icons/icon-192.png']);
  });

  it('names a build from its files’ names and contents, whatever their order', () => {
    const one = buildId([
      ['assets/a.js', 'one'],
      ['icons/i.png', new Uint8Array([1, 2])],
    ]);
    expect(one).toMatch(/^[0-9a-f]{12}$/);
    expect(
      buildId([
        ['icons/i.png', new Uint8Array([1, 2])],
        ['assets/a.js', 'one'],
      ]),
    ).toBe(one);
    expect(
      buildId([
        ['assets/a.js', 'one'],
        ['icons/i.png', new Uint8Array([1, 3])],
      ]),
    ).not.toBe(one);
    expect(buildId([['assets/b.js', 'one']])).not.toBe(buildId([['assets/a.js', 'one']]));
  });

  it('writes the build’s name into the page', () => {
    expect(withBuildName('<html><head><title>Quillipi</title></head></html>', 'abc123')).toContain('<meta name="inklog-build" content="abc123" />\n  </head>');
    expect(() => withBuildName('<html></html>', 'abc123')).toThrow();
  });
});

// A stand-in for the service worker's scope: its events, its caches and the network.

type Network = (request: Request) => Promise<Response>;

function page(text: string): Promise<Response> {
  return Promise.resolve(new Response(text, { headers: { 'content-type': 'text/html' } }));
}

function start() {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = new Map<string, Map<string, Response>>();
  const pathOf = (request: Request | string) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
  const cacheApi = (name: string) => {
    const store = worker.cache(name);
    return {
      addAll: async (requests: Request[]) => {
        for (const request of requests) store.set(pathOf(request), await worker.fetch(request));
      },
      match: async (request: Request | string) => store.get(pathOf(request))?.clone(),
      put: async (request: Request | string, response: Response) => void store.set(pathOf(request), response),
    };
  };
  const worker = {
    fetched: [] as Request[],
    network: ((request) => Promise.resolve(new Response(`kept ${pathOf(request)}`))) as Network,
    caches,
    respondedWith: 0,
    answered: false,
    preloadEnabled: false,
    claimed: false,
    skippedWaiting: false,
    cache(name: string) {
      if (!caches.has(name)) caches.set(name, new Map());
      return caches.get(name)!;
    },
    fetch(request: Request) {
      worker.fetched.push(request);
      return worker.network(request);
    },
    async fire(type: string, extra: object = {}) {
      const waits: Promise<unknown>[] = [];
      listeners.get(type)!({ ...extra, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
      await Promise.all(waits);
    },
    /** A request as the browser sends it; the worker's answer, or the network's when it lets it pass. */
    async request(init: { method: string; url: string; mode: string }, { preload }: { preload?: Promise<Response> } = {}): Promise<Response> {
      let answer: Promise<Response> | undefined;
      const request = new Request(init.url, { method: init.method });
      listeners.get('fetch')!({
        request: { ...init, url: init.url, method: init.method, mode: init.mode, clone: () => request },
        preloadResponse: preload ?? Promise.resolve(undefined),
        waitUntil: () => {},
        respondWith: (promise: Promise<Response>) => {
          worker.respondedWith++;
          answer = promise.then((response) => ((worker.answered = true), response));
        },
      });
      return answer ?? worker.network(request);
    },
  };
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    caches: {
      open: async (name: string) => cacheApi(name),
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
    },
    fetch: (request: Request | { url: string }) => worker.fetch(request instanceof Request ? request : new Request(request.url)),
    registration: { navigationPreload: { enable: async () => void (worker.preloadEnabled = true) } },
    clients: { claim: async () => void (worker.claimed = true) },
    skipWaiting: async () => void (worker.skippedWaiting = true),
  };
  serve(scope as unknown as ServiceWorkerGlobalScope, BUILD);
  return worker;
}
