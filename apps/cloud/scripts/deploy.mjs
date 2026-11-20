// Deploys this repository's own Quillipi the way every copy deploys. It makes a copy as the Deploy
// to Cloudflare button does, from deploy/, with this Quillipi's own settings; the copy's build.mjs
// checks the release file (from `npm run release`) against the pin, deploy/quillipi-release.json,
// and joins it with those settings, and Wrangler uploads what it made. Then this asks the new
// Quillipi's /status until it answers with this version and with its notebooks open, so a release
// reaches copies (npm run publish:release) only after it has run here.
//
//   npm run deploy:cloud   GitHub Actions runs it on every push to main, after the tests

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIN_FILE, parseJsonc, releaseName } from '../../../deploy/build.mjs';
import { COPY_FILES } from './release.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The Worker of this repository's own Quillipi, which runs every release before copies get it. It
 * was named before the product was called Quillipi, and its notebooks, its sign-ins and its address
 * belong to that name, so it keeps it; a new copy's Worker is called quillipi (deploy/wrangler.jsonc).
 */
export const OWN_WORKER = 'inklog';

/**
 * Makes in `dir` a copy of Quillipi as the Deploy to Cloudflare button makes one from deploy/: its
 * scripts and its pin, and a wrangler.jsonc that is the template with this Quillipi's Worker name.
 * Returns that wrangler.jsonc's settings.
 */
export function makeOwnCopy(dir, deploy = join(ROOT, 'deploy')) {
  mkdirSync(dir, { recursive: true });
  for (const name of [...COPY_FILES, PIN_FILE]) copyFileSync(join(deploy, name), join(dir, name));
  const own = { ...parseJsonc(readFileSync(join(deploy, 'wrangler.jsonc'), 'utf8')), name: OWN_WORKER };
  writeFileSync(join(dir, 'wrangler.jsonc'), `${JSON.stringify(own, null, 2)}\n`);
  return own;
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** The addresses Wrangler reported for the deployed Worker, from its output file. */
export function deployedAddresses(output) {
  const entries = output.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const deployed = entries.find((entry) => entry.type === 'deploy');
  if (!deployed) throw new Error("Wrangler's output doesn't record a deploy.");
  return (deployed.targets ?? []).filter((target) => typeof target === 'string' && target.startsWith('https://'));
}

/**
 * Waits for each address's /status to show `version` with the notebooks' library open ("ok"). A
 * new version reaches every Cloudflare location within seconds, so it asks a few times first.
 */
export async function checkStatus(addresses, version, { fetch = globalThis.fetch, wait = pause, tries = 10 } = {}) {
  for (const address of addresses) {
    let seen = '';
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(new URL('/status', address), { headers: { 'cache-control': 'no-cache' } });
        const status = await response.json();
        if (status.version === version && status.notebooks === 'ok') break;
        seen = `version ${status.version}, notebooks ${status.notebooks}`;
      } catch (error) {
        seen = error instanceof Error ? error.message : String(error);
      }
      if (attempt >= tries) throw new Error(`${address}/status didn't show Quillipi ${version} with its notebooks open; the last answer: ${seen}.`);
      await wait(3000);
    }
  }
}

function node(args, env = process.env) {
  const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env });
  if (run.status !== 0) throw new Error(`${args[0]} failed.`);
}

async function main() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const file = join(ROOT, 'release', releaseName(version));
  if (!existsSync(file)) throw new Error(`release/${releaseName(version)} isn't built: run \`npm run release\` first.`);
  const folder = mkdtempSync(join(tmpdir(), 'quillipi-deploy-'));
  try {
    const copy = join(folder, 'copy');
    makeOwnCopy(copy);
    node([join(copy, 'build.mjs'), '--release', file]);
    const output = join(folder, 'wrangler-output.json');
    const wrangler = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
    node([wrangler, 'deploy', '--config', join(copy, 'dist', 'wrangler.json')], { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output });
    const addresses = deployedAddresses(readFileSync(output, 'utf8'));
    if (addresses.length === 0) return console.log('Wrangler named no https address for this Quillipi, so its /status was not checked.');
    await checkStatus(addresses, version);
    console.log(`Quillipi ${version} is live at ${addresses.join(', ')}, with its notebooks open.`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
