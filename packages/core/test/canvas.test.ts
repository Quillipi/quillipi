/**
 * Canvases read from a file or an editor, and drawn into a page: nothing in an element may become
 * markup (security audit of 2026-11-20).
 */
import { describe, expect, it } from 'vitest';
import { type CanvasElement, canvasElements, renderCanvasSvg } from '../src/canvas.js';

const BOX = { id: 'k1', kind: 'box', label: 'Upload', x: 20, y: 20, w: 112, h: 44 };
const DIAMOND = { id: 'k2', kind: 'diamond', label: 'Match?', x: 180, y: 20, w: 108, h: 64 };
const ARROW = { id: 'k3', kind: 'arrow', from: 'k1', to: 'k2', label: 'then' };
const IMAGE = { id: 'k4', kind: 'image', src: 'assets/9f2c41d0.png', label: 'Screen', x: 20, y: 100, w: 140, h: 100 };
const BREAKOUT = '"><img src=x onerror=alert(document.domain)>';

describe('reading a canvas', () => {
  it('keeps well-formed elements as they are', () => {
    expect(canvasElements([BOX, DIAMOND, ARROW, IMAGE])).toEqual([BOX, DIAMOND, ARROW, IMAGE]);
  });

  it('leaves out an element that could break out of the markup or isn’t one', () => {
    const bad = [
      { ...BOX, id: `k9${BREAKOUT}` },
      { ...BOX, id: 'k10', x: `1${BREAKOUT}` },
      { ...BOX, id: 'k11', w: Number.POSITIVE_INFINITY },
      { ...BOX, id: 'k12', h: 0 },
      { ...BOX, id: 'k13', kind: 'script' },
      { ...BOX, id: 'k14', label: { toString: () => BREAKOUT } },
      { ...IMAGE, id: 'k15', src: 'javascript:alert(1)' },
      { ...IMAGE, id: 'k16', src: '../../.inklog/connections.json' },
      { ...IMAGE, id: 'k17', src: '/etc/passwd' },
      { ...ARROW, id: 'k18', from: BREAKOUT },
      null,
      'k19',
    ];
    expect(canvasElements([BOX, ...bad])).toEqual([BOX]);
  });

  it('drops arrows whose ends are missing, keeps the first of two elements with one ID, and cuts long labels', () => {
    const elements = canvasElements([BOX, ARROW, { ...BOX, label: 'Second k1' }, { ...DIAMOND, label: 'x'.repeat(5000) }]);
    expect(elements.map((element) => element.id)).toEqual(['k1', 'k3', 'k2']);
    expect((elements[2] as { label: string }).label).toHaveLength(2000);
    expect(canvasElements([BOX, ARROW])).toEqual([BOX]);
  });

  it('reads anything that isn’t a list as an empty canvas', () => {
    for (const value of [undefined, null, {}, 'k1', 7]) expect(canvasElements(value)).toEqual([]);
  });
});

describe('drawing a canvas', () => {
  it('escapes IDs and writes only finite numbers, even for elements that were never checked', () => {
    const unchecked = [
      { ...BOX, id: `k1${BREAKOUT}`, x: `1${BREAKOUT}` },
      { ...ARROW, id: `k3${BREAKOUT}`, from: `k1${BREAKOUT}` },
      { ...DIAMOND, label: BREAKOUT },
    ] as unknown as CanvasElement[];
    const svg = renderCanvasSvg(unchecked, { aspect: 1.6, selected: new Set([`k1${BREAKOUT}`]) });
    // Every tag in the drawing is one the renderer writes itself; the rest arrived as text.
    const tags = new Set([...svg.matchAll(/<\/?([a-zA-Z]+)/g)].map((match) => match[1]));
    expect([...tags].sort()).toEqual(['defs', 'g', 'line', 'marker', 'path', 'polygon', 'rect', 'svg', 'text']);
    expect(svg).toContain('data-el="k1&quot;&gt;&lt;img');
    expect(svg).toContain('data-handle="k1&quot;&gt;&lt;img');
  });
});
