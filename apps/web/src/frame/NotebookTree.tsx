/**
 * The notebook's tree in the ink panel: its folders and sections, in the order the person set, with
 * the headings of the section open now. Built on the tree component the design chose (tree/AnimatedTree):
 * the accent line runs from the top down to the section you are in, and on to the heading you are
 * reading. Rows carry the same marks as everywhere: a dot for uncommitted work, ✦ for an AI's
 * uncommitted change. Overview, above the tree, is the violet pill while you are on it.
 *
 * Rows can be dragged onto a folder (into it) or above or below another row; every row has a ···
 * menu (also on right-click and the context-menu key) with Move to…, Move up and Move down, so
 * nothing needs a mouse. Search filters the sections by title.
 */
import type { RepoInfo, TreeItem as Item } from '@inklog/core';
import { Ellipsis, FileText, FolderPlus, House, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { href, navigate, notebookOf, useRoute } from '../router';
import { useApp } from '../store';
import { TreeBranch, TreeFolder, TreeItem, TreeSection, TreeView } from '../tree/AnimatedTree';
import { type Drop, type Row, dropOp, findSections, folderOfSection, foldersTo, itemsOf, parentOf } from '../tree/model';
import { cn } from '../lib/cn';
import { ChangeMarks } from '../ui/Marks';
import { type MenuItem, MenuButton, openMenu } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { DashedAdd, PANEL_PILL, PanelSearch } from './Panels';
import { follow } from './Rail';
import { DeleteDialog, MoveDialog } from '../dialogs/TreeDialogs';

const ROW_TYPE = 'application/x-inklog-row';

export function NotebookTree() {
  const route = useRoute();
  const info = useApp((state) => state.info);
  const expanded = useApp((state) => state.expanded);
  const outline = useApp((state) => state.outline);
  const reading = useApp((state) => state.reading);
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState<Row>();
  const [deleting, setDeleting] = useState<Row>();
  const [error, setError] = useState<string>();
  const id = notebookOf(route)!;
  const active = route.page === 'section' ? route.section : undefined;

  // The folders leading to the section you are in open by themselves.
  useEffect(() => {
    if (!active || !info) return;
    const folder = folderOfSection(info.tree, active);
    if (folder) for (const path of foldersTo(folder)) if (!useApp.getState().expanded.includes(path)) useApp.getState().setExpanded(path, true);
  }, [active, info?.tree]);

  const marks = useMemo(() => {
    const found = new Map<string, { count: number; agent: boolean }>();
    for (const change of info?.pending ?? []) {
      if (!change.section) continue;
      const mark = found.get(change.section) ?? { count: 0, agent: false };
      found.set(change.section, { count: mark.count + 1, agent: mark.agent || change.by.includes('agent') });
    }
    return found;
  }, [info?.pending]);

  if (!info) return null;
  const titles = new Map(info.sections.map((section) => [section.id, section.title]));
  const selected = active ? (reading && outline?.section === active ? `h:${reading}` : active) : null;

  const organize = (op: object | undefined) => {
    if (!op) return;
    setError(undefined);
    api.organize([op]).catch((failure: Error) => setError(failure.message));
  };

  const menuFor = (row: Row): (MenuItem | 'divider')[] => {
    const folder = row.kind === 'folder' ? row.path : undefined;
    const siblings = itemsOf(info.tree, row.kind === 'folder' ? parentOf(row.path) : (folderOfSection(info.tree, row.id) ?? '')) ?? [];
    const at = siblings.findIndex((item) => (typeof item === 'string' ? row.kind === 'section' && item === row.id : row.kind === 'folder' && join(parentOf(row.path), item.folder) === row.path));
    const neighbour = (offset: number): Row | undefined => {
      const item = siblings[at + offset];
      if (item === undefined) return undefined;
      return typeof item === 'string' ? { kind: 'section', id: item } : { kind: 'folder', path: join(row.kind === 'folder' ? parentOf(row.path) : (folderOfSection(info.tree, row.id) ?? ''), item.folder) };
    };
    const up = neighbour(-1);
    const down = neighbour(1);
    return [
      ...(folder !== undefined
        ? [
            { label: 'New section here', onSelect: () => useApp.getState().setNaming({ kind: 'section', folder }) },
            { label: 'New folder here', onSelect: () => useApp.getState().setNaming({ kind: 'folder', folder }) },
            { label: 'Open folder page', onSelect: () => navigate({ page: 'notebook', id, folder }) },
            { label: 'Rename…', onSelect: () => useApp.getState().setNaming({ kind: 'rename', folder, name: folderName(info.tree, folder) }) },
          ]
        : []),
      { label: 'Move to…', onSelect: () => setMoving(row) },
      { label: 'Move up', disabled: !up, onSelect: () => organize(up && dropOp(info.tree, row, up, 'before')) },
      { label: 'Move down', disabled: !down, onSelect: () => organize(down && dropOp(info.tree, row, down, 'after')) },
      'divider',
      { label: 'Delete…', danger: true, onSelect: () => setDeleting(row) },
    ];
  };

  const rows = (items: readonly Item[], folder: string): ReactNode[] =>
    items.map((item) => {
      if (typeof item === 'string') return <SectionRow key={item} id={item} notebook={id} title={titles.get(item) ?? item} mark={marks.get(item)} headings={active === item && outline?.section === item ? outline.headings : []} menu={menuFor({ kind: 'section', id: item })} onDrop={organize} tree={info.tree} />;
      const path = join(folder, item.folder);
      const row: Row = { kind: 'folder', path };
      const open = expanded.includes(path);
      return (
        <TreeFolder
          key={`folder:${path}`}
          id={`folder:${path}`}
          label={item.name}
          expanded={open}
          onExpandedChange={(next) => useApp.getState().setExpanded(path, next)}
          end={<FolderMarks info={info} path={path} />}
          actions={<RowMenu label={`More for the folder ${item.name}`} items={menuFor(row)} folder />}
          rowProps={dragProps(row, info.tree, organize, true)}
        >
          {item.items.length ? rows(item.items, path) : [<TreeItem key="empty" id={`empty:${path}`} label="Empty folder" disabled />]}
        </TreeFolder>
      );
    });

  const found = findSections(info.sections, query);
  const searching = query.trim() !== '';
  const onOverview = route.page === 'notebook' && !route.folder;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-notebook-tree>
      <PanelSearch
        value={query}
        onChange={setQuery}
        placeholder="Find a section"
        label="Find a section by its title"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && found[0]) {
            navigate({ page: 'section', id, section: found[0].id });
            setQuery('');
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            document.querySelector<HTMLElement>('[data-notebook-tree] [role=treeitem]')?.focus();
          }
        }}
      />
      {error && (
        <p className="mx-1 mt-2 rounded-lg bg-removed/15 px-2.5 py-1.5 text-[12.5px] text-[#ff9aa0]" role="alert">
          {error}
        </p>
      )}
      <div className="scroll-quiet -mx-1 min-h-0 flex-1 overflow-y-auto px-1 pt-3 pb-2">
        {!searching && (
          <a className={cn(PANEL_PILL, 'mb-3')} href={href({ page: 'notebook', id, folder: '' })} aria-current={onOverview ? 'page' : undefined} onClick={follow}>
            <House className="size-[18px]" strokeWidth={1.9} aria-hidden="true" />
            Overview
          </a>
        )}
        <TreeView selectedId={selected ?? undefined} activeColor="text-[#a48fff]" aria-label="Sections and folders" className="px-0">
          {searching ? (
            found.length ? (
              found.map((section) => (
                <TreeItem
                  key={section.id}
                  id={section.id}
                  label={section.title}
                  icon={FileText}
                  end={section.folder ? <span className="truncate text-[12px] font-normal text-muted-foreground/70">{folderName(info.tree, section.folder)}</span> : undefined}
                  onClick={() => {
                    navigate({ page: 'section', id, section: section.id });
                    setQuery('');
                  }}
                />
              ))
            ) : (
              <p className="px-2.5 py-2 text-[13px] text-muted-foreground">No section is called “{query.trim()}”.</p>
            )
          ) : (
            <TreeSection
              title="Sections"
              actions={
                <>
                  <Tooltip label="New folder">
                    <button type="button" className={HEAD_BUTTON} aria-label="New folder" onClick={() => useApp.getState().setNaming({ kind: 'folder', folder: '' })}>
                      <FolderPlus className="size-4" aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip label="New section">
                    <button type="button" className={HEAD_BUTTON} aria-label="New section" onClick={() => useApp.getState().setNaming({ kind: 'section', folder: '' })}>
                      <Plus className="size-4" aria-hidden="true" />
                    </button>
                  </Tooltip>
                </>
              }
            >
              {info.tree.length ? rows(info.tree, '') : [<TreeItem key="empty" id="empty:" label="No sections yet" disabled />]}
            </TreeSection>
          )}
        </TreeView>
        {!searching && <DashedAdd onClick={() => useApp.getState().setNaming({ kind: 'section', folder: '' })}>New section</DashedAdd>}
      </div>
      {moving && <MoveDialog row={moving} onClose={() => setMoving(undefined)} />}
      {deleting && <DeleteDialog row={deleting} onClose={() => setDeleting(undefined)} />}
    </div>
  );
}

