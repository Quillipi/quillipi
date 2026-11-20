/** One open section: the live editor with its margin, or the File, AI or past-commit view of it. */
import { type Block, type SectionData, removalKey, stagedBlocks } from '@inklog/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Live, api, snapshot } from '../api';
import type { Editor } from '@tiptap/core';
import { FROM_ELSEWHERE, blocksToDoc, docToBlocks, showBlocks } from '../editor/convert';
import { Margin } from '../editor/Margin';
import { editorExtensions } from '../editor/schema';
import { SectionSync } from '../editor/sync';
import { Notice } from '../App';
import { useApp } from '../store';
import type { Heading } from '../tree/model';
import { AgentView } from './AgentView';
import { Breadcrumb } from './Breadcrumb';
import { CommitView } from './CommitView';
import { FileView } from './FileView';
import { SelectionMenu } from './SelectionMenu';
import { Toolbar } from './Toolbar';

export function SectionView({ id, live }: { id: string; live: Live }) {
  const [data, setData] = useState<SectionData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    api.section(id).then(
      (loaded) => current && setData(loaded),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [id]);
  if (error) return <Notice title="This section couldn’t be opened">{error}</Notice>;
  if (!data) {
    return (
      <>
        <Toolbar onError={() => {}} />
        <Notice>Opening…</Notice>
      </>
    );
  }
  return <LiveSection id={id} initial={data} live={live} />;
}

function LiveSection({ id, initial, live }: { id: string; initial: SectionData; live: Live }) {
  const view = useApp((state) => state.view);
  const viewing = useApp((state) => state.viewing);
  const compareWith = useApp((state) => state.compareWith);
  const compare = useApp((state) => state.compare);
  const pending = useApp((state) => state.info?.pending);
  const headCommit = useApp((state) => state.info?.commits[0]?.oid);
  const [head, setHead] = useState(initial.head);
  const [compareBase, setCompareBase] = useState<Block[]>();
  const [toolError, setToolError] = useState<string>();
  const sync = useRef<SectionSync>(undefined);
  const scrollerRef = useRef<HTMLElement>(null);

  const extensions = useMemo(editorExtensions, []);
  const editor = useEditor({
    extensions,
    content: blocksToDoc(initial.blocks),
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor: current, transaction }) => {
      if (!transaction.getMeta(FROM_ELSEWHERE)) sync.current?.edited();
      if (transaction.docChanged) publishOutline(id, current);
    },
  });

  // The tree shows this section's headings, and which one is being read as the page scrolls.
  useEffect(() => {
    if (!editor) return;
    publishOutline(id, editor, true);
    const scroller = scrollerRef.current;
    let frame = 0;
    const scrolled = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => useApp.getState().setReading(headingInView(scroller)));
    };
    scroller?.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller?.removeEventListener('scroll', scrolled);
      clearTimeout(outlineTimer);
      useApp.setState({ outline: undefined, reading: undefined });
    };
  }, [editor, id]);

  useEffect(() => {
    if (!editor) return;
    const current = new SectionSync(id, editor, initial, live, useApp.getState().setSaveState);
    sync.current = current;
    const stop = live.subscribe((event) => {
      if (event.type === 'section' && event.section === id) current.receive(event.version, event.blocks);
      if (event.type === 'connected') {
        void api.section(id).then((latest) => {
          current.receive(latest.version, latest.blocks);
          setHead(latest.head);
        });
      }
    });
    const saveNow = () => void current.save();
    window.addEventListener('pagehide', saveNow);
    return () => {
      stop();
      window.removeEventListener('pagehide', saveNow);
      current.close();
      sync.current = undefined;
      useApp.getState().setSaveState('saved');
    };
  }, [editor]);

  // A change pressed in the History panel: its block scrolls into view and flashes once.
  useEffect(() => {
    const show = (event: Event) => {
      const { section, id: block } = (event as CustomEvent<{ section: string; id: string }>).detail;
      if (section !== id) return;
      useApp.getState().setView('doc');
      // After the page has drawn, in case the panel's press also opened this section.
      requestAnimationFrame(() => {
        const element = scrollerRef.current?.querySelector<HTMLElement>(`.document [data-block-id="${CSS.escape(block)}"]`);
        if (!element) return;
        const scroller = scrollerRef.current!;
        element.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        // The flash lies over the block instead of changing it: the editor undoes changes made to its own text from outside.
        const [box, frame] = [element.getBoundingClientRect(), scroller.getBoundingClientRect()];
        const flash = document.createElement('div');
        flash.className = 'block-flash';
        flash.style.cssText = `top:${box.top - frame.top + scroller.scrollTop - 4}px;left:${box.left - frame.left - 8}px;width:${box.width + 16}px;height:${box.height + 8}px`;
        scroller.querySelectorAll('.block-flash').forEach((old) => old.remove());
        scroller.append(flash);
        setTimeout(() => flash.remove(), 1600);
      });
    };
    window.addEventListener('inklog:show-block', show);
    return () => window.removeEventListener('inklog:show-block', show);
  }, [id]);

  // After a commit, the margin compares against the new last commit.
  useEffect(() => {
    if (headCommit) void api.section(id).then((latest) => setHead(latest.head));
  }, [headCommit, id]);

  useEffect(() => {
    if (!compareWith) return setCompareBase(undefined);
    let current = true;
    void snapshot(compareWith).then((sections) => current && setCompareBase(sections[id] ?? []));
    return () => {
      current = false;
    };
  }, [compareWith, id]);

  const base = compareBase ?? head;
  const comparedCommit = useApp((state) => state.info?.commits.find((commit) => commit.oid === compareWith));

  const revert = (keys: string[]) => {
    if (!editor) return;
    const inBase = new Set(base.map((block) => block.id));
    // Reverting is a partial commit in reverse: from what is here now back to the base.
    const reverse = new Set(keys.map((key) => (key.startsWith('removed:') ? key.slice('removed:'.length) : inBase.has(key) ? key : removalKey(key))));
    showBlocks(editor, stagedBlocks(docToBlocks(editor.state.doc), base, (key) => reverse.has(key)), { fromElsewhere: false });
  };

  if (!editor) return null;
  const showingDocument = view === 'doc' && !viewing;
  return (
    <>
      <Toolbar editor={editor} onError={setToolError} />
      <main className="editor-main scroll-quiet relative min-h-0 flex-1 overflow-y-auto" ref={scrollerRef}>
        {toolError && (
          <div className="banner" role="alert">
            <span>{toolError}</span>
            <button type="button" onClick={() => setToolError(undefined)}>
              Dismiss
            </button>
          </div>
        )}
        {showingDocument && comparedCommit && (
          <div className="banner">
            <span>
              The margin shows changes since #{comparedCommit.number}, “{comparedCommit.message}”.
            </span>
            <button type="button" onClick={() => compare(undefined)}>
              Show changes since the last commit
            </button>
          </div>
        )}
        <div className="workspace" hidden={!showingDocument}>
          <div className="page">
            <Breadcrumb section={id} />
            <Margin editor={editor} base={base} section={id} pending={pending ?? []} onRevert={revert} />
            <EditorContent editor={editor} className="document" />
            <SelectionMenu editor={editor} />
          </div>
        </div>
        {viewing && <CommitView commit={viewing} section={id} onRestore={(blocks) => showBlocks(editor, blocks, { fromElsewhere: false })} />}
        {!viewing && view === 'file' && <FileView editor={editor} section={id} />}
        {!viewing && view === 'agent' && <AgentView section={id} />}
      </main>
    </>
  );
}

