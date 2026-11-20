/**
 * What the editor asks of a notebook, answered the same way wherever the notebook lives: its calls
 * (`/api/n/<notebook>/…`), its files, and the saves and updates on its live connection. Plain
 * values go in and out and nothing here is Node-only, so the laptop's server
 * (apps/inklog/src/server.ts) and the cloud serve the editor with this one module, and the two
 * can't drift apart. Each home keeps only what is its own: sign-in, address checks, the built
 * editor's files and its sockets.
 */
import { type Block, type NotebookOverview, type RepoInfo, type ServerMessage, estimateTokens, renderRead } from '@inklog/core';
import { ORGANIZE_OPS, mapText, organizeOps, toolList } from './agent.js';
import { type Engine, type SectionEvent, UserError } from './engine.js';
import { LAYOUT, checkPath } from './store.js';

export const MAX_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const FILE_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  json: 'application/json',
};
/**
 * A notebook's files can come from anywhere (an import, a pull), and an SVG can carry a script. In
 * an <img> it never runs, but opened on its own it would run with the editor's address, so every
 * file is served sandboxed, with nothing allowed to load or run.
 */
const FILE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/** One call from the editor, as plain values. */
export interface EditorCall {
  method: string;
  /** The address after `/api/n/<notebook>/`, still URL-encoded, such as `section` or `files/assets/9f2c41d0.png`. */
  path: string;
  query: URLSearchParams;
  contentType?: string;
  /** Reads the body, refusing more than `limit` bytes with a UserError. */
  body(limit: number): Promise<Uint8Array>;
}

export type EditorReply = { status: number; json: unknown } | { status: number; bytes: Uint8Array; headers: Record<string, string> };

export interface EditorApiOptions {
  /** Adds what only this home knows to the notebook's info, such as the laptop's remote access. */
  info?: (info: RepoInfo) => RepoInfo;
  /** The owner's AI instructions for every notebook, kept by the host (the cloud's library, from step 3.3). */
  sharedInstructions?: () => string | undefined;
}

/** `Connection` is how the host names one open editor, such as its WebSocket. */
export class EditorApi<Connection = unknown> {
  /** The editor whose save is being applied. It gets the result as its reply, not as an update. */
  private saving?: Connection;

  constructor(
    readonly engine: Engine,
    private readonly options: EditorApiOptions = {},
  ) {}

  info(): RepoInfo {
    const info = this.engine.info();
    return this.options.info ? this.options.info(info) : info;
  }

  /** Answers one call. Mistakes the person can fix come back as 400 and unknown calls as 404; anything else is thrown for the host to log. */
  async call(call: EditorCall): Promise<EditorReply> {
    try {
      if (call.method === 'GET' && call.path.startsWith('files/')) return await this.file(call.path.slice('files/'.length));
      return { status: 200, json: await this.answer(call) };
    } catch (error) {
      if (error instanceof NotFound) return { status: 404, json: { error: 'Not found.' } };
      if (error instanceof UserError || error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
        return { status: 400, json: { error: errorMessage(error) } };
      }
      throw error;
    }
  }

  private async answer(call: EditorCall): Promise<unknown> {
    const query = (name: string) => call.query.get(name) ?? '';
    const engine = this.engine;
    switch (`${call.method} ${call.path}`) {
      case 'GET repo':
        return this.info();
      case 'GET overview': {
        const last = await engine.lastCommits();
        return { last: Object.fromEntries(last) } satisfies NotebookOverview;
      }
      case 'POST visit':
        // The bell's "since your last visit": when the person opened the notebook before.
        return { before: engine.personVisit() ?? null };
      case 'POST details': {
        const { name, about, colour } = await readJson<{ name?: unknown; about?: unknown; colour?: unknown }>(call);
        const text = (value: unknown) => (value === undefined ? undefined : String(value));
        return { commit: (await engine.setDetails({ name: text(name), about: text(about), colour: text(colour) })) ?? null };
      }
      case 'GET section': {
        const section = engine.section(query('id'));
        if (!section) throw new UserError(`No section "${query('id')}".`);
        return section;
      }
      case 'GET snapshot':
        return { sections: Object.fromEntries(await engine.snapshot(query('commit'))) };
      case 'GET agent-view': {
        const section = engine.section(query('section'));
        const instructions = engine.instructionsText(this.options.sharedInstructions?.());
        return { map: `${instructions ? `${instructions}\n\n` : ''}${mapText(engine)}`, read: section ? renderRead({ id: query('section'), blocks: section.blocks }) : '', tools: toolList() };
      }
      case 'GET instructions': {
        // What an AI gets, exactly, and its rough cost in every map.
        const given = engine.instructionsText(this.options.sharedInstructions?.());
        return { text: engine.instructions(), given, tokens: estimateTokens(given) };
      }
      case 'POST instructions': {
        const { text } = await readJson<{ text?: unknown }>(call);
        if (typeof text !== 'string') throw new UserError('Send the instructions as text.');
        await engine.setInstructions(text);
        return { ok: true };
      }
      case 'GET history':
        // The commits that changed one section, newest first, for the History panel's "This section".
        return { commits: (await engine.sectionHistory(query('section'), 1000)).map((commit) => commit.oid) };
      case 'GET commit':
        // What a commit changed, for its row in the History panel.
        return await engine.commitDetails(query('commit'));
      case 'POST undo': {
        const { commit } = await readJson<{ commit?: unknown }>(call);
        return { lines: await engine.undoCommit(String(commit ?? '')) };
      }
      case 'POST sections': {
        const { title, folder } = await readJson<{ title?: unknown; folder?: unknown }>(call);
        return { id: await engine.createSection(String(title ?? ''), folder === undefined ? '' : String(folder)) };
      }
      case 'POST organize': {
        const { ops } = await readJson<{ ops?: unknown }>(call);
        return await engine.organize(organizeOps(ORGANIZE_OPS.parse(ops)), PERSON);
      }
      case 'POST delete': {
        const { section, folder } = await readJson<{ section?: unknown; folder?: unknown }>(call);
        if (typeof section === 'string') await engine.deleteSection(section);
        else if (typeof folder === 'string') return { sections: await engine.deleteFolder(folder) };
        else throw new UserError('Say which section or folder to delete.');
        return { ok: true };
      }
      case 'POST commit': {
        const { message } = await readJson<{ message?: unknown }>(call);
        return { commit: (await engine.commit(String(message ?? ''))) ?? null };
      }
      case 'POST include': {
        const { section, key, included } = await readJson<{ section?: unknown; key?: unknown; included?: unknown }>(call);
        engine.setIncluded(String(section), String(key), Boolean(included));
        return { ok: true };
      }
      case 'POST held': {
        const { index, approve } = await readJson<{ index?: unknown; approve?: unknown }>(call);
        if (approve) return { commit: (await engine.approveHeld(Number(index))) ?? null };
        engine.rejectHeld(Number(index));
        return { ok: true };
      }
      case 'POST assets': {
        const extension = IMAGE_EXTENSIONS[call.contentType ?? ''];
        if (!extension) throw new UserError('Only PNG, JPEG, GIF, WebP and SVG images can be added.');
        return { src: await engine.addAsset(await call.body(MAX_IMAGE_BYTES), extension) };
      }
      default:
        throw new NotFound();
    }
  }

