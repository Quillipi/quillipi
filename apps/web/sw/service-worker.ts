/**
 * Quillipi's service worker: what lets the app be installed, open at once, and open without a
 * connection (step 3.5). The app registers it only in the cloud (installable.ts).
 *
 * It keeps one copy of the app's files for each build, listed when the app is built (plugin.ts),
 * and answers three kinds of request:
 *
 * - The app's pages (/, /agents, /n/…): from the network first, so the newest app always opens
 *   and a deploy never leaves an old app talking to a new cloud. When the network fails, or takes
 *   longer than PAGE_WAIT_MS, the page kept with this build's files opens instead.
 * - The app's files (its scripts, styles, fonts, icons and pictures): from the copy, because a
 *   file's name changes with its content. A file not kept yet is fetched, and kept.
 * - Everything else, the Worker's own routes above all (/api, /mcp, sign-in, /status): untouched,
 *   so the browser sends it as if there were no service worker.
 *
 * A new build's worker installs beside the one in use and waits, because pages still open may
 * need files of their own build. The app asks a worker which build it has (`build`) to tell an
 * update from the build it already runs, and says when to take over (`activate`).
 */

/** What one build of the app is: its name, and every file it needs, the page as `/` first. */
export interface Build {
  id: string;
  files: string[];
}

/** Messages the app sends. `build` comes with a port for the answer, `{ build: id }`. */
export type WorkerMessage = { type: 'build' } | { type: 'activate' };

export const CACHE_PREFIX = 'inklog-app-';

/** How long a page may take from the network before the kept one opens. */
export const PAGE_WAIT_MS = 4000;

/**
 * How a request is answered: as one of the app's pages, as one of its files, as a page the Worker
 * answers (`worker`), or not at all.
 */
export type Plan = 'page' | 'file' | 'worker' | 'pass';

export function planFor(request: { method: string; url: string; mode: string }, origin: string, kept: ReadonlySet<string>): Plan {
  if (request.method !== 'GET') return 'pass';
  const url = new URL(request.url);
  if (url.origin !== origin) return 'pass';
  if ((kept.has(url.pathname) && url.pathname !== '/') || url.pathname.startsWith('/assets/')) return 'file';
  if (request.mode === 'navigate') return isAppPage(url.pathname) ? 'page' : 'worker';
  return 'pass';
}

/**
 * Whether an address is one of the app's pages, as the app's router reads addresses (router.ts):
 * Home, Agents, a notebook, a folder in it, a section. Only these are taken over, so a page the
 * Worker answers, such as sign-in, always comes from the Worker.
 */
export function isAppPage(pathname: string): boolean {
  const [first, id, kind, ...rest] = pathname.split('/').filter(Boolean);
  if (!first) return true;
  if (first === 'agents') return !id;
  if (first !== 'n' || !id) return false;
  if (!kind) return true;
  return (kind === 'f' && rest.length > 0) || (kind === 's' && rest.length === 1);
}

/** Sets the worker up in its scope: the service worker's own global, or a stand-in in tests. */
export function serve(scope: ServiceWorkerGlobalScope, build: Build): void {
  const cacheName = CACHE_PREFIX + build.id;
  const kept = new Set(build.files);
  const origin = scope.location.origin;

  scope.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(cacheName);
        // Past the browser's own cache, so a file is this build's and not one it remembered.
        await cache.addAll(build.files.map((file) => new Request(new URL(file, origin), { cache: 'reload' })));
      })(),
    );
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await scope.caches.keys()) {
          if (name.startsWith(CACHE_PREFIX) && name !== cacheName) await scope.caches.delete(name);
        }
        // The page's request starts while the worker is still waking, which saves a moment on a phone.
        await scope.registration.navigationPreload?.enable();
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener('message', (event) => {
    const message = event.data as WorkerMessage | undefined;
    if (message?.type === 'build') event.ports[0]?.postMessage({ build: build.id });
    if (message?.type === 'activate') void scope.skipWaiting();
  });

  scope.addEventListener('fetch', (event) => {
    const plan = planFor(event.request, origin, kept);
    if (plan === 'page') event.respondWith(page(event));
    else if (plan === 'file') event.respondWith(file(event));
    else if (plan === 'worker') event.respondWith(fromWorker(event));
  });

  /**
   * A page the Worker answers, such as sign-in or GitHub's return to it: the answer to the request
   * the browser already sent while the worker woke (navigation preload), never kept and never
   * replaced. Left unanswered, the browser would send the request a second time, and a return from
   * GitHub carries a code that works once, so the second would fail (seen on 2026-11-17).
   */
  async function fromWorker(event: FetchEvent): Promise<Response> {
    return (await event.preloadResponse) ?? scope.fetch(event.request);
  }

  async function page(event: FetchEvent): Promise<Response> {
    const network = (async () => (await event.preloadResponse) ?? scope.fetch(event.request))();
    // Settles in the background when the kept page answered first; its result is no longer needed.
    event.waitUntil(network.then(nothing, nothing));
    try {
      return await within(network, PAGE_WAIT_MS);
    } catch {
      const keptPage = await (await scope.caches.open(cacheName)).match('/');
      if (!keptPage) return Response.error();
      // A browser refuses a redirected answer to a page request, so the kept page is handed over plain.
      return keptPage.redirected ? new Response(keptPage.body, keptPage) : keptPage;
    }
  }

  async function file(event: FetchEvent): Promise<Response> {
    const cache = await scope.caches.open(cacheName);
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    const response = await scope.fetch(event.request);
    // An address that matches no file gets the app's page, so that answer is never kept as a file.
    if (response.ok && !(response.headers.get('content-type') ?? '').startsWith('text/html')) {
      event.waitUntil(cache.put(new URL(event.request.url).pathname, response.clone()));
    }
    return response;
  }
}

/** The promise's answer, or a failure once `ms` have passed without one. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Too slow')), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error: unknown) => (clearTimeout(timer), reject(error)),
    );
  });
}

function nothing(): void {}
