/** `quillipi init` and `quillipi import`: creating a docs folder and bringing Markdown into one. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Person, addFrontMatterId, frontMatterId, parseSection, slugify, uniqueName } from '@inklog/core';
import { Engine, LAYOUT, UserError, initNotebook, sectionFile } from '@inklog/engine';
import { RepoFiles } from './repo.js';

export async function initFolder(dir: string, given: Partial<Person> = {}, options = { starterSection: true }): Promise<void> {
  const repo = new RepoFiles(dir);
  if ((await repo.read(LAYOUT.meta)) !== undefined) throw new UserError(`${dir} is already a Quillipi folder.`);
  fs.mkdirSync(dir, { recursive: true });
  const person = resolvePerson(given);
  if (!(await repo.isRepo())) await repo.init(person);
  await initNotebook(repo, { name: path.basename(path.resolve(dir)), person, starterSection: options.starterSection });
}

/** Opens the notebook in a folder on this computer. */
export async function openFolder(dir: string): Promise<Engine> {
  const repo = new RepoFiles(dir);
  if (!(await repo.isRepo()) || (await repo.read(LAYOUT.meta)) === undefined) {
    throw new Error(`${dir} is not a Quillipi folder. Run "quillipi init" there first.`);
  }
  return Engine.fromStore(repo, path.basename(dir));
}

/**
 * Copies Markdown files into a docs folder (creating it if needed) and commits them with block IDs.
 * Subfolders become folders; each file becomes a section whose ID comes from its name, made unique
 * in the notebook. A file whose place is already taken, as when importing the same folder twice, is skipped.
 */
export async function importMarkdown(from: string, dir: string): Promise<{ imported: string[]; skipped: string[] }> {
  const source = path.resolve(from);
  if (!fs.existsSync(source)) throw new UserError(`There is no folder ${from}.`);
  const repo = new RepoFiles(dir);
  if ((await repo.read(LAYOUT.meta)) === undefined) await initFolder(dir, {}, { starterSection: false });

  const ids = new Set<string>();
  for (const rel of await repo.list(LAYOUT.sections, '.md')) {
    const id = frontMatterId(parseSection((await repo.read(rel)) ?? '').frontMatter);
    if (id) ids.add(id);
  }
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const file of markdownFiles(source)) {
    const parts = path.relative(source, file).split(path.sep);
    const folder = parts
      .slice(0, -1)
      .map((part) => uniqueName(slugify(part) || 'folder', () => false))
      .join('/');
    const stem = uniqueName(slugify(parts.at(-1)!.replace(/\.(md|markdown)$/i, '')) || 'untitled', () => false);
    if ((await repo.read(sectionFile(folder, stem))) !== undefined) {
      skipped.push(folder ? `${folder}/${stem}` : stem);
      continue;
    }
    // The file keeps its own name, so importing the same folder again finds it and skips it.
    const id = uniqueName(stem, (name) => ids.has(name));
    ids.add(id);
    await repo.write(sectionFile(folder, stem), addFrontMatterId(fs.readFileSync(file, 'utf8'), id));
    imported.push(folder ? `${folder}/${id}` : id);
  }

  if (imported.length) {
    const engine = await openFolder(dir);
    await engine.flush(); // writes the files back in Quillipi's format, with IDs
    await engine.commit(`Import ${imported.length} document${imported.length === 1 ? '' : 's'}`);
  }
  return { imported, skipped };
}

function markdownFiles(root: string): string[] {
  const skip = new Set(['.git', '.inklog', 'node_modules']);
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !path.relative(root, file).split(path.sep).some((part) => skip.has(part)))
    .sort();
}

/** The name and email for commits: what was given, else the global Git settings, else the system user. */
function resolvePerson(given: Partial<Person>): Person {
  const user = os.userInfo().username;
  return {
    name: given.name ?? globalGitSetting('user.name') ?? user,
    email: given.email ?? globalGitSetting('user.email') ?? `${user}@users.noreply.inklog.local`,
  };
}

function globalGitSetting(key: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--global', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined; // Git isn't installed or the setting isn't there; Quillipi doesn't need Git itself
  }
}
