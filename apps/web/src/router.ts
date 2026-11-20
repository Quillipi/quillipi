/**
 * Where the app is, from its address, so back, forward and reload work and an address can be shared:
 *
 *   /                      Home
 *   /agents                Agents
 *   /n/<id>                a notebook's overview
 *   /n/<id>/f/<a>/<b>      the overview of the folder a/b in it
 *   /n/<id>/s/<section>    a section, in the editor
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { page: 'home' }
  | { page: 'agents' }
  | { page: 'notebook'; id: string; folder: string }
  | { page: 'section'; id: string; section: string }
  | { page: 'unknown' };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  if (parts.some((part) => part === undefined)) return { page: 'unknown' };
  const [first, id, kind, ...rest] = parts as string[];
  if (!first) return { page: 'home' };
  if (first === 'agents' && !id) return { page: 'agents' };
  if (first !== 'n' || !id) return { page: 'unknown' };
  if (!kind) return { page: 'notebook', id, folder: '' };
  if (kind === 'f' && rest.length) return { page: 'notebook', id, folder: rest.join('/') };
  if (kind === 's' && rest.length === 1) return { page: 'section', id, section: rest[0]! };
  return { page: 'unknown' };
}

export function href(route: Route): string {
  switch (route.page) {
    case 'home':
    case 'unknown':
      return '/';
    case 'agents':
      return '/agents';
    case 'notebook':
      return `/n/${encodeURIComponent(route.id)}${route.folder ? `/f/${route.folder.split('/').map(encodeURIComponent).join('/')}` : ''}`;
    case 'section':
      return `/n/${encodeURIComponent(route.id)}/s/${encodeURIComponent(route.section)}`;
  }
}

/** The notebook a route is in, if any. */
export function notebookOf(route: Route): string | undefined {
  return route.page === 'notebook' || route.page === 'section' ? route.id : undefined;
}

// The browser's side: the address now, and telling the app when it changes. Guarded, so the
// functions above can be tested without a browser.
const listeners = new Set<() => void>();
let current: Route = typeof location === 'undefined' ? { page: 'home' } : parseRoute(location.pathname);

function changed(): void {
  current = parseRoute(location.pathname);
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') window.addEventListener('popstate', changed);

/**
 * Something that may take over a move to load the page afresh instead: a newer Quillipi is ready
 * (installable.ts). It answers whether it took the move.
 */
let takeOver: ((target: string) => boolean) | undefined;

export function takeOverMoves(handler: (target: string) => boolean): void {
  takeOver = handler;
}

/** Goes somewhere in the app, without reloading the page unless a newer Quillipi is waiting. */
export function navigate(to: Route | string, { replace = false } = {}): void {
  const target = typeof to === 'string' ? to : href(to);
  if (target === location.pathname) return;
  if (takeOver?.(target)) return;
  go(target, replace);
}

/** Goes somewhere in the app without reloading the page. */
export function go(target: string, replace = false): void {
  if (replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  scrollTo(0, 0);
  changed();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}