/** The level-2 headings of the section in the editor (the first heading is its title), for the tree. */
function headingsIn(editor: Editor): Heading[] {
  const headings: Heading[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'heading' && node.attrs.level === 2 && node.attrs.id && node.textContent.trim()) headings.push({ id: node.attrs.id as string, text: node.textContent.trim() });
  });
  return headings;
}

let outlineTimer: ReturnType<typeof setTimeout> | undefined;

/** Tells the tree the section's headings, a moment after typing stops, and only when they changed. */
function publishOutline(section: string, editor: Editor, now = false): void {
  clearTimeout(outlineTimer);
  const publish = () => {
    const headings = headingsIn(editor);
    const before = useApp.getState().outline;
    const same = before?.section === section && before.headings.length === headings.length && before.headings.every((heading, index) => heading.id === headings[index]!.id && heading.text === headings[index]!.text);
    if (!same) useApp.getState().setOutline({ section, headings });
  };
  if (now) publish();
  else outlineTimer = setTimeout(publish, 300);
}

/** The heading whose part of the page is being read: the last one above the top of the view. */
function headingInView(scroller: HTMLElement | null): string | undefined {
  if (!scroller) return undefined;
  const top = scroller.getBoundingClientRect().top + 96;
  let reading: string | undefined;
  for (const element of scroller.querySelectorAll<HTMLElement>('.document h2[data-block-id]')) {
    if (element.getBoundingClientRect().top > top) break;
    reading = element.dataset.blockId;
  }
  return reading;
}
