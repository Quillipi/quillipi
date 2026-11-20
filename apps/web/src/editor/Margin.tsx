/**
 * The change margin beside the page: a bar for each added, edited or moved block, and a
 * marker where blocks were removed. Clicking one opens a card that shows the change and can
 * revert it or leave it out of the next commit. It measures block positions and never
 * touches the document itself.
 */
import { type Block, type PendingChange, diffBlocks, diffCanvas, plainText, removalKey, wordDiff } from '@inklog/core';
import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { docToBlocks } from './convert';

type Kind = 'added' | 'modified' | 'moved' | 'removed';

interface MarginMark {
  /** The block ID, or for removed blocks the removal key of the first one. */
  key: string;
  kind: Kind;
  top: number;
  height: number;
  /** The block now, or the removed blocks. */
  blocks: Block[];
}

const KIND_NAMES: Record<Kind, string> = { added: 'Added', modified: 'Edited', moved: 'Moved', removed: 'Removed' };
const TYPE_NAMES: Record<Block['type'], string> = {
  p: 'Normal text',
  h1: 'Title',
  h2: 'Heading',
  h3: 'Subheading',
  li: 'Bulleted item',
  ol: 'Numbered item',
  task: 'Checklist item',
  quote: 'Quote',
  callout: 'Callout',
  code: 'Code block',
  hr: 'Divider',
  table: 'Table',
  image: 'Image',
  canvas: 'Drawing',
};

interface MarginProps {
  editor: Editor;
  /** What the margin compares against: the last commit, or a commit chosen to compare with. */
  base: Block[];
  section: string;
  pending: PendingChange[];
  /** For a past commit: changes are shown, with no actions. */
  readOnly?: boolean;
  onRevert?: (keys: string[]) => void;
}

export function Margin({ editor, base, section, pending, readOnly = false, onRevert }: MarginProps) {
  const [marks, setMarks] = useState<MarginMark[]>([]);
  const [openKey, setOpenKey] = useState<string>();
  const column = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => column.current && setMarks(measureMarks(editor, base, column.current)));
    };
    measure();
    editor.on('update', measure);
    const resizes = new ResizeObserver(measure);
    resizes.observe(editor.view.dom);
    return () => {
      cancelAnimationFrame(frame);
      editor.off('update', measure);
      resizes.disconnect();
    };
  }, [editor, base]);

  const changes = new Map(pending.filter((change) => change.section === section).map((change) => [change.key, change]));
  const keysOf = (mark: MarginMark) => (mark.kind === 'removed' ? mark.blocks.map((block) => removalKey(block.id)) : [mark.key]);
  const open = marks.find((mark) => mark.key === openKey);

  return (
    <div className="margin" ref={column}>
      {marks.map((mark) => {
        const change = changes.get(keysOf(mark)[0]);
        const byAgent = change?.by.includes('agent');
        const classes = ['mark', `mark-${mark.kind}`, byAgent && 'by-agent', change && !change.included && 'left-out'].filter(Boolean).join(' ');
        return (
          <button
            key={mark.key}
            type="button"
            className={classes}
            style={{ top: mark.top, height: mark.height }}
            aria-label={`${KIND_NAMES[mark.kind]}${byAgent ? ' by AI' : ''}: show the change`}
            aria-expanded={openKey === mark.key}
            onClick={() => setOpenKey(openKey === mark.key ? undefined : mark.key)}
          />
        );
      })}
      {open && (
        <ChangeCard
          mark={open}
          before={base}
          keys={keysOf(open)}
          changes={changes}
          section={section}
          readOnly={readOnly}
          onRevert={(keys) => {
            onRevert?.(keys);
            setOpenKey(undefined);
          }}
          onClose={() => setOpenKey(undefined)}
        />
      )}
    </div>
  );
}

