/** Workers KV in memory, with expiry and key metadata, for testing sign-in in Node. */
interface Entry {
  value: string;
  expiration?: number;
  metadata?: unknown;
}

export class FakeKV {
  private entries = new Map<string, Entry>();
  /** How many times the keys were listed, which Workers KV's free plan counts. */
  lists = 0;
  /** How many times a value was written, which the free plan allows 1,000 times a day. */
  puts = 0;

  async get(key: string, options?: 'text' | 'json' | { type?: 'text' | 'json' }): Promise<unknown> {
    const entry = this.live(key);
    if (!entry) return null;
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {}): Promise<void> {
    if (options.expirationTtl !== undefined && options.expirationTtl < 60) throw new Error('KV PUT failed: 400 Invalid expiration_ttl of less than 60 seconds.');
    this.puts++;
    const expiration = options.expiration ?? (options.expirationTtl === undefined ? undefined : Math.floor(Date.now() / 1000) + options.expirationTtl);
    this.entries.set(key, { value, expiration, metadata: options.metadata });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list({ prefix = '', limit = 1000 }: { prefix?: string; limit?: number; cursor?: string } = {}) {
    this.lists++;
    const names = [...this.entries.keys()].filter((name) => name.startsWith(prefix) && this.live(name)).sort().slice(0, limit);
    const keys = names.map((name) => {
      const { expiration, metadata } = this.entries.get(name)!;
      return { name, ...(expiration === undefined ? {} : { expiration }), ...(metadata === undefined ? {} : { metadata }) };
    });
    return { keys, list_complete: true, cacheStatus: null };
  }

  /** Every key that hasn't expired. */
  keys(): string[] {
    return [...this.entries.keys()].filter((name) => this.live(name));
  }

  /** Every stored value, for checking what is kept. */
  values(): string[] {
    return this.keys().map((name) => this.entries.get(name)!.value);
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiration !== undefined && entry.expiration * 1000 <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
