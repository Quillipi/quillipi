/**
 * The editor's document schema. It is flat: every top-level node is one Quillipi block, list
 * items included, which keeps it one to one with the file format. Ordered lists are numbered
 * with CSS counters (see styles.css).
 */
import { type Editor, Extension, Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core';
import Code from '@tiptap/extension-code';
import Highlight from '@tiptap/extension-highlight';
import { TableCell, TableHeader, TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { BlockIds } from './blockIds';
import { Shortcuts } from './commands';
import { FigureView } from './FigureView';

const BLOCK_NODES = ['paragraph', 'heading', 'bulletItem', 'orderedItem', 'taskItem', 'quote', 'callout', 'codeBlock', 'horizontalRule', 'table', 'image', 'canvas'];

/** Every block node carries its block ID, as `data-block-id` in the page. */
const BlockIdAttribute = Extension.create({
  name: 'blockIdAttribute',
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_NODES,
        attributes: {
          id: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attributes) => (attributes.id ? { 'data-block-id': attributes.id } : {}),
          },
        },
      },
    ];
  },
});

/** Enter adds another item, or ends the list on an empty one. Backspace at the start makes the item plain text. */
function listItemKeys(editor: Editor, name: string) {
  const inEmptySelectionOf = () => editor.state.selection.empty && editor.state.selection.$from.parent.type.name === name;
  return {
    Enter: () => {
      if (!inEmptySelectionOf()) return false;
      if (!editor.state.selection.$from.parent.textContent) return editor.commands.setNode('paragraph');
      return editor
        .chain()
        .splitBlock()
        .setNode(name, name === 'taskItem' ? { checked: false } : {})
        .run();
    },
    Backspace: () => (inEmptySelectionOf() && editor.state.selection.$from.parentOffset === 0 ? editor.commands.setNode('paragraph') : false),
  };
}

const BulletItem = Node.create({
  name: 'bulletItem',
  group: 'block',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-type="bullet"]' }, { tag: 'ul > li', contentElement: firstParagraph }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'bullet', class: 'item' }), 0],
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*[-+*]\s$/, type: this.type })];
  },
  addKeyboardShortcuts() {
    return listItemKeys(this.editor, this.name);
  },
});

const OrderedItem = Node.create({
  name: 'orderedItem',
  group: 'block',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-type="ordered"]' }, { tag: 'ol > li', contentElement: firstParagraph }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'ordered', class: 'item' }), 0],
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*\d+[.)]\s$/, type: this.type })];
  },
  addKeyboardShortcuts() {
    return listItemKeys(this.editor, this.name);
  },
});

const TaskItem = Node.create({
  name: 'taskItem',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes: () => ({
    checked: { default: false, parseHTML: (element) => element.getAttribute('data-checked') === 'true', renderHTML: (attributes) => ({ 'data-checked': String(attributes.checked) }) },
  }),
  parseHTML: () => [{ tag: 'div[data-type="task"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'task', class: 'item' }), 0],
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*(?:[-+*]\s)?\[( |x)\]\s$/, type: this.type, getAttributes: (match) => ({ checked: match[1] === 'x' }) })];
  },
  addKeyboardShortcuts() {
    return listItemKeys(this.editor, this.name);
  },
  // A real checkbox needs a node view; the text stays editable next to it.
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'item';
      dom.dataset.type = 'task';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.contentEditable = 'false';
      box.setAttribute('aria-label', 'Done');
      box.addEventListener('mousedown', (event) => event.preventDefault()); // keep the cursor where it is
      box.addEventListener('change', () => {
        const pos = getPos();
        if (!editor.isEditable || typeof pos !== 'number') return void (box.checked = !box.checked);
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'checked', box.checked));
      });
      const text = document.createElement('div');
      text.className = 'item-text';
      dom.append(box, text);

      const show = (current: PMNode) => {
        box.checked = current.attrs.checked;
        dom.dataset.checked = String(current.attrs.checked);
        if (current.attrs.id) dom.dataset.blockId = current.attrs.id;
      };
      show(node);
      return {
        dom,
        contentDOM: text,
        update: (updated) => updated.type === node.type && (show(updated), true),
        ignoreMutation: (mutation) => mutation.type === 'attributes' || mutation.target === box,
      };
    };
  },
});

const Quote = Node.create({
  name: 'quote',
  group: 'block',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'blockquote', contentElement: firstParagraph }],
  renderHTML: ({ HTMLAttributes }) => ['blockquote', HTMLAttributes, 0],
  addInputRules() {
    return [textblockTypeInputRule({ find: /^\s*>\s$/, type: this.type })];
  },
});

const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes: () => ({
    kind: { default: null, parseHTML: (element) => element.getAttribute('data-kind'), renderHTML: (attributes) => (attributes.kind ? { 'data-kind': attributes.kind } : {}) },
  }),
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', role: 'note' }), 0],
});

/** Figure attributes travel through copy and paste as data attributes. */
function dataAttribute(name: string, fallback: unknown, json = false) {
  return {
    default: fallback,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute(`data-${name}`);
      if (value === null) return fallback;
      return json ? JSON.parse(value) : name === 'width' ? Number(value) : value;
    },
    renderHTML: (attributes: Record<string, unknown>) => ({ [`data-${name}`]: json ? JSON.stringify(attributes[name]) : String(attributes[name] ?? '') }),
  };
}

const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: dataAttribute('src', ''), caption: dataAttribute('caption', ''), wrap: dataAttribute('wrap', 'inline'), width: dataAttribute('width', 100) }),
  parseHTML: () => [
    { tag: 'figure[data-type="image"]' },
    { tag: 'img[src]', getAttrs: (element) => ({ src: element.getAttribute('src'), caption: element.getAttribute('alt') ?? '', wrap: 'inline', width: 100 }) },
  ],
  renderHTML: ({ HTMLAttributes }) => ['figure', mergeAttributes(HTMLAttributes, { 'data-type': 'image' })],
  addNodeView: () => ReactNodeViewRenderer(FigureView),
});

const Canvas = Node.create({
  name: 'canvas',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({
    title: dataAttribute('title', ''),
    wrap: dataAttribute('wrap', 'inline'),
    width: dataAttribute('width', 100),
    aspect: dataAttribute('aspect', null, true),
    elements: dataAttribute('elements', [], true),
  }),
  parseHTML: () => [{ tag: 'figure[data-type="canvas"]' }],
  renderHTML: ({ HTMLAttributes }) => ['figure', mergeAttributes(HTMLAttributes, { 'data-type': 'canvas' })],
  addNodeView: () => ReactNodeViewRenderer(FigureView),
});

/** When pasting `<li><p>text</p></li>`, the text goes straight into the item. */
function firstParagraph(element: HTMLElement): HTMLElement {
  return element.querySelector<HTMLElement>(':scope > p') ?? element;
}

export function editorExtensions() {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      hardBreak: false,
      underline: false,
      code: false,
      // Opening a document must never change it, so no empty paragraph is added after a final table or code block.
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } },
    }),
    // Quillipi keeps formatting such as bold code from files, so code may share text with other marks.
    Code.extend({ excludes: '' }),
    Highlight,
    TableKit.configure({ table: { resizable: false }, tableCell: false, tableHeader: false }),
    TableCell.extend({ content: 'paragraph' }),
    TableHeader.extend({ content: 'paragraph' }),
    BulletItem,
    OrderedItem,
    TaskItem,
    Quote,
    Callout,
    Image,
    Canvas,
    BlockIdAttribute,
    BlockIds,
    Shortcuts,
    Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : 'Write here') }),
  ];
}
