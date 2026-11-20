import { describe, expect, it } from 'vitest';
import { AGENTS_GUIDE, INSTRUCTIONS_END, agentInline, editorInline, parseInline, readInstructions, renderInstructions, writeInstructions } from '../src/index.js';
import { seeded } from './random.js';

describe('instructions in AGENTS.md', () => {
  it('are everything under the Instructions heading, whatever its case or line endings', () => {
    expect(readInstructions(undefined)).toBe('');
    expect(readInstructions('# Guide\n\nNo heading here.\n')).toBe('');
    expect(readInstructions('# Guide\r\n\r\n## instructions \r\n\r\nBe brief.\r\n\r\n- Say what you skipped.\r\n')).toBe('Be brief.\n\n- Say what you skipped.');
    expect(readInstructions(writeInstructions(undefined, 'Be brief.'))).toBe('Be brief.');
  });

  it('are written under the heading, keeping everything above it', () => {
    expect(writeInstructions(undefined, '')).toBe(AGENTS_GUIDE);
    const once = writeInstructions('# Mine\n\nKeep this.\n## Instructions\nOld.\n', 'New\n\nlines');
    expect(once).toBe('# Mine\n\nKeep this.\n## Instructions\n\nNew\n\nlines\n');
    expect(writeInstructions(once, readInstructions(once))).toBe(once);
  });

  it('reach agents marked as the owner’s, those for every notebook first, and not at all when empty', () => {
    expect(renderInstructions({ owner: 'Karan', shared: ' ', notebook: '' })).toBe('');
    expect(renderInstructions({ owner: 'Karan', notebook: 'Be brief.' })).toBe(
      `Instructions from Karan, who owns this notebook. Follow them in everything you do here.\n\nFor this notebook:\nBe brief.\n\n${INSTRUCTIONS_END}`,
    );
    expect(renderInstructions({ owner: 'Karan', shared: 'Never guess.', notebook: 'Be brief.' })).toMatch(/For every notebook:\nNever guess\.\n\nFor this notebook:\nBe brief\./);
  });
});

describe("the editor's form of inline text", () => {
  it("reads an agent's underscores inside words as underscores, as GitHub does", () => {
    const stored = agentInline('Uses create_section and snake_case_names, a__b, _real italic_, `code_x_y` and [a_b](https://x.io/a_b_c).');
    expect(stored).toBe('Uses create\\_section and snake\\_case\\_names, a\\_\\_b, _real italic_, `code_x_y` and [a\\_b](https://x.io/a_b_c).');
    expect(parseInline(stored).filter((run) => run.marks.includes('italic')).map((run) => run.text)).toEqual(['real italic']);
    expect(agentInline('*stars* and __bold__')).toBe('_stars_ and **bold**');
  });

  it('is reached in one step, for any text', () => {
    const random = seeded(32);
    const pieces = ['a', 'b c', '_', '*', '**', '~~', '==', '`', '[', ']', '(', ')', '\\', 'https://x.io/a_b', ' ', '  ', 'é', '#', '!'];
    for (let n = 0; n < 3000; n++) {
      const text = Array.from({ length: 1 + random.int(12) }, () => random.pick(pieces)).join('');
      const once = editorInline(text);
      expect(editorInline(once), JSON.stringify(text)).toBe(once);
      const agent = agentInline(text);
      expect(editorInline(agent), JSON.stringify(text)).toBe(agent);
    }
  });
});
