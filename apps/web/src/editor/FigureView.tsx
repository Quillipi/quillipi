/** Images and drawings in the page. They float left or right so text wraps around them. */
import { DEFAULT_ASPECT, renderCanvasSvg } from '@inklog/core';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useRef, useState } from 'react';
import { fileUrl } from '../api';
import { CanvasEditor, SCREEN_PALETTE } from './CanvasEditor';

const PLACEMENTS = [
  { wrap: 'left', label: 'Left' },
  { wrap: 'inline', label: 'Full line' },
  { wrap: 'right', label: 'Right' },
] as const;

export function FigureView({ node, editor, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const isCanvas = node.type.name === 'canvas';
  const { wrap, width } = node.attrs as { wrap: string; width: number };
  const caption: string = isCanvas ? node.attrs.title : node.attrs.caption;
  const [resizingTo, setResizingTo] = useState<number>();
  const [editing, setEditing] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const editable = editor.isEditable;

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const page = figure.current?.parentElement;
    if (!page) return;
    const pageWidth = page.getBoundingClientRect().width;
    const startX = event.clientX;
    // A figure on the right grows to the left, so the handle sits on its left side.
    const direction = wrap === 'right' ? -1 : 1;
    let next = width;
    const move = (moved: PointerEvent) => {
      next = Math.round(Math.min(100, Math.max(20, width + (direction * (moved.clientX - startX) * 100) / pageWidth)));
      setResizingTo(next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      setResizingTo(undefined);
      if (next !== width) updateAttributes({ width: next });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  return (
    <NodeViewWrapper as="figure" ref={figure} className={`figure wrap-${wrap}${selected ? ' is-selected' : ''}`} style={{ width: `${resizingTo ?? width}%` }} data-block-id={node.attrs.id}>
      {isCanvas ? (
        <div
          className="canvas-preview"
          onDoubleClick={() => editable && setEditing(true)}
          dangerouslySetInnerHTML={{
            __html: renderCanvasSvg(node.attrs.elements, { aspect: node.attrs.aspect ?? DEFAULT_ASPECT, palette: SCREEN_PALETTE, imageUrl: fileUrl }),
          }}
        />
      ) : (
        <img src={fileUrl(node.attrs.src)} alt={caption} draggable={false} />
      )}
      <figcaption>
        {editable ? (
          <input
            value={caption}
            placeholder={isCanvas ? 'Add a title' : 'Add a caption'}
            aria-label={isCanvas ? 'Drawing title' : 'Image caption'}
            onChange={(event) => updateAttributes({ [isCanvas ? 'title' : 'caption']: event.target.value })}
          />
        ) : (
          caption
        )}
      </figcaption>
      {editable && selected && (
        <div className="figure-tools" contentEditable={false}>
          <button type="button" className="grip" data-drag-handle="" aria-label="Drag to move" title="Drag to move">
            ⠿
          </button>
          {PLACEMENTS.map((placement) => (
            <button key={placement.wrap} type="button" aria-pressed={wrap === placement.wrap} onClick={() => updateAttributes({ wrap: placement.wrap })}>
              {placement.label}
            </button>
          ))}
          {isCanvas && (
            <button type="button" onClick={() => setEditing(true)}>
              Edit drawing
            </button>
          )}
          <button type="button" onClick={deleteNode}>
            Delete
          </button>
        </div>
      )}
      {editable && <span className={`resize-handle${wrap === 'right' ? ' on-left' : ''}`} onPointerDown={startResize} aria-hidden="true" />}
      {editing && (
        <CanvasEditor
          title={caption}
          elements={node.attrs.elements}
          aspect={node.attrs.aspect ?? DEFAULT_ASPECT}
          onSave={(elements, aspect) => {
            updateAttributes({ elements, aspect });
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </NodeViewWrapper>
  );
}
