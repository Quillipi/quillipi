import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against source, so `npm test` works without a build.
    alias: {
      '@inklog/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@inklog/engine': fileURLToPath(new URL('./packages/engine/src/index.ts', import.meta.url)),
      // Cloudflare's runtime module, for the cloud code tested in Node.
      'cloudflare:workers': fileURLToPath(new URL('./apps/cloud/test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    // workers-oauth-provider imports Cloudflare's runtime module, so it goes through the alias above.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    include: ['packages/*/test/**/*.test.ts', 'apps/inklog/test/**/*.test.ts', 'apps/cloud/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
  },
});