const HEAD_BUTTON = 'grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring touch:size-10';

function SectionRow({ id, notebook, title, mark, headings, menu, onDrop, tree }: {
  id: string;
  notebook: string;
  title: string;
  mark?: { count: number; agent: boolean };
  headings: { id: string; text: string }[];
  menu: (MenuItem | 'divider')[];
  onDrop(op: object | undefined): void;
  tree: readonly Item[];
}) {
  return (
    <TreeBranch
      id={id}
      label={title}
      icon={FileText}
      expanded={headings.length > 0}
      end={<Marks mark={mark} />}
      actions={<RowMenu label={`More for ${title}`} items={menu} />}
      rowProps={dragProps({ kind: 'section', id }, tree, onDrop, false)}
      onPress={() => navigate({ page: 'section', id: notebook, section: id })}
    >
      {headings.map((heading) => (
        <TreeItem key={heading.id} id={`h:${heading.id}`} label={heading.text} onClick={() => goToHeading(heading.id)} />
      ))}
    </TreeBranch>
  );
}

function Marks({ mark }: { mark?: { count: number; agent: boolean } }) {
  return mark ? <ChangeMarks count={mark.count} agent={mark.agent} /> : null;
}

/** A folder shows • when anything inside it is uncommitted, so closed folders don't hide work. */
function FolderMarks({ info, path }: { info: RepoInfo; path: string }) {
  const inside = new Set(info.sections.filter((section) => section.folder === path || section.folder.startsWith(`${path}/`)).map((section) => section.id));
  const pending = info.pending.filter((change) => inside.has(change.section));
  if (!pending.length) return null;
  return <Marks mark={{ count: pending.length, agent: pending.some((change) => change.by.includes('agent')) }} />;
}

