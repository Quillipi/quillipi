/**
 * Builds the service worker (service-worker.ts) with the app. Once Vite has the app's files, it
 * lists every file the app needs (its page as `/`, the bundle's files and the public folder's),
 * names the build from their names and contents, writes that name into the page as
 * `<meta name="inklog-build">` so the app knows which build it is, and after the app is written
 * builds main.ts on its own into `dist/sw.js`, with the name and the list built in.
 *
 * The name comes only from what the app is made of, so the same code builds the same app, byte
 * for byte, and a new deploy gets a new name only when something in the app changed.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Plugin, build } from 'vite';

/** Built files that are not the app's to keep: Cloudflare's header rules, and the worker itself. */
const NOT_KEPT = new Set(['_headers', 'sw.js']);

/** As service-worker.ts has it; repeated here, because that file is built for a worker, not for Node. */
interface Build {
  id: string;
  files: string[];
}

/** Every file the app needs, as addresses: its page first, as `/`, then the rest in order. */
export function precacheList(files: string[]): string[] {
  const rest = files.filter((file) => file !== 'index.html' && !NOT_KEPT.has(file));
  return ['/', ...[...new Set(rest)].sort().map((file) => `/${file}`)];
}

/** A short name for a build, from each of its files' names and contents. */
export function buildId(files: Iterable<[name: string, content: string | Uint8Array]>): string {
  const lines = [...files].map(([name, content]) => `${name} ${sha256(content)}`).sort();
  return sha256(lines.join('\n')).slice(0, 12);
}

/** The page with the build's name in it, for the app to read. */
export function withBuildName(html: string, id: string): string {
  if (!html.includes('</head>')) throw new Error('The app’s page has no </head> to put the build’s name before.');
  return html.replace('</head>', `  <meta name="inklog-build" content="${id}" />\n  </head>`);
}

export function serviceWorker(): Plugin {
  let root = '';
  let outDir = '';
  let publicDir = '';
  let made: Build | undefined;

  return {
    name: 'inklog:service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
      publicDir = config.publicDir;
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type !== 'asset' || typeof page.source !== 'string') throw new Error('The app’s page, index.html, is missing from the build.');
        const contents = new Map<string, string | Uint8Array>();
        for (const item of Object.values(bundle)) contents.set(item.fileName, item.type === 'chunk' ? item.code : item.source);
        for (const file of publicFiles(publicDir)) contents.set(file, fs.readFileSync(path.join(publicDir, file)));
        for (const file of NOT_KEPT) contents.delete(file);
        made = { id: buildId(contents), files: precacheList([...contents.keys()]) };
        page.source = withBuildName(page.source, made.id);
      },
    },
    async writeBundle() {
      if (!made) throw new Error('The service worker’s build was never listed.');
      await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'warn',
        define: { INKLOG_BUILD: JSON.stringify(made) },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          modulePreload: false,
          rollupOptions: {
            input: fileURLToPath(new URL('./main.ts', import.meta.url)),
            // One plain script: a service worker loaded as a classic script can't import.
            output: { format: 'iife', entryFileNames: 'sw.js' },
          },
        },
      });
    },
  };
}

/** The public folder's files, as paths inside it with forward slashes. */
function publicFiles(folder: string, under = ''): string[] {
  if (!folder || !fs.existsSync(folder)) return [];
  return fs.readdirSync(path.join(folder, under), { withFileTypes: true }).flatMap((entry) => {
    const name = under ? `${under}/${entry.name}` : entry.name;
    return entry.isDirectory() ? publicFiles(folder, name) : [name];
  });
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
