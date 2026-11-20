/**
 * The bar across the top of the white page, as in Cloud Dock: what the page is about on the left
 * (each page brings its own: the backups on Home, the open sections' tabs in a notebook), and on
 * the right the bell and you. When the panel is hidden, a button at the bar's start brings it back.
 * Under it a page may put a Band: where you are, and the page's main actions.
 *
 * The bell is "since your last visit" (news.ts): a dot when an AI committed or a change waits for
 * your review, and the list when pressed.
 */
import { Bell as BellIcon, Download, PanelLeft, RefreshCw, SquarePlus } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type ReactNode, useEffect, useState } from 'react';
import { AddToHomeScreen } from '../dialogs/AddToHomeScreen';
import { install, update, useInstall } from '../installable';
import { cn } from '../lib/cn';
import { homeNews, notebookNews } from '../news';
import { navigate, notebookOf, useRoute } from '../router';
import { useApp, useShelf } from '../store';
import { Button } from '../ui/Button';
import { AgentMark, Face, WetDot } from '../ui/Marks';
import { type MenuItem, MenuButton } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { useFrame } from './Frame';

/** A round button in a top bar, as Cloud Dock's. */
export const ROUND_BUTTON =
  'relative grid size-9 shrink-0 place-items-center rounded-full border border-border bg-background text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:border-brand-tint aria-pressed:bg-brand-soft aria-pressed:text-brand touch:size-10';

export function TopBar({ children, end, className }: { children?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <header className={cn('flex h-[60px] shrink-0 items-center gap-3 px-5 max-md:h-14 max-md:px-3', className)}>
      <PanelButton />
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      <div className="flex shrink-0 items-center gap-2">
        {end}
        <UpdateButton />
        <Bell />
        <Account />
      </div>
    </header>
  );
}

