/**
 * The editor's one toolbar row: undo and redo, the paragraph style, bold, italic and highlight, the
 * three kinds of list, moving a block, and Insert ▾; at its right end the switch between the
 * document, its file and what an AI sees. Every button has a name and its shortcut in its tooltip.
 * On a narrow screen the tools scroll sideways and the view switch folds into one small menu.
 */
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { ArrowDown, ArrowUp, Bold, ChevronDown, Highlighter, Italic, List, ListChecks, ListOrdered, Plus, Redo2, Undo2, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { api } from '../api';
import { type BlockStyle, STYLE_NAMES, currentStyle, insertBlock, moveBlock, setStyle, toggleStyle } from '../editor/commands';
import { type View, useApp } from '../store';
import { MenuButton } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

const STYLE_CHOICES: BlockStyle[] = ['paragraph', 'title', 'heading', 'subheading', 'quote', 'callout', 'code'];

const VIEWS: { view: View; label: string; hint: string }[] = [
  { view: 'doc', label: 'Doc', hint: 'The document, to read and write' },
  { view: 'file', label: 'File', hint: 'The Markdown file, as Git and GitHub keep it' },
  { view: 'agent', label: 'AI view', hint: 'What an AI reads through Quillipi' },
];

export function Toolbar({ editor, onError }: { editor?: Editor; onError(message?: string): void }) {
  const view = useApp((state) => state.view);
  const viewing = useApp((state) => state.viewing);
  return (
    <div className="@container shrink-0 border-b border-border bg-background">
      <div className="flex h-12 items-center gap-2 pr-3 pl-2 max-md:pl-1">
      <div className="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto max-md:[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]">
        {editor && view === 'doc' && !viewing ? <Formatting editor={editor} onError={onError} /> : <span className="px-2 text-[13px] text-muted-foreground">{viewing ? 'An earlier version, read-only' : view === 'file' ? 'The Markdown file, as Git and GitHub keep it' : view === 'agent' ? 'What an AI reads through Quillipi' : null}</span>}
      </div>
      <MenuButton
        label="Show"
        className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-input bg-background px-2.5 text-[13px] font-medium outline-none @3xl:hidden touch:h-10"
        align="end"
        items={VIEWS.map((entry) => ({ label: entry.label, hint: entry.hint, onSelect: () => useApp.getState().setView(entry.view) }))}
      >
        {VIEWS.find((entry) => entry.view === view)?.label} <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </MenuButton>
      <div className="flex shrink-0 gap-0.5 rounded-[10px] bg-secondary p-0.5 @max-3xl:hidden" role="radiogroup" aria-label="Show">
        {VIEWS.map((entry) => (
          <button
            key={entry.view}
            type="button"
            role="radio"
            aria-checked={view === entry.view}
            title={entry.hint}
            onClick={() => useApp.getState().setView(entry.view)}
            className="h-7 rounded-lg px-2.5 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-tile"
          >
            {entry.label}
          </button>
        ))}
      </div>
      </div>
    </div>
  );
}

function Formatting({ editor, onError }: { editor: Editor; onError(message?: string): void }) {
  const imagePicker = useRef<HTMLInputElement>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      style: currentStyle(current),
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      highlight: current.isActive('highlight'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });

  const addImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const { src } = await api.uploadImage(file);
      insertBlock(editor, { type: 'image', attrs: { src, caption: '', wrap: 'right', width: 45 } });
      onError(undefined);
    } catch (failure) {
      onError((failure as Error).message);
    }
  };

  const styleKnown = state.style && STYLE_CHOICES.includes(state.style);
  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
      <Tool icon={Undo2} label="Undo" keys="Ctrl+Z" disabled={!state.canUndo} run={() => editor.chain().focus().undo().run()} />
      <Tool icon={Redo2} label="Redo" keys="Ctrl+Shift+Z" disabled={!state.canRedo} run={() => editor.chain().focus().redo().run()} />
      <Divider />
      <select aria-label="Paragraph style" className="h-8 w-[118px] shrink-0 cursor-pointer rounded-lg border border-input bg-background px-2 text-[13px] font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring touch:h-10" value={styleKnown ? state.style : ''} onChange={(event) => setStyle(editor, event.target.value as BlockStyle)}>
        {!styleKnown && <option value="">{state.style ? STYLE_NAMES[state.style] : 'Style'}</option>}
        {STYLE_CHOICES.map((style) => (
          <option key={style} value={style}>
            {STYLE_NAMES[style]}
          </option>
        ))}
      </select>
      <Divider />
      <Tool icon={Bold} label="Bold" keys="Ctrl+B" pressed={state.bold} run={() => editor.chain().focus().toggleBold().run()} />
      <Tool icon={Italic} label="Italic" keys="Ctrl+I" pressed={state.italic} run={() => editor.chain().focus().toggleItalic().run()} />
      <Tool icon={Highlighter} label="Highlight" keys="Ctrl+Shift+H" pressed={state.highlight} run={() => editor.chain().focus().toggleHighlight().run()} />
      <Divider />
      <Tool icon={List} label="Bulleted list" pressed={state.style === 'bullet'} run={() => toggleStyle(editor, 'bullet')} />
      <Tool icon={ListOrdered} label="Numbered list" pressed={state.style === 'numbered'} run={() => toggleStyle(editor, 'numbered')} />
      <Tool icon={ListChecks} label="Checklist" pressed={state.style === 'task'} run={() => toggleStyle(editor, 'task')} />
      <Divider />
      <Tool icon={ArrowUp} label="Move block up" keys="Alt+Up" run={() => moveBlock(editor, -1)} />
      <Tool icon={ArrowDown} label="Move block down" keys="Alt+Down" run={() => moveBlock(editor, 1)} />
      <Divider />
      <MenuButton
        label="Insert"
        className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground touch:h-10"
        items={[
          { label: 'Drawing', onSelect: () => insertBlock(editor, { type: 'canvas', attrs: { title: '', wrap: 'right', width: 46, aspect: 1.6, elements: [] } }) },
          { label: 'Image…', onSelect: () => imagePicker.current?.click() },
          { label: 'Table', onSelect: () => insertBlock(editor, emptyTable(3, 3)) },
          { label: 'Divider', onSelect: () => insertBlock(editor, { type: 'horizontalRule' }) },
          { label: 'Code block', onSelect: () => insertBlock(editor, { type: 'codeBlock' }) },
          { label: 'Callout', onSelect: () => insertBlock(editor, { type: 'callout' }) },
        ]}
      >
        <Plus className="size-4" aria-hidden="true" /> Insert <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
      </MenuButton>
      <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden onChange={(event) => void addImage(event.target.files?.[0])} />
    </div>
  );
}

function Divider() {
  return <span className="mx-1.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
}

function Tool({ icon: Shape, label, keys, pressed, disabled, run }: { icon: LucideIcon; label: string; keys?: string; pressed?: boolean; disabled?: boolean; run(): void }) {
  return (
    <Tooltip label={label} keys={keys}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        // The caret stays in the text while a tool is pressed.
        onMouseDown={(event) => event.preventDefault()}
        onClick={run}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 aria-pressed:bg-brand-soft aria-pressed:text-brand touch:size-10"
      >
        <Shape className="size-[17px]" strokeWidth={1.9} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

function emptyTable(rows: number, columns: number) {
  const cell = (type: string) => ({ type, content: [{ type: 'paragraph' }] });
  return {
    type: 'table',
    content: Array.from({ length: rows }, (_, row) => ({ type: 'tableRow', content: Array.from({ length: columns }, () => cell(row === 0 ? 'tableHeader' : 'tableCell')) })),
  };
}
