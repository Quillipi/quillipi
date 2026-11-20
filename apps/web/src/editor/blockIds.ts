import { newId } from '@inklog/core';
import { Extension } from '@tiptap/core';
import { Fragment, type Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Keeps a unique ID on every top-level node:
 * - a new node gets a fresh ID;
 * - when a split leaves two nodes with the same ID, the one with more text keeps it, so
 *   pressing Enter in a paragraph doesn't make the paragraph look new;
 * - pasted content gets fresh IDs, because a copy is a new block. A block dragged to a new
 *   place in the page keeps its ID, because it moved.
 */
export const BlockIds = Extension.create({
  name: 'blockIds',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockIds'),
        appendTransaction(transactions, _before, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const nodes: { node: PMNode; pos: number }[] = [];
          state.doc.forEach((node, pos) => nodes.push({ node, pos }));

          const keeper = new Map<string, { pos: number; length: number }>();
          for (const { node, pos } of nodes) {
            const id: string | null = node.attrs.id;
            const best = id ? keeper.get(id) : undefined;
            if (id && (!best || node.textContent.length > best.length)) keeper.set(id, { pos, length: node.textContent.length });
          }

          const taken = new Set(keeper.keys());
          const transaction = state.tr;
          for (const { node, pos } of nodes) {
            const id: string | null = node.attrs.id;
            if (id && keeper.get(id)!.pos === pos) continue;
            const fresh = newId(taken);
            taken.add(fresh);
            transaction.setNodeAttribute(pos, 'id', fresh);
          }
          return transaction.docChanged ? transaction : null;
        },
        props: {
          transformPasted(slice, view) {
            if (view.dragging?.move) return slice;
            return new Slice(withoutIds(slice.content), slice.openStart, slice.openEnd);
          },
        },
      }),
    ];
  },
});

function withoutIds(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => nodes.push(node.attrs.id ? node.type.create({ ...node.attrs, id: null }, node.content, node.marks) : node));
  return Fragment.from(nodes);
}
