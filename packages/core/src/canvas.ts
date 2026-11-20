/**
 * Canvases are small diagrams that sit in the page: boxes, ellipses, decision diamonds,
 * free text, images and arrows between them. Every element has an ID, so changes are
 * tracked per element, just like blocks.
 *
 * Coordinates are board units. The board is BOARD_WIDTH wide and BOARD_WIDTH / aspect tall,
 * and is scaled to fit wherever it is shown.
 */

export const BOARD_WIDTH = 420;
export const DEFAULT_ASPECT = 1.6;

export type ShapeKind = 'box' | 'ellipse' | 'diamond' | 'text';

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasShape extends Frame {
  id: string;
  kind: ShapeKind;
  label: string;
}

export interface CanvasImage extends Frame {
  id: string;
  kind: 'image';
  /** File inside the repo, such as `assets/9f2c41d0.png`. */
  src: string;
  label: string;
}

export interface CanvasArrow {
  id: string;
  kind: 'arrow';
  from: string;
  to: string;
  label: string;
}

export type FramedElement = CanvasShape | CanvasImage;
export type CanvasElement = FramedElement | CanvasArrow;

export const SHAPE_SIZE: Record<ShapeKind, { w: number; h: number }> = {
  box: { w: 112, h: 44 },
  ellipse: { w: 112, h: 48 },
  diamond: { w: 108, h: 64 },
  text: { w: 120, h: 28 },
};

export function boardHeight(aspect = DEFAULT_ASPECT): number {
  return Math.round(BOARD_WIDTH / aspect);
}

export function isFramed(element: CanvasElement): element is FramedElement {
  return element.kind !== 'arrow';
}

// ---------------------------------------------------------------------------
// Reading elements from a file or an editor

/** Element IDs are short and plain (`k12`), so one can never break out of the markup it is drawn in. */
const ELEMENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Far beyond any board, but small enough that the drawing stays a drawing. */
const MAX_COORDINATE = 100_000;
const MAX_LABEL = 2_000;
const KINDS = new Set<string>(['box', 'ellipse', 'diamond', 'text', 'image', 'arrow']);

/**
 * The well-formed elements of a canvas as a file or an editor gives them. A canvas file can come
 * from anywhere a notebook's Git history comes from (a repo added from GitHub, a pull, another
 * person), so every field is checked: plain IDs, known kinds, finite numbers, text labels and
 * image paths inside the notebook. An element that isn't well formed is left out, and so is an
 * arrow whose ends are missing.
 */
export function canvasElements(raw: unknown): CanvasElement[] {
  if (!Array.isArray(raw)) return [];
  const elements: CanvasElement[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    const element = canvasElement(value);
    if (!element || ids.has(element.id)) continue;
    ids.add(element.id);
    elements.push(element);
  }
  return elements.filter((element) => element.kind !== 'arrow' || (ids.has(element.from) && ids.has(element.to)));
}

function canvasElement(value: unknown): CanvasElement | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { id, kind, label = '' } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !ELEMENT_ID.test(id) || typeof kind !== 'string' || !KINDS.has(kind) || typeof label !== 'string') return undefined;
  const text = label.slice(0, MAX_LABEL);
  if (kind === 'arrow') {
    const { from, to } = value as Record<string, unknown>;
    if (typeof from !== 'string' || typeof to !== 'string' || !ELEMENT_ID.test(from) || !ELEMENT_ID.test(to)) return undefined;
    return { id, kind, from, to, label: text };
  }
  const frame = frameOf(value as Record<string, unknown>);
  if (!frame) return undefined;
  if (kind === 'image') {
    const { src } = value as Record<string, unknown>;
    return typeof src === 'string' && isNotebookPath(src) ? { id, kind, src, label: text, ...frame } : undefined;
  }
  return { id, kind: kind as ShapeKind, label: text, ...frame };
}

