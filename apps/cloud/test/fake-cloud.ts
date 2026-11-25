/**
 * A stand-in for the cloud's Durable Objects in Node: the real library and real notebook rooms,
 * each on its own SQLite database, reaching each other the way the Worker's namespaces do. With a
 * FakeGitHub, every room has its GitHub mirror, and `runAlarms` plays the rooms' alarms.
 */
import type { NotebookSummary, ServerMessage } from '@inklog/core';
import { DurableStore } from '../src/durable-store.js';
import { answerEditor } from '../src/editor-door.js';
import { GitHubApp } from '../src/github.js';
import { Library } from '../src/library.js';
import { Mirror } from '../src/mirror.js';
import { type NewNotebookDetails, NotebookHost, type RoomContext } from '../src/notebook-host.js';
import type { Settings } from '../src/settings.js';
import type { FakeGitHub } from './fake-github.js';
import { nodeSql } from './node-sql.js';

export const OWNER = { name: 'The Octocat', email: '583231+OctoCat@users.noreply.github.com' };

interface Room {
  host: NotebookHost;
  /** Times the room asked its alarm for, not yet run. */
  alarms: number[];
  /** What the room told its open editors, and which editor each message skipped. */
  broadcasts: { message: ServerMessage; except?: unknown }[];
}

export interface FakeCloudOptions {
  github?: FakeGitHub;
  /** The time, which running an alarm moves forward to when it was due. */
  clock?: { now: number };
  /** Answers tool calls in place of the rooms, to test routing alone. */
  answer?: (id: string, agent: string, tool: string, args: unknown) => string;
  /** The Worker's own variables and secrets, which the library sees too and copies when it opens. */
  worker?: Settings;
}

export class FakeCloud {
  readonly library: Library;
  readonly rooms = new Map<string, Room>();
  /** Tool calls that reached a room: notebook, agent, tool, arguments, and the shared instructions when there are some. */
  readonly calls: unknown[][] = [];
  /** What the library added to each call that reached a room, in the same order. */
  readonly contexts: RoomContext[] = [];
  readonly reports: { id: string; summary: NotebookSummary }[] = [];
  /** How many times the Worker asked the library for the settings it doesn't hold. */
  settingsAsked = 0;
  private readonly app?: GitHubApp;

  constructor(private readonly options: FakeCloudOptions = {}) {
    const { github } = options;
    this.clock = options.clock ?? { now: Date.now() };
    if (github) this.app = new GitHubApp({ appId: github.appId, privateKey: github.privateKey, owner: github.owner, fetch: github.fetch, now: this.now });
    this.library = new Library(nodeSql(), {
      rooms: { create: (id, details) => this.room(id).host.create(details), adopt: (id) => this.room(id).host.adopt() },
      now: this.now,
    });
    // As the library's Durable Object does when it opens (library-object.ts).
    this.library.keepSettings(options.worker ?? {});
  }

  readonly clock: { now: number };
  readonly now = (): number => this.clock.now;

  /** The Worker's bindings for the library and the rooms. */
  get bindings(): { LIBRARY: unknown; NOTEBOOK: unknown } {
    const library = this.library;
    return {
      LIBRARY: {
        idFromName: (name: string) => name,
        get: () => ({
          ...libraryStub(library),
          settings: async () => {
            this.settingsAsked++;
            return library.settings();
          },
          settingsView: async () => library.settingsView(this.options.worker ?? {}),
        }),
      },
      NOTEBOOK: { idFromName: (name: string) => name, get: (id: string) => this.stub(id) },
    };
  }

  /** A room, made on first use as Cloudflare makes a Durable Object. */
  room(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      const store = new DurableStore(nodeSql(), OWNER);
      const alarms: number[] = [];
      const broadcasts: Room['broadcasts'] = [];
      const schedule = async (time: number) => void alarms.push(time);
      const mirror = this.app && new Mirror({ app: this.app, store, notebook: id, schedule, now: this.now, description: async () => 'A test notebook' });
      const host = new NotebookHost(store, id, OWNER, mirror, {
        report: async (summary) => {
          this.reports.push({ id, summary });
          this.library.update(id, summary);
        },
        schedule,
        broadcast: (message, except) => void broadcasts.push({ message, except }),
        now: this.now,
      });
      room = { host, alarms, broadcasts };
      this.rooms.set(id, room);
    }
    return room;
  }

  /**
   * Runs the rooms' alarms in time order until none is due by `until`, moving the clock to each,
   * as Cloudflare would. A room has one alarm: when it rings, everything it was asked for is
   * cleared, and the room asks again for whatever is still to do.
   */
  async runAlarms(until = Infinity): Promise<void> {
    for (let round = 0; round < 500; round++) {
      const next = [...this.rooms.values()].filter((room) => room.alarms.length).sort((a, b) => Math.min(...a.alarms) - Math.min(...b.alarms))[0];
      if (!next || Math.min(...next.alarms) > until) return;
      this.clock.now = Math.max(this.clock.now, Math.min(...next.alarms));
      next.alarms.length = 0;
      await next.host.alarm();
    }
    throw new Error('The alarms kept asking for more.');
  }

  private stub(id: string) {
    return {
      runTool: async (notebook: string, agent: string, tool: string, args: unknown, context: RoomContext = {}) => {
        this.calls.push([notebook, agent, tool, args, ...(context.shared ? [context.shared] : [])]);
        this.contexts.push(context);
        return this.options.answer ? this.options.answer(notebook, agent, tool, args) : this.room(notebook).host.runTool(agent, tool, args, context);
      },
      create: (notebook: string, details: NewNotebookDetails) => this.room(notebook).host.create(details),
      adopt: (notebook: string) => this.room(notebook).host.adopt(),
      status: (notebook: string) => this.room(notebook).host.status(),
      retryMirror: async (notebook: string) => this.room(notebook).host.mirror?.retry() ?? 'No mirror.',
      ping: async () => 'ok',
      /** The editor's calls, as the room's Durable Object answers them (editor-door.ts). */
      fetch: (request: Request) => answerEditor(this.room(id).host, request, async () => this.library.instructions()),
    };
  }
}

/** The library as the Worker reaches it: every call answered later, as a call to another object is. */
function libraryStub(library: Library) {
  return {
    directory: async () => library.directory(),
    route: async (name?: string, withDirectory?: boolean) => library.route(name, withDirectory),
    create: (details: Parameters<Library['create']>[0]) => library.create(details),
    add: (details: Parameters<Library['add']>[0]) => library.add(details),
    cards: async () => library.cards(),
    card: async (id: string) => library.card(id),
    visit: async (person: string) => library.visit(person),
    archive: async (id: string, archived: boolean) => library.archive(id, archived),
    setDefault: async (id: string) => library.setDefault(id),
    instructions: async () => library.instructions(),
    setInstructions: async (text: string) => library.setInstructions(text),
    aiConnected: async () => library.aiConnected(),
    noteAiConnected: async () => library.noteAiConnected(),
    startSetup: async (record: Parameters<Library['startSetup']>[0]) => library.startSetup(record),
    setup: async (id: string) => library.setup(id),
    saveSetup: async (id: string, record: Parameters<Library['saveSetup']>[1]) => library.saveSetup(id, record),
    endSetup: async (id: string) => library.endSetup(id),
    finishSetup: async (id: string, settings: Settings) => library.finishSetup(id, settings),
    admitSignIn: async (visitor: string) => library.admitSignIn(visitor),
    ping: async () => 'ok',
    /** Home's live connection needs a real Durable Object; here it says so. */
    fetch: async () => new Response('Live connections are tested under wrangler dev.', { status: 426 }),
  };
}
