/**
 * The app: it learns which Quillipi serves it (the cloud, with many notebooks, or the laptop, with
 * one), then shows the page the address names inside the frame (frame/Frame.tsx).
 */
import { type ReactNode, useEffect, useState } from 'react';
import { AnswerError, LibraryLive, Live, SetupNeeded, SignInNeeded, api, setNotebook, whichHost } from './api';
import { TabBar } from './components/Tabs';
import { Frame } from './frame/Frame';
import { HistoryPanel } from './frame/HistoryPanel';
import { startServiceWorker } from './installable';
import { LiveContext } from './live-context';
import { Agents } from './pages/Agents';
import { Home } from './pages/Home';
import { Overview } from './pages/Overview';
import { SectionPage } from './pages/SectionPage';
import { navigate, notebookOf, useRoute } from './router';
import { rememberNotebook, useApp, useShelf } from './store';
import { Button } from './ui/Button';

export function App() {
  const [error, setError] = useState<Error>();
  const host = useShelf((state) => state.host);
  const route = useRoute();

  useEffect(() => {
    let library: LibraryLive | undefined;
    whichHost().then((found) => {
      if (found.kind === 'laptop') {
        // The laptop serves one notebook, so its pages are the start.
        if (!notebookOf(route)) navigate({ page: 'notebook', id: found.notebook.id, folder: '' }, { replace: true });
        useShelf.setState({ host: 'laptop' });
        return;
      }
      useShelf.setState({ host: 'cloud', me: found.me });
      void startServiceWorker();
      const shelf = useShelf.getState();
      library = new LibraryLive((message) => {
        if (message.type === 'cards') shelf.setCards(message.cards);
        else if (message.type === 'card') shelf.putCard(message.card);
        else if (message.type === 'removed') shelf.removeCard(message.id);
        else shelf.setClaudeConnected();
      });
    }, setError);
    return () => library?.close();
    // Once per page load: the host doesn't change.
  }, []);

  if (error) return <Problem error={error} full />;
  if (!host) return <Notice full>Opening…</Notice>;
  return (
    <Frame>
      <Page />
    </Frame>
  );
}

function Page() {
  const route = useRoute();
  const host = useShelf((state) => state.host);
  const id = notebookOf(route);
  if (route.page === 'home' && host === 'cloud') return <Home />;
  if (route.page === 'agents' && host === 'cloud') return <Agents />;
  if (!id) return <NotFound />;
  return (
    <OpenNotebook id={id}>
      {route.page === 'section' ? <SectionPage key={`${id}/${route.section}`} section={route.section} /> : <Overview key={`${id}/${route.page === 'notebook' ? route.folder : ''}`} folder={route.page === 'notebook' ? route.folder : ''} />}
    </OpenNotebook>
  );
}

/**
 * Opens a notebook for the pages inside it: its info, kept live over its own connection, which
 * closes when the address leaves the notebook. The live connection is shared by every page in it.
 */
function OpenNotebook({ id, children }: { id: string; children: ReactNode }) {
  const [error, setError] = useState<Error>();
  const [live, setLive] = useState<Live>();
  const info = useApp((state) => state.info);
  const open = useApp((state) => state.notebook);

  useEffect(() => {
    setNotebook(id);
    useApp.getState().openNotebook(id);
    rememberNotebook(id);
    setError(undefined);
    const { setInfo, setOnline } = useApp.getState();
    const connection = new Live(id, setOnline);
    setLive(connection);
    api.repo().then(setInfo, (failure: Error) => {
      connection.close();
      setError(failure);
    });
    // Opening the notebook is a visit; the answer says when the one before was, for the bell.
    api.visit().then(
      ({ before }) => useApp.getState().notebook === id && useApp.setState({ visitedBefore: before }),
      () => {},
    );
    const stop = connection.subscribe((event) => {
      if (event.type === 'repo') setInfo(event.info);
      if (event.type === 'connected') void api.repo().then(setInfo);
    });
    return () => {
      stop();
      connection.close();
    };
  }, [id]);

  if (error) return <Problem error={error} />;
  if (!info || !live || open !== id) return <Notice>Opening…</Notice>;
  return (
    <LiveContext.Provider value={live}>
      <NotebookDesk>{children}</NotebookDesk>
    </LiveContext.Provider>
  );
}

/**
 * Inside a notebook: the bar of tabs across the top, under it the overview or the open section,
 * and beside that the History panel.
 */
function NotebookDesk({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabBar />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        <HistoryPanel />
      </div>
    </div>
  );
}

/** A few words in place of a page: while it opens, or when it can't. */
export function Notice({ title, children, full = false }: { title?: string; children: ReactNode; full?: boolean }) {
  return (
    <main className={full ? 'grid h-dvh place-items-center bg-desk p-6' : 'grid min-h-0 flex-1 place-items-center p-6'}>
      <div className="max-w-md text-center">
        {title && <h1 className="mb-2 text-[20px] font-semibold tracking-[-0.02em]">{title}</h1>}
        <div className="flex flex-col gap-2 text-[14px] leading-relaxed text-muted-foreground [&_a]:font-medium [&_a]:text-brand [&_a]:hover:underline">{children}</div>
      </div>
    </main>
  );
}

function NotFound() {
  return (
    <Notice title="Nothing is here">
      <p>This address doesn't lead to a notebook or a page of Quillipi.</p>
      <p>
        <a href="/">Go to the start</a>
      </p>
    </Notice>
  );
}

/** Why a page couldn't open; `full` when it stands for the whole app, before the frame is drawn. */
export function Problem({ error, full = false }: { error: Error; full?: boolean }) {
  if (error instanceof SignInNeeded || error instanceof SetupNeeded) return <Notice full>{error.message}</Notice>;
  if (error instanceof AnswerError) {
    return (
      <Notice title="Quillipi couldn't open this" full={full}>
        <p>{error.message}</p>
      </Notice>
    );
  }
  return <Unreachable full={full} />;
}

/** How often a page that couldn't reach Quillipi quietly asks again. */
const ASK_AGAIN_MS = 10_000;

/**
 * Quillipi didn't answer. An installed app has no reload button, so this page has its own, and it
 * opens again by itself: when the device is back online, or when Quillipi answers a quiet question
 * (a device can think it is online while Quillipi can't be reached).
 */
function Unreachable({ full }: { full: boolean }) {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const back = () => location.reload();
    const away = () => setOnline(false);
    const ask = () => {
      if (document.visibilityState !== 'visible') return;
      fetch('/api/me', { cache: 'no-store' }).then(back, () => {});
    };
    const timer = setInterval(ask, ASK_AGAIN_MS);
    window.addEventListener('online', back);
    window.addEventListener('offline', away);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', back);
      window.removeEventListener('offline', away);
    };
  }, []);

  return (
    <Notice title={online ? "Quillipi isn't reachable" : "You're offline"} full={full}>
      <p>{online ? 'Check your connection, or that Quillipi is still running. It tries again by itself.' : 'Quillipi opens again by itself when this device is connected.'}</p>
      <p className="mt-2">
        <Button variant="outline" onClick={() => location.reload()}>
          Try again
        </Button>
      </p>
    </Notice>
  );
}
