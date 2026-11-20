import { serializeSection } from '@inklog/core';
import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';
import { docToBlocks } from '../editor/convert';

/** The section exactly as it is stored on disk. */
export function FileView({ editor, section }: { editor: Editor; section: string }) {
  const read = () => serializeSection({ blocks: docToBlocks(editor.state.doc) });
  const [text, setText] = useState(read);
  useEffect(() => {
    const update = () => setText(read());
    editor.on('update', update);
    return () => void editor.off('update', update);
  });
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <section className="file-view" aria-label="File">
      <p className="muted">sections/{section}.md</p>
      <pre>
        {lines.map((line, index) => (
          <div key={index} className="file-line">
            <span className="line-number" aria-hidden="true">
              {index + 1}
            </span>
            <code>{line || ' '}</code>
          </div>
        ))}
      </pre>
    </section>
  );
}
