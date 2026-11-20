/**
 * A small typed event emitter that runs anywhere JavaScript runs: Node, a browser or a Cloudflare
 * Worker. The engine uses it instead of Node's EventEmitter so that it carries no Node-only code.
 *
 * Listeners run in the order they were added, synchronously, as Node's do.
 */
type Listener<Args extends unknown[]> = (...args: Args) => void;
/** Listeners are kept untyped inside; on, off and emit keep each event's arguments typed. */
type Stored = Listener<unknown[]>;

export class Emitter<Events extends Record<string, unknown[]>> {
  private listeners = new Map<keyof Events, Set<Stored>>();

  on<Name extends keyof Events>(name: Name, listener: Listener<Events[Name]>): this {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener as unknown as Stored);
    return this;
  }

  off<Name extends keyof Events>(name: Name, listener: Listener<Events[Name]>): this {
    this.listeners.get(name)?.delete(listener as unknown as Stored);
    return this;
  }

  /** Calls every listener for the event; returns whether there were any. */
  emit<Name extends keyof Events>(name: Name, ...args: Events[Name]): boolean {
    const set = this.listeners.get(name);
    if (!set?.size) return false;
    // A copy, so a listener that removes itself doesn't make another one miss this event.
    for (const listener of [...set]) listener(...args);
    return true;
  }

  listenerCount(name: keyof Events): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}
