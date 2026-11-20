/** The app's addresses (step 3.4a), which need no browser. */
import { describe, expect, it } from 'vitest';
import { type Route, href, notebookOf, parseRoute } from '../src/router';

describe('addresses', () => {
  it('name every page, and read back as the same page', () => {
    const routes: Route[] = [
      { page: 'home' },
      { page: 'agents' },
      { page: 'notebook', id: 'gym-rollup', folder: '' },
      { page: 'notebook', id: 'gym-rollup', folder: 'research/pricing notes' },
      { page: 'section', id: 'gym-rollup', section: 'plan' },
    ];
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route);
    expect(href({ page: 'notebook', id: 'gym-rollup', folder: 'research/pricing notes' })).toBe('/n/gym-rollup/f/research/pricing%20notes');
  });

  it('keep the addresses of earlier steps working, and know nothing else', () => {
    expect(parseRoute('/n/inklog')).toEqual({ page: 'notebook', id: 'inklog', folder: '' });
    expect(parseRoute('/n/inklog/')).toEqual({ page: 'notebook', id: 'inklog', folder: '' });
    for (const unknown of ['/settings', '/n', '/n/x/s', '/n/x/s/a/b', '/n/x/q/a', '/n/%E0%A4%A']) expect(parseRoute(unknown)).toEqual({ page: 'unknown' });
    expect(notebookOf(parseRoute('/n/x/s/a'))).toBe('x');
    expect(notebookOf(parseRoute('/agents'))).toBeUndefined();
  });
});