/** The ··· menu beside a row, shown when the row is pointed at or focused. A right-click or the context-menu key on the row opens it too. */
function RowMenu({ label, items, folder = false }: { label: string; items: (MenuItem | 'divider')[]; folder?: boolean }) {
  return (
    <MenuButton
      label={label}
      items={items}
      align="start"
      side="right"
      className={cn(
        'absolute top-1/2 z-20 grid size-6 -translate-y-1/2 place-items-center rounded-md bg-[#2b2540] text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 aria-expanded:opacity-100 touch:size-10 touch:bg-transparent touch:opacity-100',
        folder ? 'right-7 touch:right-8' : 'right-1',
      )}
    >
      <Ellipsis className="size-4" aria-hidden="true" />
    </MenuButton>
  );
}

/** Drag and drop on a row: where in the row the pointer is says before, after or (on a folder) inside. */
function dragProps(row: Row, tree: readonly Item[], onDrop: (op: object | undefined) => void, folder: boolean) {
  const where = (event: React.DragEvent<HTMLElement>): Drop => {
    const box = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - box.top) / box.height;
    if (folder) return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
    return y < 0.5 ? 'before' : 'after';
  };
  const clear = (element: HTMLElement) => delete element.dataset.drop;
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLButtonElement>) => {
      event.dataTransfer.setData(ROW_TYPE, JSON.stringify(row));
      event.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (event: React.DragEvent<HTMLButtonElement>) => {
      if (!event.dataTransfer.types.includes(ROW_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      event.currentTarget.dataset.drop = where(event);
    },
    onDragLeave: (event: React.DragEvent<HTMLButtonElement>) => clear(event.currentTarget),
    onDrop: (event: React.DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const drop = where(event);
      clear(event.currentTarget);
      const dragged = JSON.parse(event.dataTransfer.getData(ROW_TYPE) || 'null') as Row | null;
      if (dragged) onDrop(dropOp(tree, dragged, row, drop));
    },
    onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      openMenu(event.currentTarget.parentElement?.querySelector('[aria-haspopup=menu]'));
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        openMenu(event.currentTarget.parentElement?.querySelector('[aria-haspopup=menu]'));
      }
    },
  };
}


/** Scrolls the open section to one of its headings. */
export function goToHeading(id: string): void {
  const element = document.querySelector<HTMLElement>(`.document [data-block-id="${CSS.escape(id)}"]`);
  const scroller = element?.closest<HTMLElement>('.editor-main');
  if (!element || !scroller) return;
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  // The page's own scroller only: scrollIntoView would also shift everything around it.
  scroller.scrollTo({ top: scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16, behavior });
  useApp.getState().setReading(id);
  window.dispatchEvent(new Event('inklog:went'));
}

function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function folderName(tree: readonly Item[], path: string): string {
  const [first, ...rest] = path.split('/');
  const found = tree.find((item) => typeof item !== 'string' && item.folder === first);
  if (!found || typeof found === 'string') return path;
  return rest.length ? folderName(found.items, rest.join('/')) : found.name;
}
