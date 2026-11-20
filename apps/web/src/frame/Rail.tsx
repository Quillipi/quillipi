/**
 * The rail, as in Cloud Dock: Quillipi's drop, then the places that span every notebook as white
 * tiles; the one you are on is a dark tile with a violet marker at the rail's edge. A place appears
 * only when its page exists (Inbox and Settings come later), and the laptop program, which serves
 * one notebook, has only the notebook's own. A tile's tooltip names it. On a phone the same places
 * are a bar along the bottom, named under their icons.
 */
import { Bot, FilePlus2, FolderPlus, House, type LucideIcon, NotebookPen, NotebookText, Plus } from 'lucide-react';
import { cn } from '../lib/cn';
import { href, navigate, notebookOf, useRoute } from '../router';
import { lastNotebook, useApp, useShelf } from '../store';
import { type MenuItem, MenuButton } from '../ui/Menu';
import { Drop } from '../ui/NotebookTile';
import { Tooltip } from '../ui/Tooltip';

const TILE =
  'relative grid size-11 place-items-center rounded-[14px] bg-white text-[#5f5c73] shadow-tile ring-1 ring-black/[0.03] outline-none transition-[background-color,color,transform,box-shadow] duration-150 hover:-translate-y-px hover:text-[#1b1826] focus-visible:ring-2 focus-visible:ring-ring max-md:size-auto max-md:w-full max-md:flex-col max-md:gap-0.5 max-md:rounded-xl max-md:bg-transparent max-md:py-1.5 max-md:shadow-none max-md:ring-0 max-md:hover:translate-y-0';
const TILE_CURRENT =
  'bg-[#17141f] text-white shadow-[0_8px_18px_-8px_rgb(23_20_31/70%)] hover:text-white max-md:bg-transparent max-md:text-brand max-md:shadow-none max-md:hover:text-brand';

export function Rail() {
  const route = useRoute();
  const host = useShelf((state) => state.host);
  const current = notebookOf(route);
  const notebook = current ?? lastNotebook();
  const cloud = host === 'cloud';
  const start = cloud ? '/' : notebook ? href({ page: 'notebook', id: notebook, folder: '' }) : '/';

  return (
    <nav aria-label="Places" className="flex shrink-0 items-center gap-2.5 max-md:h-[calc(4rem+env(safe-area-inset-bottom))] max-md:justify-around max-md:gap-1 max-md:border-t max-md:border-black/5 max-md:bg-white max-md:px-2 max-md:pb-[env(safe-area-inset-bottom)] md:w-[68px] md:flex-col md:py-4">
      <a href={start} aria-label="Quillipi" onClick={follow} className="grid size-11 place-items-center rounded-[14px] outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring max-md:hidden">
        <Drop size={30} />
      </a>
      <span className="my-0.5 h-px w-6 bg-linear-to-r from-transparent via-brand/45 to-transparent max-md:hidden" aria-hidden="true" />
      {cloud && <Place icon={House} label="Home" to="/" current={route.page === 'home'} />}
      {notebook && <Place icon={NotebookText} label="Notebook" to={href({ page: 'notebook', id: notebook, folder: '' })} current={current !== undefined} />}
      {cloud && <Place icon={Bot} label="Agents" to="/agents" current={route.page === 'agents'} />}
      <NewMenu folder={route.page === 'notebook' ? route.folder : ''} inNotebook={current !== undefined} />
    </nav>
  );
}

function Place({ icon: Shape, label, to, current }: { icon: LucideIcon; label: string; to: string; current: boolean }) {
  return (
    <Tooltip label={label} side="right">
      <a href={to} aria-current={current ? 'page' : undefined} aria-label={label} onClick={follow} className={cn(TILE, current && TILE_CURRENT)}>
        {current && <span className="absolute top-1/2 -left-3 h-6 w-1 -translate-y-1/2 rounded-r-full bg-brand max-md:hidden" aria-hidden="true" />}
        <Shape className="size-5" strokeWidth={1.85} aria-hidden="true" />
        <span className="text-[11px] leading-none font-medium md:hidden">{label}</span>
      </a>
    </Tooltip>
  );
}

/** + New: a notebook (in the cloud), or a section or folder in the notebook that is open. */
function NewMenu({ folder, inNotebook }: { folder: string; inNotebook: boolean }) {
  const cloud = useShelf((state) => state.host) === 'cloud';
  const items: MenuItem[] = [];
  if (cloud) items.push({ label: 'New notebook', hint: 'With its own GitHub repo', icon: <NotebookPen />, onSelect: () => useShelf.getState().setCreating(true) });
  if (inNotebook) {
    items.push({ label: 'New section', hint: folder ? 'In this folder' : 'In this notebook', icon: <FilePlus2 />, onSelect: () => useApp.getState().setNaming({ kind: 'section', folder }) });
    items.push({ label: 'New folder', hint: folder ? 'In this folder' : 'In this notebook', icon: <FolderPlus />, onSelect: () => useApp.getState().setNaming({ kind: 'folder', folder }) });
  }
  if (!items.length) return null;
  return (
    <MenuButton label="New" className={TILE} side="right" items={items}>
      <Plus className="size-5" strokeWidth={1.85} aria-hidden="true" />
      <span className="text-[11px] leading-none font-medium md:hidden">New</span>
    </MenuButton>
  );
}

/** A link inside the app opens without reloading; a middle-click or Ctrl-click still opens a new tab. */
export function follow(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute('href') ?? '/');
}
