/**
 * Quillipi as an installed app (step 3.5): the service worker (sw/service-worker.ts), updates after a
 * deploy, and installing.
 *
 * Updates. The cloud changes with every deploy, while the app may stay open for days, as an
 * installed app on a phone does. So the app looks for a new build when it comes back to the
 * screen, when its live connection comes back (a deploy closes every connection) and every hour.
 * A new build's worker says which build it has; when that isn't the one running, an update is
 * ready, and it is used where nothing can be lost: on the next move out of the open notebook,
 * which then loads the page afresh, or when Update is pressed. Open sections are saved first.
 * Nothing reloads by itself while you work.
 *
 * Installing. Chrome and Edge offer to install the app; the offer is kept for the menu under you.
 * An iPhone or iPad makes no offer: the app is added from the Share menu, which the menu explains.
 */
import { create } from 'zustand';
import { saveOpenSections } from './editor/sync';
import { go, notebookOf, parseRoute, takeOverMoves } from './router';

/** Chrome's offer to install the app (its `beforeinstallprompt` event). */
interface InstallOffer extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallState {
  /** A newer Quillipi is ready: the next move out of the notebook loads it, or Update does now. */
  updateReady: boolean;
  /** The browser offers to install the app. */
  offer?: InstallOffer;
  /** On an iPhone or iPad, in the browser: the app is added from the Share menu. */
  shareMenu: boolean;
}

export const useInstall = create<InstallState>()(() => ({ updateReady: false, shareMenu: false }));

/** Which build this page is (sw/plugin.ts writes it into the page); none under the dev server. */
const thisBuild = typeof document === 'undefined' ? undefined : document.querySelector<HTMLMetaElement>('meta[name="inklog-build"]')?.content;

const CHECK_EVERY_MS = 60 * 60 * 1000;
/** Coming back to the screen looks again only if the last look is at least this old. */
const CHECK_AGAIN_MS = 60 * 1000;

let registration: ServiceWorkerRegistration | undefined;

/** Starts the service worker, in the cloud only: the laptop program serves one notebook on this computer. */
export async function startServiceWorker(): Promise<void> {
  if (!thisBuild || !('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Without it the app works as a plain web page: it just can't open offline.
    return;
  }
  const found = registration;
  found.addEventListener('updatefound', () => {
    const worker = found.installing;
    worker?.addEventListener('statechange', () => worker.state === 'installed' && void consider(worker));
  });
  if (found.waiting) void consider(found.waiting);
  // Another window updated Quillipi: this page is an old build now.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const controller = navigator.serviceWorker.controller;
    if (controller) void consider(controller);
  });

  let lastLook = Date.now();
  const look = (force = false) => {
    if (!force && Date.now() - lastLook < CHECK_AGAIN_MS) return;
    lastLook = Date.now();
    found.update().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && look());
  window.addEventListener('inklog:reconnected', () => look(true));
  setInterval(() => document.visibilityState === 'visible' && look(true), CHECK_EVERY_MS);
}

/** A worker that isn't this page's build means an update; one that is takes over quietly. */
async function consider(worker: ServiceWorker): Promise<void> {
  const build = await buildOf(worker);
  if (!build) return;
  if (build === thisBuild) {
    if (worker.state === 'installed') worker.postMessage({ type: 'activate' });
    return;
  }
  if (useInstall.getState().updateReady) return;
  useInstall.setState({ updateReady: true });
  takeOverMoves((target) => {
    // Inside one notebook the History panel stays, with a commit message perhaps half written.
    const from = notebookOf(parseRoute(location.pathname));
    if (from !== undefined && from === notebookOf(parseRoute(target))) return false;
    void update(target).then((done) => done || go(target));
    return true;
  });
}

function buildOf(worker: ServiceWorker): Promise<string | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(undefined), 3000);
    channel.port1.onmessage = (event: MessageEvent<{ build?: string }>) => {
      clearTimeout(timer);
      resolve(event.data.build);
    };
    worker.postMessage({ type: 'build' }, [channel.port2]);
  });
}

/**
 * Loads the new build: at `target`, or here. Open sections are saved first; if one can't be,
 * such as while Quillipi can't be reached, nothing happens and it says so (false).
 */
export async function update(target?: string): Promise<boolean> {
  if (!(await saveOpenSections())) return false;
  const waiting = registration?.waiting;
  if (waiting) {
    const taken = new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      setTimeout(resolve, 2000);
    });
    waiting.postMessage({ type: 'activate' });
    await taken;
  }
  if (target) location.assign(target);
  else location.reload();
  return true;
}

/** Shows the browser's own Install dialog. */
export async function install(): Promise<void> {
  const { offer } = useInstall.getState();
  if (!offer) return;
  await offer.prompt();
  // An offer can be shown once; the browser makes a new one if this one was turned down.
  useInstall.setState({ offer: undefined });
}

/** Whether this page is the installed app, rather than a page in the browser. */
function installed(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

if (typeof window !== 'undefined') {
  // Listened for at once: the browser makes its offer soon after the page loads.
  window.addEventListener('beforeinstallprompt', (event) => {
    // The menu offers it, instead of the bar Chrome would show over the page on a phone.
    event.preventDefault();
    useInstall.setState({ offer: event as InstallOffer });
  });
  window.addEventListener('appinstalled', () => useInstall.setState({ offer: undefined, shareMenu: false }));
  // An iPad says it is a Mac; its touch screen tells them apart.
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
  useInstall.setState({ shareMenu: apple && !installed() });
}
