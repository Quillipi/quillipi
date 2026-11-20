/**
 * The docs folder on disk: the working files and their Git history. This is the only module
 * that reads or writes the folder, so the rest of the program works with plain values.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Person } from '@inklog/core';
import git from 'isomorphic-git';
import { type CommitRecord, type FileChanges, type NotebookStore, checkPath } from '@inklog/engine';

interface TreeFile {
  oid: string;
  mode: string;
}

/** A notebook as a folder of files with Git history: the store on a laptop. */
export class RepoFiles implements NotebookStore {
  constructor(readonly dir: string) {}

  private full(rel: string): string {
    return path.join(this.dir, ...checkPath(rel).split('/'));
  }

  // -------------------------------------------------------------------------
  // Working files

  async read(rel: string): Promise<string | undefined> {
    try {
      return await fsp.readFile(this.full(rel), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async readBytes(rel: string): Promise<Uint8Array | undefined> {
    try {
      return await fsp.readFile(this.full(rel));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Writes through a temporary file and a rename, so a crash never leaves half a file. */
  async write(rel: string, content: string | Uint8Array): Promise<void> {
    const file = this.full(rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, content);
    // On Windows, a virus scanner or search indexer can hold a file for a moment; try again briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        return await fsp.rename(temporary, file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
      }
    }
  }

  /** Adds text to the end of a file, creating it if needed. For local logs that only grow. */
  async append(rel: string, text: string): Promise<void> {
    const file = this.full(rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, text);
  }

  /**
   * Removes a file, and then the directories it leaves empty, as Git does, so a folder that was
   * renamed or emptied doesn't linger. Top-level directories such as `sections/` stay.
   */
  async remove(rel: string): Promise<void> {
    const root = path.resolve(this.dir);
    const file = path.resolve(this.full(rel));
    await fsp.rm(file, { force: true });
    for (let dir = path.dirname(file); dir !== root && path.dirname(dir) !== root; dir = path.dirname(dir)) {
      try {
        await fsp.rmdir(dir); // only succeeds when empty
      } catch {
        return;
      }
    }
  }

  /** Files under `relDir` with the given extension, as repo-relative paths. */
  async list(relDir: string, extension: string): Promise<string[]> {
    const root = this.full(relDir);
    if (!fs.existsSync(root)) return [];
    const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.relative(this.dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
  }

  // -------------------------------------------------------------------------
  // History

  async init(person: Person): Promise<void> {
    await git.init({ fs, dir: this.dir, defaultBranch: 'main' });
    await git.setConfig({ fs, dir: this.dir, path: 'user.name', value: person.name });
    await git.setConfig({ fs, dir: this.dir, path: 'user.email', value: person.email });
  }

  async isRepo(): Promise<boolean> {
    return fs.existsSync(path.join(this.dir, '.git'));
  }

  /** The person commits are made as, from the folder's Git settings. */
  async person(): Promise<Person> {
    const name = await git.getConfig({ fs, dir: this.dir, path: 'user.name' });
    const email = await git.getConfig({ fs, dir: this.dir, path: 'user.email' });
    return { name: String(name ?? 'You'), email: String(email ?? 'you@localhost') };
  }

  async head(): Promise<string | undefined> {
    try {
      return await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' });
    } catch {
      return undefined; // no commits yet
    }
  }

  async log(limit = 1000): Promise<CommitRecord[]> {
    if (!(await this.head())) return [];
    const entries = await git.log({ fs, dir: this.dir, depth: limit });
    return entries.map(({ oid, commit }) => ({
      oid,
      message: commit.message.trimEnd(),
      author: commit.author.name,
      at: commit.author.timestamp * 1000,
      parent: commit.parent[0],
    }));
  }

  /** Every file in a commit, with the ID of its content. */
  async filesAt(commit: string): Promise<Map<string, string>> {
    const files = await this.treeFiles(commit);
    return new Map([...files].map(([rel, file]) => [rel, file.oid]));
  }

  async readAt(commit: string, rel: string): Promise<string | undefined> {
    try {
      const { blob } = await git.readBlob({ fs, dir: this.dir, oid: commit, filepath: rel });
      return new TextDecoder().decode(blob);
    } catch {
      return undefined;
    }
  }

  /**
   * Commits exactly the given changes on top of HEAD, without touching the working files.
   * This is what makes partial commits possible: the committed version of a file can
   * differ from the one on disk.
   */
  async commit(changes: FileChanges, message: string, author: Person): Promise<string> {
    const head = await this.head();
    const files = head ? await this.treeFiles(head) : new Map<string, TreeFile>();
    for (const [rel, content] of changes) {
      if (content === null) files.delete(rel);
      else {
        const blob = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        files.set(rel, { oid: await git.writeBlob({ fs, dir: this.dir, blob }), mode: '100644' });
      }
    }
    const tree = await this.writeTree(files, '');
    const oid = await git.commit({ fs, dir: this.dir, message, author, tree, parent: head ? [head] : [] });

    // Keep Git's index in step with the new commit, so Git tools show what was left out as
    // ordinary unstaged edits.
    for (const rel of changes.keys()) {
      await git.resetIndex({ fs, dir: this.dir, filepath: rel });
    }
    return oid;
  }

  private async treeFiles(commit: string): Promise<Map<string, TreeFile>> {
    const files = new Map<string, TreeFile>();
    const visit = async (oid: string, prefix: string) => {
      const { tree } = await git.readTree({ fs, dir: this.dir, oid });
      for (const entry of tree) {
        const rel = prefix + entry.path;
        if (entry.type === 'tree') await visit(entry.oid, `${rel}/`);
        else files.set(rel, { oid: entry.oid, mode: entry.mode });
      }
    };
    await visit(commit, '');
    return files;
  }

  /** Writes the trees for a flat list of files and returns the root tree's ID. */
  private async writeTree(files: Map<string, TreeFile>, prefix: string): Promise<string> {
    const entries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
    const folders = new Set<string>();
    for (const [rel, file] of files) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: file.mode, path: rest, oid: file.oid, type: 'blob' });
      else folders.add(rest.slice(0, slash));
    }
    for (const folder of folders) {
      entries.push({ mode: '040000', path: folder, oid: await this.writeTree(files, `${prefix}${folder}/`), type: 'tree' });
    }
    // Git orders entries by name, comparing folders as if their name ended in '/'.
    const key = (entry: (typeof entries)[number]) => (entry.type === 'tree' ? `${entry.path}/` : entry.path);
    entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return git.writeTree({ fs, dir: this.dir, tree: entries });
  }
}
