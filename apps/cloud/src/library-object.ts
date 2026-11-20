/**
 * The library's Durable Object: one in the whole cloud, holding a card for every notebook
 * (library.ts). Claude's door asks it which notebook a call is for, New notebook asks it to make
 * one, and every room tells it how it stands after a change.
 *
 * Home keeps a live connection to it (the app opens it at /api/library/ws, after browser sign-in):
 * it gets every card when it connects and each card that changes after that. The connections use
 * WebSocket hibernation, so the library costs nothing while nothing changes.
 *
 * It also keeps Quillipi's settings (settings.ts). It sees the same variables and secrets as the
 * Worker, so whenever it opens it keeps a copy of the non-secret ones.
 */
import type { NotebookCard, NotebookSummary } from '@inklog/core';
import { DurableObject } from 'cloudflare:workers';
import { durableSql } from './durable-store.js';
import type { Env } from './env.js';
import { type Directory, Library, type LibraryChange, type Route } from './library.js';
import type { SettingView, Settings } from './settings.js';
import type { SetupRecord } from './setup.js';
import type { Admission } from './sign-in-limits.js';

export class LibraryObject extends DurableObject<Env> {
  private library?: Library;

  directory(): Directory {
    return this.open().directory();
  }

  route(name?: string): Route {
    return this.open().route(name);
  }

  create(details: { title: string; about?: string; colour?: string; by: string }): Promise<NotebookCard> {
    return this.open().create(details);
  }

  add(details: { repo: string; by: string }): Promise<{ card: NotebookCard; status: string }> {
    return this.open().add(details);
  }

  /** A room's report after a change. */
  update(id: string, summary: NotebookSummary): void {
    this.open().update(id, summary);
  }

  cards(): NotebookCard[] {
    return this.open().cards();
  }

  card(id: string): NotebookCard | undefined {
    return this.open().card(id);
  }

  archive(id: string, archived: boolean): NotebookCard {
    return this.open().archive(id, archived);
  }

  setDefault(id: string): void {
    this.open().setDefault(id);
  }

  instructions(): string {
    return this.open().instructions();
  }

  setInstructions(text: string): void {
    this.open().setInstructions(text);
  }

  instructionHistory(): { version: number; text: string; at: number }[] {
    return this.open().instructionHistory();
  }

  visit(person: string): number | undefined {
    return this.open().visit(person);
  }

  /** Quillipi's settings kept here, secrets included, for the Worker and the rooms. Never sent to a browser. */
  settings(): Settings {
    return this.open().settings();
  }

  /** The settings as the signed-in owner may see them: no secret's value. */
  settingsView(): SettingView[] {
    return this.open().settingsView(this.env);
  }

  claudeConnected(): boolean {
    return this.open().claudeConnected();
  }

  noteClaudeConnected(): void {
    this.open().noteClaudeConnected();
  }

  /** The first-time setups in progress (setup.ts). Only the Worker reaches these; it checks the browser's cookie first. */
  startSetup(record: SetupRecord): string {
    return this.open().startSetup(record);
  }

  setup(id: string): SetupRecord | undefined {
    return this.open().setup(id);
  }

  saveSetup(id: string, record: SetupRecord): boolean {
    return this.open().saveSetup(id, record);
  }

  endSetup(id: string): void {
    this.open().endSetup(id);
  }

  finishSetup(id: string, settings: Settings): boolean {
    return this.open().finishSetup(id, settings);
  }

  /** Whether a stranger may start one more sign-in step (sign-in-limits.ts). The Worker lets the signed-in owner through first. */
  admitSignIn(visitor: string): Admission {
    return this.open().admitSignIn(visitor);
  }

  /** Proves the object and its database answer, for /status. */
  ping(): string {
    this.ctx.storage.sql.exec('SELECT 1').toArray();
    return 'ok';
  }

  /** A live connection for Home: every card now, then each change. The Worker checks who it is first. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'cards', cards: this.open().cards() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Home sends nothing the library needs; the connection is for the library's news. */
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    socket.close(code === 1005 ? 1000 : code, 'Closed');
  }

  private open(): Library {
    if (!this.library) {
      this.library = new Library(durableSql(this.ctx.storage), {
        rooms: {
          create: (id, details) => this.room(id).create(id, details),
          adopt: (id) => this.room(id).adopt(id),
        },
        onChange: (change) => this.broadcast(change),
      });
      this.library.keepSettings(this.env);
    }
    return this.library;
  }

  private room(id: string) {
    return this.env.NOTEBOOK.get(this.env.NOTEBOOK.idFromName(id));
  }

  /** Tells every open Home what changed. A connection that has gone is skipped; Cloudflare closes it. */
  private broadcast(change: LibraryChange): void {
    const message = JSON.stringify(change);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // closed while sending
      }
    }
  }
}