/** Brings the panel back when it is hidden; on a narrow screen it opens the panel over the page. */
export function PanelButton({ className }: { className?: string }) {
  const { panelOpen, togglePanel } = useFrame();
  if (panelOpen) return null;
  return (
    <Tooltip label="Show the panel" keys="Ctrl K">
      <button type="button" className={cn(ROUND_BUTTON, className)} aria-label="Show the panel" onClick={togglePanel}>
        <PanelLeft className="size-[17px]" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** The strip under a top bar: where you are on the left, the page's actions on the right. */
export function Band({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-y border-border bg-surface px-5 py-2 max-md:px-3', className)}>{children}</div>;
}

/** What happened while you were away: on Home across every notebook, inside a notebook in it. */
export function Bell() {
  const route = useRoute();
  const notebook = notebookOf(route);
  const cards = useShelf((state) => state.cards);
  const lastVisit = useShelf((state) => state.lastVisit);
  const info = useApp((state) => state.info);
  const open = useApp((state) => state.notebook);
  const before = useApp((state) => state.visitedBefore);
  const [shown, setShown] = useState(false);
  const { items, actions } = notebook ? (info && open === notebook ? notebookNews(info, notebook, before) : { items: [], actions: [] }) : homeNews(cards, lastVisit, Date.now());
  const rings = items.some((item) => item.ring);

  useEffect(() => setShown(false), [route]);

  return (
    <Popover.Root open={shown} onOpenChange={setShown}>
      <Tooltip label="Since your last visit">
        <Popover.Trigger asChild>
          <button type="button" className={ROUND_BUTTON} aria-label={items.length ? `Since your last visit: ${items.length} ${items.length === 1 ? 'thing' : 'things'}` : 'Since your last visit: nothing new'}>
            <BellIcon className="size-[17px]" aria-hidden="true" />
            {rings && <span className="absolute top-[7px] right-[8px] size-2 rounded-full bg-agent-mark ring-2 ring-background" aria-hidden="true" />}
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={8} aria-label="Since your last visit" className="z-[60] w-[340px] max-w-[calc(100vw-16px)] animate-pop rounded-2xl bg-background p-4 shadow-pop outline-none">
          <h2 className="text-[14.5px] font-semibold">Since your last visit</h2>
          {items.length ? (
            <ul className="mt-3 flex flex-col gap-2.5">
              {items.map((item) => (
                <li key={item.key} className="flex gap-2.5 text-[13.5px] leading-snug">
                  <span className="mt-[3px] flex w-3.5 shrink-0 justify-center" aria-hidden="true">
                    {item.agent ? <AgentMark label="" /> : <WetDot className="mt-1" />}
                  </span>
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13.5px] text-muted-foreground">Nothing new. Everything is as you left it.</p>
          )}
          {actions.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {actions.map((action, index) => (
                <Button
                  key={action.label}
                  size="sm"
                  variant={index === 0 ? 'primary' : 'outline'}
                  onClick={() => {
                    setShown(false);
                    navigate(action.to);
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A newer Quillipi is ready (installable.ts). It also comes by itself on the next move out of the
 * notebook; this loads it now, after saving what is open.
 */
export function UpdateButton() {
  const ready = useInstall((state) => state.updateReady);
  const [unsaved, setUnsaved] = useState(false);
  if (!ready) return null;
  return (
    <Tooltip label={unsaved ? 'Your latest words aren’t saved yet. Try again once Quillipi is connected.' : 'A new version of Quillipi is ready. What you have open is saved first.'}>
      <button
        type="button"
        className={cn(ROUND_BUTTON, 'flex w-auto items-center gap-1.5 border-brand-tint bg-brand-soft px-3 text-[13px] font-medium text-brand hover:bg-brand-tint hover:text-brand touch:w-auto max-md:px-2.5')}
        onClick={async () => setUnsaved(!(await update()))}
      >
        <RefreshCw className="size-[15px]" aria-hidden="true" />
        <span className="max-md:sr-only">Update</span>
      </button>
    </Tooltip>
  );
}

/** You: your picture, who you are signed in as, installing the app, and Sign out. */
export function Account() {
  const host = useShelf((state) => state.host);
  const me = useShelf((state) => state.me);
  const person = useApp((state) => state.info?.person.name);
  const offer = useInstall((state) => state.offer);
  const shareMenu = useInstall((state) => state.shareMenu);
  const [explaining, setExplaining] = useState(false);
  const cloud = host === 'cloud';
  const name = me?.login ?? person ?? 'You';
  const installing: MenuItem[] = offer
    ? [{ label: 'Install Quillipi', hint: 'As an app on this device', icon: <Download />, onSelect: () => void install() }]
    : shareMenu
      ? [{ label: 'Add to Home Screen', hint: 'Open Quillipi in one tap', icon: <SquarePlus />, onSelect: () => setExplaining(true) }]
      : [];
  const items: (MenuItem | 'divider')[] = cloud ? [...installing, ...(installing.length ? ['divider' as const] : []), { label: 'Sign out', onSelect: signOut }] : [];
  return (
    <>
      <MenuButton
        label={`You: ${name}`}
        title="You"
        className="shrink-0 rounded-full outline-none transition-shadow hover:shadow-[0_0_0_3px_var(--accent-tint)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        align="end"
        header={
          <>
            <strong className="font-semibold">{me?.name ?? person ?? name}</strong>
            <span className="text-[12.5px] text-[#6c6980]">{cloud ? `Signed in with GitHub as ${name}` : 'Quillipi on this computer'}</span>
          </>
        }
        items={items}
      >
        <Face name={me?.name ?? name} login={cloud ? me?.login : undefined} size={36} className="ring-0" />
      </MenuButton>
      {explaining && <AddToHomeScreen onClose={() => setExplaining(false)} />}
    </>
  );
}

/** Signing out is a form posted from Quillipi itself, so another site can't do it. */
function signOut(): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = '/signout';
  document.body.append(form);
  form.submit();
}
