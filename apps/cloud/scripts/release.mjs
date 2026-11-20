// Builds Quillipi's release file: everything a copy deploys, in one file that is the same, byte for
// byte, on every Linux computer that builds the same commit (GitHub Actions, Claude's sandbox).
// Windows builds a different file: the app's CSS is made by Lightning CSS, native code built for
// each system, and on Windows it rounds two colours differently in the 8th digit. So pins are made
// on Linux, and CI checks them there. It holds the Worker as Wrangler bundles it, the
// app's built files, Quillipi's own Cloudflare settings (apps/cloud/wrangler.jsonc, pointed at those
// files), the storage versions this code writes, and the scripts a copy runs (deploy/). It holds no
// commit, time, path or anyone's settings, so building it again gives the same file, and its
// SHA-256 fingerprint names it: deploy/quillipi-release.json pins it, and CI checks the pin.
//
//   npm run release            build release/quillipi-<version>.json; fail unless it is the pinned file
//   npm run release -- --pin   build it and pin it, for a new version
//
// Run `npm run build` first: the release takes the app from apps/web/dist.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PIN_FILE, RELEASE_FORMAT, parseJsonc, readPin, releaseName, sha256 } from '../../../deploy/build.mjs';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The files in deploy/ that are Quillipi's: each release carries them, and updates replace them in a copy. */
export const COPY_FILES = ['.gitignore', '.node-version', 'LICENSE', 'README.md', 'build.mjs', 'package-lock.json', 'package.json', 'update.mjs'];

/** The files in deploy/ that are a copy's own, which no release carries. */
export const KEPT_FILES = ['.github/workflows/update.yml', PIN_FILE, 'wrangler.jsonc'];

/**
 * The release's Cloudflare settings: the source's, with the Worker and the app at their places in
 * the release, already bundled. A copy's own settings (its name, variables, resource IDs) are left
 * out; deploy/build.mjs adds the copy's.
 */
export function releaseConfig(source) {
  const { $schema, name, main, vars, ...config } = source;
  return {
    ...config,
    main: 'worker/index.js',
    no_bundle: true,
    assets: { ...source.assets, directory: 'web' },
    kv_namespaces: source.kv_namespaces?.map(({ binding }) => ({ binding })),
  };
}

/** A file as the release keeps it: text as it is (byte order mark included), anything else in base64. */
export function packFile(bytes) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString('base64') };
  }
}

/** `value` with every object's keys in order, so the same content always gives the same text. */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sorted(value[key])]),
  );
}

/** The release file's text, from its parts; each part's files map a path to its bytes. */
export function makeRelease({ version, storage, config, worker, web, copy }) {
  const files = (map) => Object.fromEntries([...map.keys()].sort().map((path) => [path, packFile(map.get(path))]));
  return `${JSON.stringify(sorted({ inklog: RELEASE_FORMAT, version, storage, config, worker: files(worker), web: files(web), copy: files(copy) }))}\n`;
}

/** The files under `dir`, by their paths inside it with forward slashes. */
export function filesUnder(dir, skip = () => false) {
  const files = new Map();
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (skip(path)) continue;
      if (entry.isDirectory()) walk(join(folder, entry.name), `${path}/`);
      else files.set(path, readFileSync(join(folder, entry.name)));
    }
  };
  walk(dir, '');
  return files;
}

/** A storage version from the code, such as LIBRARY_STORAGE in apps/cloud/src/library.ts. */
export function storageVersion(file, name) {
  const found = readFileSync(join(ROOT, file), 'utf8').match(new RegExp(`^export const ${name} = (\\d+);$`, 'm'));
  if (!found) throw new Error(`${file} has no "export const ${name} = <number>;".`);
  return Number(found[1]);
}

/** The Worker as `wrangler deploy` would upload it: bundled by Wrangler, without its source map. */
function bundleWorker() {
  const out = mkdtempSync(join(tmpdir(), 'quillipi-worker-'));
  try {
    const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const run = spawnSync(process.execPath, [wrangler, 'deploy', '--dry-run', '--outdir', out], {
      cwd: join(ROOT, 'apps', 'cloud'),
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    if (run.status !== 0) throw new Error('Wrangler could not bundle the Worker.');
    // Wrangler also writes a README with the time it ran, and the source map, which isn't uploaded.
    return filesUnder(out, (path) => path === 'README.md' || path.endsWith('.map'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Builds the release and writes it to release/; returns its path, version, fingerprint and storage. */
export function buildRelease() {
  const web = join(ROOT, 'apps', 'web', 'dist');
  if (!existsSync(join(web, 'index.html'))) throw new Error('The app isn\'t built: run `npm run build` first.');
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const storage = {
    library: storageVersion('apps/cloud/src/library.ts', 'LIBRARY_STORAGE'),
    room: storageVersion('apps/cloud/src/durable-store.ts', 'ROOM_STORAGE'),
  };
  const config = releaseConfig(parseJsonc(readFileSync(join(ROOT, 'apps', 'cloud', 'wrangler.jsonc'), 'utf8')));
  const copy = new Map(COPY_FILES.map((name) => [name, readFileSync(join(ROOT, 'deploy', name))]));
  const text = makeRelease({ version, storage, config, worker: bundleWorker(), web: filesUnder(web), copy });
  const file = join(ROOT, 'release', releaseName(version));
  mkdirSync(join(ROOT, 'release'), { recursive: true });
  writeFileSync(file, text);
  return { file, version, sha256: sha256(text), storage };
}

function main() {
  const { values } = parseArgs({ options: { pin: { type: 'boolean', default: false } } });
  const built = buildRelease();
  const pinFile = join(ROOT, 'deploy', PIN_FILE);
  const pin = readPin(readFileSync(pinFile, 'utf8'));
  const name = `release/${releaseName(built.version)}`;
  if (values.pin) {
    const next = { source: pin.source, version: built.version, sha256: built.sha256, storage: built.storage };
    writeFileSync(pinFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Built ${name} (SHA-256 ${built.sha256}) and pinned it in deploy/${PIN_FILE}.`);
    return;
  }
  const same = pin.version === built.version && pin.sha256 === built.sha256 && JSON.stringify(pin.storage) === JSON.stringify(built.storage);
  if (!same) {
    throw new Error(
      `${name} isn't the release deploy/${PIN_FILE} pins: it is Quillipi ${built.version} with SHA-256 ${built.sha256}, and the pin is ${pin.version} with ${pin.sha256}. ` +
        'If the code changed, give Quillipi a new version in package.json and run `npm run release -- --pin`.' +
        (process.platform === 'win32' ? " On Windows the app's CSS comes out slightly different, so pins are made on Linux: there, take the fingerprint GitHub Actions prints." : ''),
    );
  }
  console.log(`Built ${name}, the pinned release (SHA-256 ${built.sha256}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
