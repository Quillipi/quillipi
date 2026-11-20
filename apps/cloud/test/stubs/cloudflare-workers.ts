/** Stands in for Cloudflare's runtime module when the cloud code is tested in Node. */

// The runtime also has a `Cloudflare` global with the compatibility flags; wrangler.jsonc sets
// global_fetch_strictly_public, which turns on sign-in with an app's published identity (CIMD).
Object.assign(globalThis, { Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } } });

export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}

/** workers-oauth-provider checks whether a handler extends this. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
