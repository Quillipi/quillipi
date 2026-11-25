/**
 * A notebook's overview, like a repository's page on GitHub: a row that says where you are (the
 * notebook, then the folders) and holds AI instructions, New, more and Continue; under it the
 * notebook's tile, title and line (both editable in place) and its facts; a bar with the latest
 * commit, uncommitted work and the backup, which opens the History panel; the folders and sections
 * at this level, each with the last commit that changed it; and the notebook's About section, shown
 * like a README. A folder opens the same page for that folder. What AI did since your last visit
 * is in the bell.
 */
import { type CommitSummary, NOTEBOOK_COLOURS, type NotebookOverview, type RepoInfo, type SectionData, type TreeItem, folderItems } from '@inklog/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { Archive, ArrowRight, Check, ChevronDown, ChevronRight, Copy, Ellipsis, ExternalLink, FilePlus2, FileText, Folder, FolderPlus, Palette, PencilLine, Plus, Sparkles } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Notice } from '../App';
import { api } from '../api';
import { Instructions } from '../dialogs/Instructions';
import { blocksToDoc } from '../editor/convert';
import { editorExtensions } from '../editor/schema';
import { follow } from '../frame/Rail';
import { cn } from '../lib/cn';
import { useLive } from '../live-context';
import { madeByAgent, plural } from '../news';
import { href } from '../router';
import { useApp, useShelf } from '../store';
import { Button, ButtonLink, buttonStyles } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { AgentMark, Ago, BackupLine, Face, Pill, WetDot, Who } from '../ui/Marks';
import { MenuButton } from '../ui/Menu';
import { NotebookTile } from '../ui/NotebookTile';

/** The section shown like a README: About in notebooks made in the cloud, Overview in older ones. */
const README_IDS = ['about', 'overview'];

