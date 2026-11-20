/** Starting a new notebook in any store: the files every notebook begins with, in one first commit. */
import { AGENTS_GUIDE, type Block, type Person, aboutLine, isNotebookColour, metaFile, newId, plainInline, serializeSection, slugify, titleCase, withFrontMatterId } from '@inklog/core';
import { UserError, sectionFile } from './engine.js';
import { LAYOUT, type NotebookStore } from './store.js';

/**
 * Git on Windows turns line endings into CRLF in the working files and warns on every commit; with
 * this, every computer keeps the Unix endings Quillipi writes, and Git stays quiet.
 */
const GITATTRIBUTES = `# Unix line endings on every computer, as Quillipi writes them.\n* text=auto eol=lf\n`;

export interface NewNotebook {
  name: string;
  person: Person;
  /** Adds a first section: Overview with the notebook's name as its heading, as `quillipi init` makes. */
  starterSection?: boolean;
  /**
   * Starts with an About section instead, as the cloud's New notebook does (designed in step 3.1,
   * so it doesn't clash with the notebook's overview page): a heading and the line about what the
   * notebook is for, if there is one.
   */
  starter?: 'overview' | 'about';
  /** One line on what the notebook is for, kept in inklog.json. */
  about?: string;
  /** Its colour, `#rrggbb`, kept in inklog.json. */
  colour?: string;
}

export async function initNotebook(store: NotebookStore, { name, person, starterSection = true, starter = 'overview', about, colour }: NewNotebook): Promise<void> {
  if ((await store.read(LAYOUT.meta)) !== undefined) throw new UserError('This is already a Quillipi notebook.');
  const line = about === undefined ? '' : aboutLine(about);
  if (colour !== undefined && !isNotebookColour(colour)) throw new UserError(`"${colour}" is not a colour; give one as #rrggbb.`);
  const first = starterSection ? starter : undefined;
  const gitignore = (await store.read('.gitignore')) ?? '';
  const details = { name, ...(line ? { about: line } : {}), ...(colour ? { colour } : {}) };
  const files = new Map<string, string>([
    [LAYOUT.meta, metaFile(details, first ? [first] : [])],
    [LAYOUT.agents, AGENTS_GUIDE],
    ['.gitignore', gitignore.includes(`${LAYOUT.local}/`) ? gitignore : `${gitignore}${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}${LAYOUT.local}/\n`],
    ['.gitattributes', (await store.read('.gitattributes')) ?? GITATTRIBUTES],
  ]);
  if (first) {
    const blocks: Block[] =
      first === 'about'
        ? [{ id: newId(), type: 'h1', text: 'About' }, ...(line ? [{ id: newId(), type: 'p' as const, text: plainInline(line) }] : [])]
        : [{ id: newId(), type: 'h1', text: plainInline(titleCase(name)) }];
    files.set(sectionFile('', first), serializeSection({ blocks, frontMatter: withFrontMatterId(undefined, first) }));
  }
  for (const [rel, content] of files) await store.write(rel, content);
  await store.commit(new Map(files), `Start ${name}`, person);
}

/** A notebook's ID, made from its name: its address (`/n/<id>`); lowercase letters, digits and hyphens. */
export function notebookId(name: string): string {
  return slugify(name) || 'notebook';
}