function frameOf({ x, y, w, h }: Record<string, unknown>): Frame | undefined {
  const inRange = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE;
  if (!inRange(x) || !inRange(y) || !inRange(w) || !inRange(h) || w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

/** A file inside the notebook, such as `assets/9f2c41d0.png`: no address, no way out of the folder. */
function isNotebookPath(path: string): boolean {
  const parts = path.split('/');
  return path.length <= 300 && !/[\u0000-\u001f\u007f\\:?#]/.test(path) && !path.startsWith('/') && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Next free element ID: k1, k2, … */
export function nextElementId(elements: readonly CanvasElement[]): string {
  const highest = Math.max(0, ...elements.map((element) => Number(/^k(\d+)$/.exec(element.id)?.[1] ?? 0)));
  return `k${highest + 1}`;
}

// ---------------------------------------------------------------------------
// Text, for AI agents and change summaries

export function canvasLines(elements: readonly CanvasElement[]): string[] {
  return elements.map((element) => {
    if (element.kind === 'arrow') return `${element.id}: ${element.from} → ${element.to}${element.label ? ` "${element.label}"` : ''}`;
    if (element.kind === 'image') return `${element.id}: image "${element.label}" ${element.src}`;
    return `${element.id}: ${element.kind} "${element.label}"`;
  });
}

/** Human-readable changes between two versions of a canvas, such as `added box "Upload"`. */
export function diffCanvas(before: readonly CanvasElement[], after: readonly CanvasElement[]): string[] {
  const old = new Map(before.map((element) => [element.id, element]));
  const now = new Map(after.map((element) => [element.id, element]));
  const name = (element: CanvasElement, all: Map<string, CanvasElement>) =>
    element.kind === 'arrow' ? `arrow ${labelOf(all.get(element.from))} → ${labelOf(all.get(element.to))}` : `${element.kind} "${element.label}"`;
  const changes: string[] = [];

  for (const element of after) {
    const previous = old.get(element.id);
    if (!previous) changes.push(`added ${name(element, now)}`);
    else if (previous.label !== element.label) changes.push(`renamed "${previous.label}" to "${element.label}"`);
    else if (JSON.stringify(previous) !== JSON.stringify(element)) changes.push(`${element.kind === 'arrow' ? 'reconnected' : 'moved'} ${name(element, now)}`);
  }
  for (const element of before) if (!now.has(element.id)) changes.push(`removed ${name(element, old)}`);
  return changes;
}

function labelOf(element: CanvasElement | undefined): string {
  return element ? `"${element.label}"` : '?';
}

// ---------------------------------------------------------------------------
// Edits by AI agents

export interface CanvasOps {
  /** New shapes. They are placed automatically in free space. */
  add?: { kind?: ShapeKind; label: string }[];
  /** New arrows. `from` and `to` are element IDs or exact labels. */
  link?: { from: string; to: string; label?: string }[];
  relabel?: { id: string; label: string }[];
  /** Element IDs. Removing a shape also removes its arrows. */
  remove?: string[];
}

export interface CanvasOpsResult {
  elements: CanvasElement[];
  aspect: number;
  lines: string[];
  ok: boolean;
}

export function applyCanvasOps(elements: readonly CanvasElement[], aspect: number, ops: CanvasOps): CanvasOpsResult {
  let next = [...elements];
  let height = boardHeight(aspect);
  const lines: string[] = [];
  let ok = true;
  const fail = (line: string) => {
    lines.push(`✗ ${line}`);
    ok = false;
  };

  for (const id of ops.remove ?? []) {
    const element = next.find((candidate) => candidate.id === id);
    if (!element) {
      fail(`remove: no element ${id}`);
      continue;
    }
    next = next.filter((candidate) => candidate.id !== id && !(candidate.kind === 'arrow' && (candidate.from === id || candidate.to === id)));
    lines.push(`✓ removed ${id}`);
  }

  for (const { id, label } of ops.relabel ?? []) {
    const element = next.find((candidate) => candidate.id === id);
    if (!element) {
      fail(`relabel: no element ${id}`);
      continue;
    }
    next = next.map((candidate) => (candidate.id === id ? { ...candidate, label } : candidate));
    lines.push(`✓ renamed ${id} to "${label}"`);
  }

  for (const { kind = 'box', label } of ops.add ?? []) {
    const size = SHAPE_SIZE[kind];
    let spot = freeSpot(next, size, height);
    while (!spot) {
      height += 80; // make the board taller until the new shape fits
      spot = freeSpot(next, size, height);
    }
    const id = nextElementId(next);
    next.push({ id, kind, label, ...spot, ...size });
    lines.push(`✓ added ${id} ${kind} "${label}"`);
  }

  for (const { from, to, label = '' } of ops.link ?? []) {
    const source = findShape(next, from);
    const target = findShape(next, to);
    if (!source || !target) {
      fail(`link: no shape ${source ? to : from}`);
      continue;
    }
    const id = nextElementId(next);
    next.push({ id, kind: 'arrow', from: source.id, to: target.id, label });
    lines.push(`✓ linked ${source.id} → ${target.id} as ${id}`);
  }

  return { elements: next, aspect: BOARD_WIDTH / height, lines, ok };
}

function findShape(elements: readonly CanvasElement[], reference: string): FramedElement | undefined {
  const framed = elements.filter(isFramed);
  return framed.find((element) => element.id === reference) ?? framed.find((element) => element.label.toLowerCase() === reference.toLowerCase());
}

/** First grid position, reading left to right and top to bottom, where a shape fits without overlap. */
function freeSpot(elements: readonly CanvasElement[], size: { w: number; h: number }, height: number): { x: number; y: number } | null {
  const gap = 16;
  const framed = elements.filter(isFramed);
  for (let y = 20; y + size.h <= height - 12; y += 20) {
    for (let x = 20; x + size.w <= BOARD_WIDTH - 12; x += 20) {
      const clear = framed.every(
        (other) => x + size.w + gap <= other.x || other.x + other.w + gap <= x || y + size.h + gap <= other.y || other.y + other.h + gap <= y,
      );
      if (clear) return { x, y };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drawing

export interface Palette {
  ink: string;
  muted: string;
  line: string;
  fill: string;
  accent: string;
}

/** Colours for the SVG preview saved next to each canvas, which GitHub shows. */
const FILE_PALETTE: Palette = { ink: '#1f2328', muted: '#59636e', line: '#8c959f', fill: '#ffffff', accent: '#0969da' };

export interface RenderOptions {
  aspect: number;
  palette?: Palette;
  /** Elements drawn with a selection outline and a resize handle. */
  selected?: ReadonlySet<string>;
  /** An element whose label is hidden because it is being edited in place. */
  editing?: string;
  /** Turns an image's repo path into a URL the viewer can load. */
  imageUrl?: (src: string) => string;
}

/**
 * Draws a canvas as an SVG string. Every element is wrapped in `<g data-el="id">` and resize
 * handles carry `data-handle="id"`, which the editor uses to find what was clicked.
 */
export function renderCanvasSvg(elements: readonly CanvasElement[], options: RenderOptions): string {
  const palette = options.palette ?? FILE_PALETTE;
  const height = boardHeight(options.aspect);
  const shapes = new Map(elements.filter(isFramed).map((element) => [element.id, element]));
  const parts: string[] = [];

  for (const element of elements) {
    if (element.kind !== 'arrow') continue;
    const from = shapes.get(element.from);
    const to = shapes.get(element.to);
    if (from && to) parts.push(drawArrow(element, from, to, palette));
  }
  for (const element of shapes.values()) {
    parts.push(drawShape(element, palette, options));
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_WIDTH} ${height}" width="${BOARD_WIDTH}" height="${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">`,
    `<defs><marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${palette.line}"/></marker></defs>`,
    ...parts,
    '</svg>',
  ].join('');
}

function drawShape(element: FramedElement, palette: Palette, options: RenderOptions): string {
  // Elements are checked when read (canvasElements), and drawn safely anyway: the ID escaped, every
  // number a finite number, so nothing in an element can become markup.
  const id = escapeXml(element.id);
  const [x, y, w, h] = [element.x, element.y, element.w, element.h].map(finite) as [number, number, number, number];
  const stroke = `stroke="${palette.line}" stroke-width="1.2" fill="${palette.fill}"`;
  let outline = '';
  if (element.kind === 'box') outline = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ${stroke}/>`;
  if (element.kind === 'ellipse') outline = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${stroke}/>`;
  if (element.kind === 'diamond') {
    outline = `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${stroke}/>`;
  }
  if (element.kind === 'text') outline = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/>`;
  if (element.kind === 'image') {
    const href = escapeXml(options.imageUrl ? options.imageUrl(element.src) : element.src);
    outline = `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${palette.line}" stroke-width="0.8"/>`;
  }

  const label = element.kind === 'image' || options.editing === element.id ? '' : drawLabel({ ...element, x, y, w, h }, palette);
  const selection = options.selected?.has(element.id)
    ? `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="6" fill="none" stroke="${palette.accent}" stroke-width="1.2" stroke-dasharray="4 3"/>` +
      `<rect data-handle="${id}" x="${x + w - 3}" y="${y + h - 3}" width="10" height="10" rx="2" fill="${palette.accent}"/>`
    : '';
  return `<g data-el="${id}">${outline}${label}${selection}</g>`;
}

function drawLabel(element: CanvasShape, palette: Palette): string {
  const lines = wrapLabel(element.label, element.w - (element.kind === 'diamond' ? 28 : 12), Math.max(1, Math.floor((element.h - 6) / 15)));
  const top = element.y + element.h / 2 - ((lines.length - 1) * 15) / 2;
  return lines
    .map((line, i) => `<text x="${element.x + element.w / 2}" y="${top + i * 15}" text-anchor="middle" dominant-baseline="central" fill="${palette.ink}">${escapeXml(line)}</text>`)
    .join('');
}

function drawArrow(arrow: CanvasArrow, from: FramedElement, to: FramedElement, palette: Palette): string {
  const start = exitPoint(from, centre(to));
  const end = exitPoint(to, centre(from));
  const line = `<line x1="${round(start.x)}" y1="${round(start.y)}" x2="${round(end.x)}" y2="${round(end.y)}" stroke="${palette.line}" stroke-width="1.4" marker-end="url(#arrowhead)"/>`;
  // A wide transparent line makes thin arrows easy to click.
  const hit = `<line x1="${round(start.x)}" y1="${round(start.y)}" x2="${round(end.x)}" y2="${round(end.y)}" stroke="transparent" stroke-width="12"/>`;
  const label = arrow.label
    ? `<text x="${round((start.x + end.x) / 2)}" y="${round((start.y + end.y) / 2)}" text-anchor="middle" dominant-baseline="central" fill="${palette.muted}" font-size="11" stroke="${palette.fill}" stroke-width="4" paint-order="stroke">${escapeXml(arrow.label)}</text>`
    : '';
  return `<g data-el="${escapeXml(arrow.id)}">${hit}${line}${label}</g>`;
}

function centre(frame: Frame): { x: number; y: number } {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

/** Where a line from the shape's centre towards `target` crosses the shape's outline. */
function exitPoint(shape: FramedElement, target: { x: number; y: number }): { x: number; y: number } {
  const c = centre(shape);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (!dx && !dy) return c;
  const hw = shape.w / 2;
  const hh = shape.h / 2;
  let t: number;
  if (shape.kind === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (shape.kind === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Splits a label into lines that fit `width`, ending with … when it runs out of lines. */
function wrapLabel(label: string, width: number, maxLines: number): string[] {
  const perLine = Math.max(4, Math.floor(width / 6.4));
  const lines: string[] = [];
  let line = '';
  for (const word of label.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, perLine - 1)}…`;
  }
  return lines;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

function round(value: number): number {
  return Math.round(finite(value) * 10) / 10;
}

/** A number as it may be written into markup: anything that isn't a finite number becomes 0. */
function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