function measureMarks(editor: Editor, base: Block[], column: HTMLElement): MarginMark[] {
  const blocks = docToBlocks(editor.state.doc);
  const { changes, removed } = diffBlocks(base, blocks);
  const origin = column.getBoundingClientRect().top;
  const offsets = new Map<string, number>();
  editor.state.doc.forEach((node, offset) => offsets.set(node.attrs.id, offset));
  const box = (id: string) => {
    const offset = offsets.get(id);
    const dom = offset === undefined ? null : editor.view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return undefined;
    // Node views wrap the block in an element of their own; a floating figure's wrapper has no height.
    const block = dom.matches('[data-block-id]') ? dom : (dom.querySelector('[data-block-id]') ?? dom);
    return block.getBoundingClientRect();
  };
  const current = new Map(blocks.map((block) => [block.id, block]));

  const marks: MarginMark[] = [];
  for (const [id, kind] of changes) {
    const rect = box(id);
    if (rect) marks.push({ key: id, kind, top: rect.top - origin, height: Math.max(rect.height, 12), blocks: [current.get(id)!] });
  }
  for (const removal of removed) {
    const rect = removal.after ? box(removal.after) : undefined;
    marks.push({ key: removalKey(removal.blocks[0].id), kind: 'removed', top: (rect ? rect.bottom - origin : 0) - 6, height: 12, blocks: removal.blocks });
  }
  return marks;
}

interface ChangeCardProps {
  mark: MarginMark;
  before: Block[];
  keys: string[];
  changes: Map<string, PendingChange>;
  section: string;
  readOnly: boolean;
  onRevert(keys: string[]): void;
  onClose(): void;
}

function ChangeCard({ mark, before, keys, changes, section, readOnly, onRevert, onClose }: ChangeCardProps) {
  const change = changes.get(keys[0]);
  const included = keys.every((key) => changes.get(key)?.included ?? true);
  const held = keys.some((key) => changes.get(key)?.held);
  const toggleIncluded = async () => {
    for (const key of keys) await api.include(section, key, !included);
  };

  return (
    <div className="change-card" role="dialog" aria-label={`${KIND_NAMES[mark.kind]} block`} style={{ top: Math.max(0, mark.top - 8) }}>
      <header>
        <strong>{KIND_NAMES[mark.kind]}</strong>
        {change && <span className={change.by.includes('agent') ? 'by-agent-label' : 'muted'}>{change.by.includes('agent') ? '✦ by AI' : 'by you'}</span>}
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <ChangeDetails mark={mark} before={before} />
      {held && <p className="muted">Held for your review. Approve it from Commit.</p>}
      {!readOnly && (
        <footer>
          <button type="button" onClick={() => onRevert(keys)}>
            {mark.kind === 'removed' ? 'Restore' : 'Revert'}
          </button>
          {change && !held && (
            <button type="button" onClick={toggleIncluded}>
              {included ? 'Leave out of commit' : 'Include in commit'}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

function ChangeDetails({ mark, before }: { mark: MarginMark; before: Block[] }) {
  if (mark.kind === 'removed') {
    return (
      <div className="change-text">
        {mark.blocks.map((block) => (
          <p key={block.id}>
            <del>{describe(block)}</del>
          </p>
        ))}
      </div>
    );
  }
  if (mark.kind === 'added') return <p className="muted">A new block.</p>;
  if (mark.kind === 'moved') return <p className="muted">Moved within this section.</p>;

  const now = mark.blocks[0];
  const old = before.find((block) => block.id === now.id)!;
  if (now.type === 'canvas') {
    const lines = diffCanvas(old.attrs?.elements ?? [], now.attrs?.elements ?? []);
    return <ul className="change-list">{(lines.length ? lines : ['Resized or moved on the page']).map((line) => <li key={line}>{line}</li>)}</ul>;
  }
  return (
    <div className="change-text">
      {old.type !== now.type && (
        <p className="muted">
          Changed from {TYPE_NAMES[old.type]} to {TYPE_NAMES[now.type]}.
        </p>
      )}
      <p>
        {wordDiff(plainText(old), plainText(now)).map((part, index) =>
          part.kind === 'same' ? <span key={index}>{part.text}</span> : part.kind === 'added' ? <ins key={index}>{part.text}</ins> : <del key={index}>{part.text}</del>,
        )}
      </p>
    </div>
  );
}

function describe(block: Block): string {
  return plainText(block) || (block.type === 'p' ? 'An empty line' : TYPE_NAMES[block.type]);
}
