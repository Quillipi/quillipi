/** Editing commands shared by the ribbon, the selection menu and keyboard shortcuts. */
import { type Editor, Extension, type JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

export type BlockStyle = 'paragraph' | 'title' | 'heading' | 'subheading' | 'quote' | 'callout' | 'code' | 'bullet' | 'numbered' | 'task';

export const STYLE_NAMES: Record<BlockStyle, string> = {
  paragraph: 'Normal text',
  title: 'Title',
  heading: 'Heading',
  subheading: 'Subheading',
  quote: 'Quote',
  callout: 'Callout',
  code: 'Code block',
  bullet: 'Bulleted list',
  numbered: 'Numbered list',
  task: 'Checklist',
};

const NODE_STYLES: Record<string, BlockStyle> = {
  paragraph: 'paragraph',
  quote: 'quote',
  callout: 'callout',
  codeBlock: 'code',
  bulletItem: 'bullet',
  orderedItem: 'numbered',
  taskItem: 'task',
};

/** The style of the block holding the cursor, if it has one (tables and figures don't). */
export function currentStyle(editor: Editor): BlockStyle | undefined {
  const { $from } = editor.state.selection;
  const node = $from.depth >= 1 ? $from.node(1) : editor.state.selection instanceof NodeSelection ? editor.state.selection.node : undefined;
  if (!node) return undefined;
  if (node.type.name === 'heading') return (['title', 'heading', 'subheading'] as const)[node.attrs.level - 1];
  return NODE_STYLES[node.type.name];
}

export function setStyle(editor: Editor, style: BlockStyle): void {
  const chain = editor.chain().focus();
  if (style === 'paragraph') chain.setParagraph();
  else if (style === 'title') chain.setHeading({ level: 1 });
  else if (style === 'heading') chain.setHeading({ level: 2 });
  else if (style === 'subheading') chain.setHeading({ level: 3 });
  else if (style === 'code') chain.setCodeBlock();
  else if (style === 'task') chain.setNode('taskItem', { checked: false });
  else chain.setNode({ quote: 'quote', callout: 'callout', bullet: 'bulletItem', numbered: 'orderedItem' }[style]);
  chain.run();
}

/** List buttons work as toggles: pressing Bulleted list in a bulleted item makes it plain text. */
export function toggleStyle(editor: Editor, style: BlockStyle): void {
  setStyle(editor, currentStyle(editor) === style ? 'paragraph' : style);
}

/** Moves the block holding the cursor up or down past its neighbour. The block keeps its ID. */
export function moveBlock(editor: Editor, direction: -1 | 1): boolean {
  const { state } = editor;
  const selection = state.selection;
  const index = selection instanceof NodeSelection && selection.$from.depth === 0 ? selection.$from.index(0) : selection.$from.depth >= 1 ? selection.$from.index(0) : -1;
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.doc.childCount) return false;

  let start = 0;
  for (let i = 0; i < index; i++) start += state.doc.child(i).nodeSize;
  const node = state.doc.child(index);
  const offset = selection.from - start;
  const transaction = state.tr.delete(start, start + node.nodeSize);
  let insertAt = 0;
  for (let i = 0; i < target; i++) insertAt += transaction.doc.child(i).nodeSize;
  transaction.insert(insertAt, node);
  transaction.setSelection(node.isAtom ? NodeSelection.create(transaction.doc, insertAt) : TextSelection.near(transaction.doc.resolve(insertAt + offset)));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

/** Inserts a block after the one holding the cursor and selects it. */
export function insertBlock(editor: Editor, content: JSONContent): void {
  const { $from } = editor.state.selection;
  const at = $from.depth >= 1 ? $from.after(1) : editor.state.selection.to;
  editor.chain().focus().insertContentAt(at, content).run();
  if (editor.state.doc.nodeAt(at)?.isAtom) editor.commands.setNodeSelection(at);
}

/**
 * Backspace at the start of a block right after an empty one removes the empty block instead
 * of merging into it, so the block with text keeps its ID and doesn't look new.
 */
function removeEmptyBlockBefore(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.depth !== 1 || $from.parentOffset !== 0) return false;
  const index = $from.index(0);
  const previous = index > 0 ? editor.state.doc.child(index - 1) : undefined;
  if (!previous?.isTextblock || previous.content.size > 0) return false;
  const end = $from.before(1);
  return editor.commands.deleteRange({ from: end - previous.nodeSize, to: end });
}

export const Shortcuts = Extension.create({
  name: 'inklogShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-0': () => this.editor.commands.setParagraph(),
      'Mod-Shift-8': () => (toggleStyle(this.editor, 'bullet'), true),
      'Mod-Shift-7': () => (toggleStyle(this.editor, 'numbered'), true),
      'Mod-Shift-9': () => (toggleStyle(this.editor, 'task'), true),
      'Alt-ArrowUp': () => moveBlock(this.editor, -1),
      'Alt-ArrowDown': () => moveBlock(this.editor, 1),
      Backspace: () => removeEmptyBlockBefore(this.editor),
    };
  },
});
