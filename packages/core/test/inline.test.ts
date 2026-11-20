import { describe, expect, it } from 'vitest';
import { type Mark, type Run, inlineToPlain, normalizeRuns, parseInline, serializeInline } from '../src/inline.js';
import { seeded } from './random.js';

const run = (text: string, marks: Mark[] = [], href?: string): Run => (href ? { text, marks, href } : { text, marks });

describe('parseInline', () => {
  it('reads every mark', () => {
    expect(parseInline('a **b** _c_ ~~d~~ ==e== `f` [g](https://x.y)')).toEqual([
      run('a '),
      run('b', ['bold']),
      run(' '),
      run('c', ['italic']),
      run(' '),
      run('d', ['strike']),
      run(' '),
      run('e', ['highlight']),
      run(' '),
      run('f', ['code']),
      run(' '),
      run('g', [], 'https://x.y'),
    ]);
  });

  it('reads nested marks, including runs of three stars', () => {
    expect(parseInline('**bold _both_**')).toEqual([run('bold ', ['bold']), run('both', ['bold', 'italic'])]);
    expect(parseInline('**a *b***')).toEqual([run('a ', ['bold']), run('b', ['bold', 'italic'])]);
  });

  it('reads Markdown from other tools', () => {
    expect(parseInline('*it* __bold__')).toEqual([run('it', ['italic']), run(' '), run('bold', ['bold'])]);
  });

  it('treats escapes, unclosed delimiters and code contents as text', () => {
    expect(parseInline('\\*not bold\\* and **open')).toEqual([run('*not bold* and **open')]);
    expect(parseInline('`a **b** c`')).toEqual([run('a **b** c', ['code'])]);
    expect(parseInline('`` a`b ``')).toEqual([run('a`b', ['code'])]);
  });

  it('keeps underscores inside words that were escaped', () => {
    expect(inlineToPlain('snake\\_case\\_name')).toBe('snake_case_name');
  });
});

describe('serializeInline', () => {
  it('writes marks with canonical delimiters', () => {
    expect(serializeInline([run('a'), run('b', ['bold', 'italic']), run('c', ['italic'])])).toBe('a**_b_**_c_');
  });

  it('escapes characters that would read as formatting', () => {
    expect(serializeInline([run('2 * 3 = 6, a_b, [x], `y`, ~~z~~, a==b')])).toBe('2 \\* 3 = 6, a\\_b, \\[x\\], \\`y\\`, \\~\\~z\\~\\~, a\\=\\=b');
  });

  it('moves spaces at the edges of formatting outside it', () => {
    expect(serializeInline([run('see '), run('this ', ['bold']), run('now')])).toBe('see **this** now');
  });

  it('writes code spans that contain backticks', () => {
    expect(serializeInline([run('a`b', ['code'])])).toBe('``a`b``');
    expect(serializeInline([run('`', ['code'])])).toBe('`` ` ``');
  });

  it('encodes spaces and parentheses in links', () => {
    expect(serializeInline([run('doc', [], 'https://x.y/a b(1)')])).toBe('[doc](https://x.y/a%20b%281%29)');
    expect(parseInline('[doc](https://x.y/a%20b%281%29)')).toEqual([run('doc', [], 'https://x.y/a b(1)')]);
  });
});

describe('round trip', () => {
  const alphabet = ['a', 'b', 'Z', '7', ' ', '*', '_', '`', '[', ']', '(', ')', '\\', '~', '=', '#', '!', '|', '^', '-', '.', 'é'];
  const markSets: Mark[][] = [[], [], ['bold'], ['italic'], ['bold', 'italic'], ['strike'], ['highlight'], ['code'], ['bold', 'code'], ['italic', 'strike', 'highlight']];

  function randomRuns(random: ReturnType<typeof seeded>, edgeSpaces: boolean): Run[] {
    const runs: Run[] = [];
    for (let i = 0, n = 1 + random.int(6); i < n; i++) {
      let text = Array.from({ length: 1 + random.int(7) }, () => random.pick(alphabet)).join('');
      const marks = random.pick(markSets);
      // Spaces at the edges of formatted text are moved outside it on purpose; see the next test.
      if (!edgeSpaces && marks.length && !marks.includes('code')) text = text.trim() || 'x';
      runs.push(run(text, marks, random.next() < 0.15 ? 'https://example.com/p' : undefined));
    }
    return runs;
  }

  it('parse(serialize(runs)) gives back the same runs', () => {
    const random = seeded(1);
    for (let i = 0; i < 5000; i++) {
      const runs = normalizeRuns(randomRuns(random, false));
      // Links can't hold edge spaces either, so compare what a reader would see.
      const source = serializeInline(runs);
      const back = parseInline(source);
      expect(serializeInline(back), source).toBe(source);
      expect(back.map((r) => r.text).join(''), source).toBe(runs.map((r) => r.text).join(''));
    }
  });

  it('writing is stable: serialize(parse(serialize(runs))) equals serialize(runs)', () => {
    const random = seeded(2);
    for (let i = 0; i < 5000; i++) {
      const source = serializeInline(randomRuns(random, true));
      expect(serializeInline(parseInline(source)), source).toBe(source);
    }
  });

  it('keeps marks exactly when there are no edge spaces or links', () => {
    const random = seeded(3);
    for (let i = 0; i < 5000; i++) {
      const runs = normalizeRuns(randomRuns(random, false).map((r) => run(r.text, r.marks)));
      expect(parseInline(serializeInline(runs)), serializeInline(runs)).toEqual(runs);
    }
  });
});
