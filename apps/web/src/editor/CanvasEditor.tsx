/**
 * Full-screen editor for a drawing. Changes stay local until Done, so a whole editing session
 * is one step in the document's undo history.
 */
import {
  BOARD_WIDTH,
  type CanvasElement,
  type FramedElement,
  type Palette,
  SHAPE_SIZE,
  type ShapeKind,
  boardHeight,
  isFramed,
  nextElementId,
  renderCanvasSvg,
} from '@inklog/core';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, fileUrl } from '../api';

/** Drawings follow the page's light or dark theme on screen. */
export const SCREEN_PALETTE: Palette = { ink: 'var(--ink)', muted: 'var(--muted)', line: 'var(--canvas-line)', fill: 'var(--paper)', accent: 'var(--accent)' };

type Tool = 'select' | ShapeKind | 'arrow';

const TOOLS: { tool: Tool; label: string; hint: string }[] = [
  { tool: 'select', label: 'Select', hint: 'Drag to move. Double-click to rename. Delete removes the selection.' },
  { tool: 'box', label: 'Box', hint: 'Click the board to add a box.' },
  { tool: 'ellipse', label: 'Ellipse', hint: 'Click the board to add an ellipse.' },
  { tool: 'diamond', label: 'Decision', hint: 'Click the board to add a decision.' },
  { tool: 'text', label: 'Text', hint: 'Click the board to add text.' },
  { tool: 'arrow', label: 'Arrow', hint: 'Click a shape, then the shape the arrow points to.' },
];

interface Drag {
  id: string;
  resize: boolean;
  from: { x: number; y: number };
  frame: FramedElement;
}

interface CanvasEditorProps {
  title: string;
  elements: CanvasElement[];
  aspect: number;
  onSave(elements: CanvasElement[], aspect: number): void;
  onClose(): void;
}

