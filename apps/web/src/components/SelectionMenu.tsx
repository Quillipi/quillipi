import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useState } from 'react';

/** Formatting for selected text. Formatting is limited on purpose: styles carry meaning that agents can read. */
export function SelectionMenu({ editor }: { editor: Editor }) {
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState('');
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      highlight: current.isActive('highlight'),
      code: current.isActive('code'),
      link: current.isActive('link'),
    }),
  });

  const applyLink = () => {
    const chain = editor.chain().focus().extendMarkRange('link');
    if (href.trim()) chain.setLink({ href: href.trim() }).run();
    else chain.unsetLink().run();
    setLinking(false);
  };

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: current, from, to }) =>
        from !== to && current.isEditable && !current.isActive('codeBlock') && !(current.state.selection instanceof NodeSelection)
      }
    >
      <div className="selection-menu" role="toolbar" aria-label="Format the selection">
        {linking ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              applyLink();
            }}
          >
            <input autoFocus value={href} placeholder="Paste a link, or leave empty to remove it" aria-label="Link address" onChange={(event) => setHref(event.target.value)} />
            <button type="submit">Apply</button>
          </form>
        ) : (
          <>
            <button type="button" aria-pressed={active.bold} title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()}>
              <b>B</b>
            </button>
            <button type="button" aria-pressed={active.italic} title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()}>
              <i>I</i>
            </button>
            <button type="button" aria-pressed={active.strike} title="Strikethrough (Ctrl+Shift+S)" onClick={() => editor.chain().focus().toggleStrike().run()}>
              <s>S</s>
            </button>
            <button type="button" aria-pressed={active.highlight} title="Highlight (Ctrl+Shift+H)" onClick={() => editor.chain().focus().toggleHighlight().run()}>
              <mark>H</mark>
            </button>
            <button type="button" aria-pressed={active.code} title="Code (Ctrl+E)" onClick={() => editor.chain().focus().toggleCode().run()}>
              <code>{'<>'}</code>
            </button>
            <button
              type="button"
              aria-pressed={active.link}
              title="Link"
              onClick={() => {
                setHref(editor.getAttributes('link').href ?? '');
                setLinking(true);
              }}
            >
              Link
            </button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