export function Overview({ folder }: { folder: string }) {
  const info = useApp((state) => state.info)!;
  const notebook = useApp((state) => state.notebook)!;
  const card = useShelf((state) => state.cards.find((candidate) => candidate.id === notebook));
  const me = useShelf((state) => state.me);
  const cloud = useShelf((state) => state.host) === 'cloud';
  const [overview, setOverview] = useState<NotebookOverview>();
  const [renaming, setRenaming] = useState(false);
  const [colouring, setColouring] = useState(false);
  const [instructing, setInstructing] = useState(false);
  const head = info.commits[0]?.oid;

  // The last commit for each section, again after every commit.
  useEffect(() => {
    let current = true;
    void api.overview().then((loaded) => current && setOverview(loaded));
    return () => {
      current = false;
    };
  }, [head]);

  const items = folder ? folderItems(info.tree, folder) : info.tree;
  if (!items) {
    return (
      <Notice title={`No folder “${folder}”`}>
        <p>
          <a href={href({ page: 'notebook', id: notebook, folder: '' })} onClick={follow}>
            Back to {info.name}
          </a>
        </p>
      </Notice>
    );
  }

  const colour = info.colour ?? card?.colour ?? '#7350f2';
  const first = info.commits[info.commits.length - 1];
  const continueTo = card?.summary?.recent[0]?.id ?? useApp.getState().active ?? info.sections[0]?.id;
  const folders = countFolders(info.tree);
  const newItems = [
    { label: 'New section', icon: <FilePlus2 />, onSelect: () => useApp.getState().setNaming({ kind: 'section', folder }) },
    { label: 'New folder', icon: <FolderPlus />, onSelect: () => useApp.getState().setNaming({ kind: 'folder', folder }) },
  ];
  const moreItems = [
    { label: 'Rename…', icon: <PencilLine />, onSelect: () => setRenaming(true) },
    { label: 'Colour…', icon: <Palette />, onSelect: () => setColouring(true) },
    ...(cloud && me ? [{ label: 'View on GitHub', icon: <ExternalLink />, onSelect: () => window.open(`https://github.com/${me.github}/${notebook}`, '_blank', 'noopener') }] : []),
    ...(cloud && card
      ? [
          {
            label: card.archived ? 'Unarchive' : 'Archive',
            icon: <Archive />,
            hint: card.archived ? undefined : 'Hidden from Home and from Claude’s list',
            onSelect: () => void api.archive(notebook, !card.archived).then((next) => useShelf.getState().putCard(next)),
          },
        ]
      : []),
  ];

  return (
    <main className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-2 max-md:px-3">
        <Crumbs tree={info.tree} folder={folder} notebook={notebook} name={info.name} />
        <span className="flex-1" />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setInstructing(true)} title="How every AI should work in this notebook">
            <Sparkles className="size-4" aria-hidden="true" />
            <span className="@max-xl:sr-only">AI instructions</span>
          </Button>
          <MenuButton label="New section or folder" className={buttonStyles({ variant: 'outline' })} items={newItems} align="end">
            <Plus className="size-4" aria-hidden="true" /> New <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
          </MenuButton>
          <MenuButton label="More for this notebook" className={buttonStyles({ variant: 'outline', size: 'icon' })} items={moreItems} align="end">
            <Ellipsis className="size-4" aria-hidden="true" />
          </MenuButton>
          {continueTo && (
            <ButtonLink variant="primary" className="max-w-[260px]" href={href({ page: 'section', id: notebook, section: continueTo })} onClick={follow}>
              <span className="truncate">
                Continue<span className="@max-3xl:hidden">: {info.sections.find((section) => section.id === continueTo)?.title ?? continueTo}</span>
              </span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </ButtonLink>
          )}
        </div>
      </div>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1060px] flex-col gap-7 px-6 py-8 max-md:px-4 max-md:py-5">
          <header className="flex items-start gap-5 max-md:gap-3.5">
            <NotebookTile colour={colour} size={64} className="max-md:hidden" />
            <NotebookTile colour={colour} size={44} className="md:hidden" />
            <div className="min-w-0 flex-1">
              <EditableLine
                key={`name:${info.name}`}
                value={info.name}
                label="Title"
                editing={renaming}
                onEditing={setRenaming}
                className="text-[26px] leading-tight font-semibold tracking-[-0.025em] max-md:text-[21px]"
                save={(name) => api.setDetails({ name })}
                as="h1"
              />
              <EditableLine key={`about:${info.about ?? ''}`} value={info.about ?? ''} label="What it is for" placeholder="Add a description" className="mt-0.5 text-[15px] text-muted-foreground" save={(about) => api.setDetails({ about })} as="p" />
              <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground [&>span+span]:before:mr-2 [&>span+span]:before:text-faint [&>span+span]:before:content-['·']">
                <span>{plural(info.sections.length, 'section')}</span>
                <span>{plural(folders, 'folder')}</span>
                <span>{plural(info.commits.length, 'commit')}</span>
                {first && (
                  <span>
                    since {new Date(first.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} by{' '}
                    {card?.createdBy && card.createdBy !== info.person.name ? <Who name={card.createdBy} agent={madeByAgent(card, info.person.name)} /> : 'you'}
                  </span>
                )}
                {card?.archived && <Pill>Archived</Pill>}
              </p>
            </div>
          </header>

          <section aria-label={folder ? 'In this folder' : 'In this notebook'} className="overflow-hidden rounded-2xl border border-border">
            <StatusBar info={info} />
            <Contents items={items} folder={folder} info={info} overview={overview} notebook={notebook} colour={colour} />
          </section>

          {!folder && info.sections.length <= 1 && info.commits.length <= 1 && <HowToStart notebook={notebook} />}
          {!folder && <Readme info={info} notebook={notebook} />}
        </div>
      </div>

      {instructing && <Instructions scope="notebook" onClose={() => setInstructing(false)} />}
      {colouring && (
        <Dialog title="Colour" description="The notebook's colour is kept in the notebook itself, so everyone sees the same. Changing it is a commit." onClose={() => setColouring(false)}>
          <div className="flex flex-wrap gap-2.5 pt-1">
            {NOTEBOOK_COLOURS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={`Colour ${option}`}
                aria-pressed={option === info.colour}
                className="grid size-10 place-items-center rounded-full outline-none ring-offset-2 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
                style={{ background: option }}
                onClick={() => {
                  setColouring(false);
                  void api.setDetails({ colour: option });
                }}
              >
                {option === info.colour && <Check className="size-4 text-white" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </main>
  );
}

/** A line that becomes a text box when clicked, saved with Enter or by leaving it, cancelled with Escape. */
function EditableLine({
  value,
  label,
  placeholder,
  save,
  as: Tag,
  className = '',
  editing: editingProp,
  onEditing,
}: {
  value: string;
  label: string;
  placeholder?: string;
  save(value: string): Promise<unknown>;
  as: 'h1' | 'p';
  className?: string;
  editing?: boolean;
  onEditing?(editing: boolean): void;
}) {
  const [own, setOwn] = useState(false);
  const editing = editingProp ?? own;
  const setEditing = onEditing ?? setOwn;
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  const done = useRef(false);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      done.current = false;
    }
  }, [editing, value]);

  const finish = async (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    if (!keep || draft.trim() === value.trim()) return;
    try {
      await save(draft);
      setError(undefined);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  if (editing) {
    return (
      <Tag className={className}>
        <input
          autoFocus
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void finish(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void finish(true);
            if (event.key === 'Escape') void finish(false);
          }}
          className="-mx-2 w-[calc(100%+16px)] rounded-lg border border-brand bg-background px-2 py-0.5 text-foreground outline-none ring-[3px] ring-brand/15 [font:inherit] [letter-spacing:inherit]"
        />
      </Tag>
    );
  }
  return (
    <Tag className={className}>
      <button
        type="button"
        title={`Edit ${label.toLowerCase()}`}
        onClick={() => setEditing(true)}
        className={cn(
          '-mx-2 max-w-full rounded-lg px-2 py-0.5 text-left outline-none transition-colors [font:inherit] [letter-spacing:inherit] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
          !value && 'text-faint underline decoration-dotted underline-offset-4',
        )}
      >
        {value || `+ ${placeholder}`}
      </button>
      {error && (
        <span className="ml-2 text-[13px] font-normal tracking-normal text-removed" role="alert">
          {error}
        </span>
      )}
    </Tag>
  );
}

/** Like GitHub's latest-commit bar: the last commit on the left; uncommitted work, changes waiting and the backup on the right. It opens the History panel. */
function StatusBar({ info }: { info: RepoInfo }) {
  const latest = info.commits[0];
  const uncommitted = info.pending.length;
  return (
    <button
      type="button"
      aria-label="Latest commit and uncommitted work: open History"
      onClick={() => useApp.getState().setHistoryOpen(true)}
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-surface px-4 py-2.5 text-left text-[13px] outline-none transition-colors hover:bg-[#f1eff7] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="flex min-w-0 flex-[1_1_20rem] items-center gap-2">
        {latest ? (
          <>
            <Face name={latest.agent ?? info.person.name} agent={Boolean(latest.agent)} size={22} className="ring-0" />
            <span className={cn('max-w-[40%] shrink-0 truncate font-medium', latest.agent && 'text-agent')}>{latest.agent ?? (latest.author === info.person.name ? 'You' : latest.author)}</span>
            <span className="min-w-0 truncate text-muted-foreground">{latest.message}</span>
            <span className="shrink-0 font-mono text-[12px] text-faint">#{latest.number}</span>
            <span className="shrink-0 text-faint max-sm:hidden">
              · <Ago at={latest.at} />
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">No commits yet.</span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {uncommitted ? (
          <Pill tone="wet">
            <WetDot /> {uncommitted} uncommitted
          </Pill>
        ) : (
          <Pill>Everything is committed</Pill>
        )}
        {info.held.length > 0 && (
          <Pill tone="agent">
            <AgentMark label="" className="text-[10px]" /> {info.held.length} {info.held.length === 1 ? 'waits' : 'wait'} for you
          </Pill>
        )}
        {info.backup && <BackupLine backup={info.backup} className="@max-4xl:hidden" />}
      </span>
    </button>
  );
}

/** Where you are: the notebook, then the folders down to this one. */
function Crumbs({ tree, folder, notebook, name }: { tree: TreeItem[]; folder: string; notebook: string; name: string }) {
  const parts = folder ? folder.split('/') : [];
  const link = 'rounded-md px-1 py-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';
  const here = 'truncate px-1 font-medium text-foreground';
  return (
    <nav className="flex min-w-0 items-center gap-0.5 text-[14px]" aria-label="Where you are">
      {parts.length ? (
        <a className={link} href={href({ page: 'notebook', id: notebook, folder: '' })} onClick={follow}>
          {name}
        </a>
      ) : (
        <span className={here} aria-current="page">
          {name}
        </span>
      )}
      {parts.map((_, index) => {
        const path = parts.slice(0, index + 1).join('/');
        const label = folderLabel(tree, path);
        return (
          <Fragment key={path}>
            <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
            {index === parts.length - 1 ? (
              <span className={here} aria-current="page">
                {label}
              </span>
            ) : (
              <a className={link} href={href({ page: 'notebook', id: notebook, folder: path })} onClick={follow}>
                {label}
              </a>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/**
 * What is at this level, like a repository's file list on GitHub: folders first, then sections,
 * each with the last commit that changed it (for a folder, the newest among the sections inside),
 * who made it and when.
 */
function Contents({ items, folder, info, overview, notebook, colour }: { items: TreeItem[]; folder: string; info: RepoInfo; overview?: NotebookOverview; notebook: string; colour: string }) {
  const titles = new Map(info.sections.map((section) => [section.id, section.title]));
  const counts = new Map<string, number>();
  for (const change of info.pending) counts.set(change.section, (counts.get(change.section) ?? 0) + 1);
  const folders = items.filter((item) => typeof item !== 'string');
  const sections = items.filter((item) => typeof item === 'string');

  if (!items.length) return <p className="px-4 py-10 text-center text-[14px] text-muted-foreground">{folder ? 'This folder is empty. Use New to add a section here.' : 'This notebook has no sections yet.'}</p>;

  const inside = (path: string) => info.sections.filter((section) => section.folder === path || section.folder.startsWith(`${path}/`));
  const lastIn = (path: string): CommitSummary | undefined =>
    inside(path)
      .map((section) => overview?.last[section.id])
      .filter((commit): commit is CommitSummary => commit !== undefined)
      .sort((a, b) => b.at - a.at)[0];
  const wetIn = (path: string) => inside(path).filter((section) => counts.get(section.id)).length;

  return (
    <table className="w-full table-fixed border-collapse text-[13.5px]">
      <thead className="sr-only">
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Last commit</th>
          <th scope="col">By</th>
          <th scope="col">When</th>
        </tr>
      </thead>
      <tbody>
        {folders.map((item) => {
          const path = folder ? `${folder}/${item.folder}` : item.folder;
          const wet = wetIn(path);
          return (
            <Row
              key={`folder:${path}`}
              to={href({ page: 'notebook', id: notebook, folder: path })}
              icon={
                <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-brand-soft text-brand">
                  <Folder className="size-[18px]" fill="currentColor" fillOpacity={0.18} aria-hidden="true" />
                </span>
              }
              title={item.name}
              sub={
                <>
                  {plural(item.items.length, 'item')}
                  {wet > 0 && (
                    <span className="ml-2 inline-flex items-center gap-1 text-brand">
                      <WetDot /> {wet}
                      <span className="@max-2xl:sr-only">uncommitted</span>
                    </span>
                  )}
                </>
              }
              last={lastIn(path)}
              none={item.items.length ? 'Not committed yet' : 'Empty'}
              info={info}
            />
          );
        })}
        {sections.map((id) => {
          const wet = counts.get(id);
          return (
            <Row
              key={id}
              to={href({ page: 'section', id: notebook, section: id })}
              icon={
                <span className="grid size-9 shrink-0 place-items-center rounded-[11px] border border-border bg-background shadow-[0_1px_2px_rgb(27_24_38/5%)]" style={{ color: colour }}>
                  <FileText className="size-[18px]" aria-hidden="true" />
                </span>
              }
              title={titles.get(id) ?? id}
              sub={
                wet ? (
                  <span className="inline-flex items-center gap-1 text-brand">
                    <WetDot /> {wet} uncommitted
                  </span>
                ) : (
                  'Section'
                )
              }
              last={overview?.last[id]}
              none={overview ? 'Not committed yet' : ''}
              info={info}
            />
          );
        })}
      </tbody>
    </table>
  );
}

/** One row of the contents: the whole row leads where its name does. */
function Row({ to, icon, title, sub, last, none, info }: { to: string; icon: ReactNode; title: string; sub: ReactNode; last?: CommitSummary; none: string; info: RepoInfo }) {
  const who = last ? (last.agent ?? (last.author === info.person.name ? 'You' : last.author)) : '';
  return (
    <tr className="group relative border-b border-border transition-colors last:border-b-0 hover:bg-surface">
      <td className="w-[36%] py-2.5 pr-3 pl-4 @max-2xl:w-auto">
        <span className="flex items-center gap-3">
          {icon}
          <span className="flex min-w-0 flex-col">
            <a className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset" href={to} onClick={follow}>
              {title}
            </a>
            <span className="truncate text-[12.5px] text-muted-foreground">{sub}</span>
          </span>
        </span>
      </td>
      <td className="truncate py-2.5 pr-3 text-muted-foreground @max-2xl:hidden" title={last?.message}>
        {last ? (
          <>
            <span className="mr-1.5 font-mono text-[12px] text-faint">#{last.number}</span>
            {last.message}
          </>
        ) : (
          <span className="text-faint">{none}</span>
        )}
      </td>
      <td className="w-[200px] py-2.5 pr-3 @max-4xl:hidden">
        {last && (
          <span className={cn('flex items-center gap-2', last.agent && 'text-agent')}>
            <Face name={who} agent={Boolean(last.agent)} size={22} className="ring-0" />
            <span className="truncate">{who}</span>
          </span>
        )}
      </td>
      <td className="w-[92px] py-2.5 pr-4 text-right text-[12.5px] whitespace-nowrap text-muted-foreground">{last && <Ago at={last.at} />}</td>
    </tr>
  );
}

/** A new, empty notebook teaches the main loop: write here, or ask Claude from any chat. */
function HowToStart({ notebook }: { notebook: string }) {
  return (
    <section aria-label="How to start" className="rounded-2xl border border-dashed border-input bg-surface p-5">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">How to start</h2>
      <p className="mt-1 text-[14px] text-muted-foreground">Write here, or ask Claude in any chat with Quillipi connected.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => useApp.getState().setNaming({ kind: 'section', folder: '' })}>
          <Plus className="size-4" aria-hidden="true" /> New section
        </Button>
        <Button onClick={() => useApp.getState().setNaming({ kind: 'folder', folder: '' })}>
          <FolderPlus className="size-4" aria-hidden="true" /> New folder
        </Button>
      </div>
      <CopyLine text={`Write a plan in Quillipi notebook ${notebook}`} className="mt-4" />
    </section>
  );
}

/** A line to copy, such as what to say to Claude. */
export function CopyLine({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn('flex items-center gap-2 rounded-xl border border-border bg-background py-1.5 pr-1.5 pl-3.5', className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{text}</code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check className="size-3.5 text-added" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** The notebook's About section, shown like a README, kept current as anyone edits it. */
function Readme({ info, notebook }: { info: RepoInfo; notebook: string }) {
  const id = README_IDS.find((candidate) => info.sections.some((section) => section.id === candidate));
  const live = useLive();
  const [data, setData] = useState<SectionData>();

  useEffect(() => {
    if (!id) return;
    let current = true;
    void api.section(id).then((loaded) => current && setData(loaded));
    const stop = live.subscribe((event) => {
      if (event.type === 'section' && event.section === id) setData((before) => before && { ...before, version: event.version, blocks: event.blocks });
    });
    return () => {
      current = false;
      stop();
    };
  }, [id, live]);

  if (!id || !data) return null;
  const title = info.sections.find((section) => section.id === id)?.title;
  return (
    <section aria-label={title} className="overflow-hidden rounded-2xl border border-border">
      <header className="flex items-center gap-2 border-b border-border bg-surface py-1.5 pr-1.5 pl-4 text-[13.5px] font-medium">
        <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ButtonLink size="sm" variant="ghost" href={href({ page: 'section', id: notebook, section: id })} onClick={follow}>
          <PencilLine className="size-3.5" aria-hidden="true" /> Edit
        </ButtonLink>
      </header>
      <ReadOnly blocks={data.blocks} />
    </section>
  );
}

/** Blocks shown with the editor's own schema, so they look exactly as they do in the editor, but can't be edited here. */
function ReadOnly({ blocks }: { blocks: SectionData['blocks'] }) {
  const extensions = useMemo(editorExtensions, []);
  const editor = useEditor({ extensions, editable: false, content: blocksToDoc(blocks), shouldRerenderOnTransaction: false });

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setContent(blocksToDoc(blocks), { emitUpdate: false });
  }, [editor, blocks]);

  return <EditorContent editor={editor} className="document px-8 py-6 max-md:px-4 [&_.ProseMirror]:min-h-0" />;
}

function countFolders(items: readonly TreeItem[]): number {
  return items.reduce((sum, item) => (typeof item === 'string' ? sum : sum + 1 + countFolders(item.items)), 0);
}

function folderLabel(tree: readonly TreeItem[], path: string): string {
  const [first, ...rest] = path.split('/');
  const found = tree.find((item) => typeof item !== 'string' && item.folder === first);
  if (!found || typeof found === 'string') return path;
  return rest.length ? folderLabel(found.items, rest.join('/')) : found.name;
}