export function CanvasEditor({ title, elements: initial, aspect: initialAspect, onSave, onClose }: CanvasEditorProps) {
  const [elements, setElements] = useState(initial);
  const [aspect, setAspect] = useState(initialAspect);
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [arrowFrom, setArrowFrom] = useState<string>();
  const board = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | undefined>(undefined);
  const imagePicker = useRef<HTMLInputElement>(null);
  const height = boardHeight(aspect);

  const toBoard = (event: { clientX: number; clientY: number }) => {
    const rect = board.current!.getBoundingClientRect();
    const scale = BOARD_WIDTH / rect.width;
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
  };
  const change = (id: string, values: Partial<FramedElement> | { label: string }) =>
    setElements((list) => list.map((element) => (element.id === id ? ({ ...element, ...values } as CanvasElement) : element)));
  const remove = (id: string) =>
    setElements((list) => list.filter((element) => element.id !== id && !(element.kind === 'arrow' && (element.from === id || element.to === id))));

  const add = (element: CanvasElement) => {
    setElements((list) => [...list, element]);
    setSelected(element.id);
  };

  const pointerDown = (event: React.PointerEvent) => {
    if (renaming) return;
    // The board handles every click itself. Without this, the browser would finish the click by
    // moving focus to the board, closing the label box a new shape has just opened.
    event.preventDefault();
    const target = event.target as Element;
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle');
    const hit = target.closest('[data-el]')?.getAttribute('data-el');
    const point = toBoard(event);
    const element = elements.find((candidate) => candidate.id === (handle ?? hit));

    if (element && tool === 'arrow') {
      if (!isFramed(element)) return;
      if (!arrowFrom) setArrowFrom(element.id);
      else if (arrowFrom !== element.id) {
        add({ id: nextElementId(elements), kind: 'arrow', from: arrowFrom, to: element.id, label: '' });
        setArrowFrom(undefined);
      }
      return;
    }
    if (element) {
      setSelected(element.id);
      if (isFramed(element)) {
        drag.current = { id: element.id, resize: Boolean(handle), from: point, frame: element };
        board.current?.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (tool !== 'select' && tool !== 'arrow') {
      const size = SHAPE_SIZE[tool];
      const id = nextElementId(elements);
      add({ id, kind: tool, label: '', x: clamp(point.x - size.w / 2, 0, BOARD_WIDTH - size.w), y: clamp(point.y - size.h / 2, 0, height - size.h), ...size });
      setRenaming(id);
      setTool('select');
      return;
    }
    setSelected(undefined);
    setArrowFrom(undefined);
  };

  const pointerMove = (event: React.PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const point = toBoard(event);
    const dx = point.x - current.from.x;
    const dy = point.y - current.from.y;
    const { x, y, w, h } = current.frame;
    if (current.resize) change(current.id, { w: clamp(w + dx, 24, BOARD_WIDTH - x), h: clamp(h + dy, 16, height - y) });
    else change(current.id, { x: clamp(x + dx, 0, BOARD_WIDTH - w), y: clamp(y + dy, 0, height - h) });
  };

  const doubleClick = (event: React.MouseEvent) => {
    const hit = (event.target as Element).closest('[data-el]')?.getAttribute('data-el');
    if (hit) setRenaming(hit);
  };

  const addImage = async (file: File | undefined) => {
    if (!file) return;
    const { src } = await api.uploadImage(file);
    add({ id: nextElementId(elements), kind: 'image', src, label: file.name.replace(/\.[^.]+$/, ''), x: BOARD_WIDTH / 2 - 70, y: Math.max(0, height / 2 - 50), w: 140, h: 100 });
  };

  // Registered again after every render, so the handler always sees the current selection.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (renaming) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
        event.preventDefault();
        remove(selected);
        setSelected(undefined);
      } else if (event.key === 'Escape') {
        if (arrowFrom || selected) {
          setArrowFrom(undefined);
          setSelected(undefined);
        } else onClose();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });

  const renamed = elements.find((element) => element.id === renaming);
  const hint = arrowFrom ? 'Now click the shape the arrow points to.' : TOOLS.find((entry) => entry.tool === tool)!.hint;
  const svg = renderCanvasSvg(elements, { aspect, palette: SCREEN_PALETTE, selected: new Set([selected, arrowFrom].filter(Boolean) as string[]), editing: renaming, imageUrl: fileUrl });

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="canvas-editor" role="dialog" aria-label={`Edit drawing${title ? `: ${title}` : ''}`}>
        <div className="canvas-toolbar" role="toolbar">
          {TOOLS.map((entry) => (
            <button key={entry.tool} type="button" aria-pressed={tool === entry.tool} onClick={() => setTool(entry.tool)}>
              {entry.label}
            </button>
          ))}
          <button type="button" onClick={() => imagePicker.current?.click()}>
            Image
          </button>
          <input ref={imagePicker} type="file" accept="image/*" hidden onChange={(event) => void addImage(event.target.files?.[0])} />
          <span className="spacer" />
          <button type="button" onClick={() => setAspect(BOARD_WIDTH / Math.min(1200, height + 80))}>
            Taller
          </button>
          <button type="button" onClick={() => setAspect(BOARD_WIDTH / Math.max(120, height - 80))}>
            Shorter
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onSave(elements, Math.round(aspect * 100) / 100)}>
            Done
          </button>
        </div>
        <div className="canvas-stage" style={{ aspectRatio: `${BOARD_WIDTH} / ${height}` }}>
          <div
            ref={board}
            className={`canvas-board tool-${tool}`}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={() => (drag.current = undefined)}
            onDoubleClick={doubleClick}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          {renamed && <LabelInput element={renamed} boardHeight={height} elements={elements} onDone={(label) => (change(renamed.id, { label }), setRenaming(undefined))} />}
        </div>
        <p className="muted canvas-hint">{hint}</p>
      </div>
    </div>,
    document.body,
  );
}

/** A text box over the element being renamed, placed in board units so it needs no measuring. */
function LabelInput({ element, elements, boardHeight: height, onDone }: { element: CanvasElement; elements: CanvasElement[]; boardHeight: number; onDone(label: string): void }) {
  const [label, setLabel] = useState(element.label);
  let frame: { x: number; y: number; w: number; h: number };
  if (isFramed(element)) frame = element;
  else {
    const ends = [element.from, element.to].map((id) => elements.find((candidate) => candidate.id === id)).filter((end): end is FramedElement => !!end && isFramed(end));
    const x = ends.reduce((sum, end) => sum + end.x + end.w / 2, 0) / Math.max(1, ends.length);
    const y = ends.reduce((sum, end) => sum + end.y + end.h / 2, 0) / Math.max(1, ends.length);
    frame = { x: x - 60, y: y - 14, w: 120, h: 28 };
  }
  const percent = (value: number, of: number) => `${(value / of) * 100}%`;
  return (
    <input
      className="label-input"
      autoFocus
      value={label}
      aria-label="Label"
      style={{ left: percent(frame.x, BOARD_WIDTH), top: percent(frame.y, height), width: percent(frame.w, BOARD_WIDTH), height: percent(frame.h, height) }}
      onChange={(event) => setLabel(event.target.value)}
      onBlur={() => onDone(label)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape') onDone(event.key === 'Enter' ? label : element.label);
      }}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}