  /** An image or drawing from the notebook's store, so it works wherever the notebook lives. */
  private async file(encoded: string): Promise<EditorReply> {
    let rel: string;
    try {
      rel = checkPath(decodeURIComponent(encoded));
    } catch {
      throw new NotFound(); // not a path inside the notebook
    }
    const folder = rel.split('/')[0];
    const type = FILE_TYPES[rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()];
    const bytes = (folder === LAYOUT.assets || folder === LAYOUT.canvas) && type ? await this.engine.repo.readBytes(rel) : undefined;
    if (!bytes) throw new NotFound();
    // Assets are named by their content, so they never change.
    const cache = folder === LAYOUT.assets ? 'max-age=31536000, immutable' : 'no-cache';
    return { status: 200, bytes, headers: { 'content-type': type!, 'cache-control': cache, 'content-security-policy': FILE_POLICY, 'x-content-type-options': 'nosniff' } };
  }

  /**
   * Answers a message from an editor's live connection, `from`. Returns the reply for that editor,
   * or nothing for a message that isn't a save.
   */
  receive(text: string, from: Connection): ServerMessage | undefined {
    let message: { type?: unknown; request?: unknown; section?: unknown; base?: unknown; blocks?: unknown } | null;
    try {
      message = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (message?.type !== 'save') return undefined;
    const request = Number(message.request);
    try {
      if (!isBlockList(message.blocks)) throw new UserError('That save was not a list of blocks.');
      const section = String(message.section);
      this.saving = from;
      // A base that isn't a version string can't be placed; the engine answers it as stale.
      const reply = this.engine.save(section, typeof message.base === 'string' ? message.base : '', message.blocks);
      return { type: 'saved', request, section, ...reply };
    } catch (error) {
      return { type: 'error', request, error: errorMessage(error) };
    } finally {
      this.saving = undefined;
    }
  }

  /**
   * Calls `send` with every update open editors should get: a section changed elsewhere, or the
   * notebook's info. `except` is the editor whose save caused the update; it already has the
   * result as its reply. Returns a function that stops the updates.
   */
  listen(send: (message: ServerMessage, except?: Connection) => void): () => void {
    const onSection = (event: SectionEvent) => send({ type: 'section', section: event.id, version: event.version, blocks: event.blocks, actor: event.actor }, this.saving);
    const onRepo = () => send({ type: 'repo', info: this.info() });
    this.engine.on('section', onSection).on('repo', onRepo);
    return () => void this.engine.off('section', onSection).off('repo', onRepo);
  }
}

/** The editor acts for the person. */
const PERSON = { kind: 'person' } as const;

class NotFound extends Error {}

async function readJson<T>(call: EditorCall): Promise<T> {
  const value: unknown = JSON.parse(new TextDecoder().decode(await call.body(MAX_JSON_BYTES)) || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('Send a JSON object.');
  return value as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBlockList(value: unknown): value is Block[] {
  return (
    Array.isArray(value) &&
    value.every((block) => block && typeof block === 'object' && typeof block.id === 'string' && typeof block.type === 'string' && typeof block.text === 'string')
  );
}
