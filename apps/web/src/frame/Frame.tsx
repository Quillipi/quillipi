/**
 * The frame every page sits in, laid out like Cloud Dock: the rail of places on the light ground,
 * then the frame, deep violet-black, holding the panel (the notebooks on Home, a notebook's tree
 * inside one) and, inset in it with rounded corners, the white page. Each page draws its own top
 * bar (TopBar.tsx), which brings the panel back when it is hidden.
 *
 * On a wide screen the panel sits beside the page, shown or hidden by choice, remembered. On a
 * narrower one it lies over the page, which dims, and hides again on every new page. On a phone
 * the rail is a bar along the bottom and the panel a drawer from the left edge. The page never
 * scrolls as a whole: each page scrolls inside the white card, so the bars around it stay put.
 * The page reaches the screen's edges (`viewport-fit=cover` in index.html), so the frame keeps
 * clear of a phone's notch and home bar, as an installed app must.
 */
import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { NameDialog } from '../dialogs/NameDialog';
import { NewNotebook } from '../dialogs/NewNotebook';
import { cn } from '../lib/cn';
import { notebookOf, useRoute } from '../router';
import { useApp, useShelf } from '../store';
import { TooltipProvider } from '../ui/Tooltip';
import { HomePanel, NotebookPanel } from './Panels';
import { Rail } from './Rail';

/** What a page's top bar needs from the frame: whether the panel shows, and how to bring it back. */
const FrameContext = createContext({ panelOpen: true, togglePanel: () => {} });

export function useFrame() {
  return useContext(FrameContext);
}

const PANEL_KEY = 'inklog:panel';
/** Below this the panel no longer fits beside the page (Tailwind's `xl`); below PHONE the rail is a bottom bar (`md`). */
export const NARROW = '(max-width: 1279.98px)';
export const PHONE = '(max-width: 767.98px)';

export function Frame({ children }: { children: ReactNode }) {
  const route = useRoute();
  const inNotebook = notebookOf(route) !== undefined;
  const creating = useShelf((state) => state.creating);
  const naming = useApp((state) => state.naming);
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  const [panelOpen, setPanelOpen] = useState(() => !matchMedia(NARROW).matches && localStorage.getItem(PANEL_KEY) !== 'closed');

  useEffect(() => {
    const query = matchMedia(NARROW);
    const changed = () => {
      setNarrow(query.matches);
      setPanelOpen(!query.matches && localStorage.getItem(PANEL_KEY) !== 'closed');
    };
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  // Over the page, the panel has done its job once you have gone somewhere.
  useEffect(() => {
    if (narrow) setPanelOpen(false);
  }, [route, narrow]);

  // A heading chosen in the tree moves the page without changing the address; the panel goes too.
  useEffect(() => {
    const away = () => matchMedia(NARROW).matches && setPanelOpen(false);
    window.addEventListener('inklog:went', away);
    return () => window.removeEventListener('inklog:went', away);
  }, []);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      // Changes save by themselves; stop the browser's own Save dialog.
      if (mod && event.key.toLowerCase() === 's') event.preventDefault();
      // Ctrl+K: search, in the panel.
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPanelOpen(true);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-panel-search]')?.focus());
      }
      if (event.key === 'Escape' && matchMedia(NARROW).matches) setPanelOpen(false);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  const togglePanel = () => {
    const next = !panelOpen;
    setPanelOpen(next);
    if (!narrow) localStorage.setItem(PANEL_KEY, next ? 'open' : 'closed');
  };

  return (
    <FrameContext.Provider value={{ panelOpen, togglePanel }}>
      <TooltipProvider delayDuration={350} skipDelayDuration={200}>
        <div className="flex h-dvh overflow-hidden bg-desk pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] max-md:flex-col-reverse max-md:bg-background md:pb-[env(safe-area-inset-bottom)]">
          <Rail />
          <div className="relative flex min-h-0 min-w-0 flex-1 bg-frame md:my-2 md:mr-2 md:rounded-[26px] md:p-2 md:shadow-[0_24px_60px_-28px_rgb(20_17_27/70%)]">
            <aside
              aria-label={inNotebook ? 'Notebook' : 'Home'}
              inert={!panelOpen}
              className={cn(
                'dark z-30 flex w-[292px] shrink-0 flex-col bg-frame transition-[margin,transform,opacity] duration-200 ease-out',
                // Beside the page on a wide screen; over it on a narrower one.
                'max-xl:absolute max-xl:inset-y-0 max-xl:left-0 max-xl:w-[min(320px,88vw)] max-xl:rounded-r-[26px] max-xl:p-2 max-xl:shadow-[24px_0_60px_-20px_rgb(0_0_0/55%)] md:max-xl:rounded-l-[26px]',
                panelOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none opacity-0 max-xl:-translate-x-full xl:-ml-[292px]',
              )}
            >
              {inNotebook ? <NotebookPanel onHide={togglePanel} /> : <HomePanel onHide={togglePanel} />}
            </aside>
            {narrow && panelOpen && <div className="absolute inset-0 z-20 animate-fade bg-[#14111b]/50 md:rounded-[26px]" aria-hidden="true" onClick={() => setPanelOpen(false)} />}
            <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:rounded-[20px]">{children}</div>
          </div>
          {creating && <NewNotebook onClose={() => useShelf.getState().setCreating(false)} />}
          {naming && <NameDialog request={naming} onClose={() => useApp.getState().setNaming(undefined)} />}
        </div>
      </TooltipProvider>
    </FrameContext.Provider>
  );
}
