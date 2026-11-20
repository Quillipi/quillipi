// Publishes the release file as the GitHub release v<version> of this repository, the first time
// that version is deployed, with its notes from CHANGELOG.md: copies find it there and update to
// it. A version is published once. When its release exists, its file must be this one, byte for
// byte; a release left unfinished by an earlier run (a draft, or one without its file) is finished.
//
//   npm run publish:release   needs GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA, as GitHub Actions gives

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIN_FILE, readPin, releaseName, sha256 } from '../../../deploy/build.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The notes under a version's heading in CHANGELOG.md, such as "## 0.3.0 (2026-11-18)", up to the next one. */
export function changelogNotes(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
  if (start < 0) return undefined;
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
}

/** Publishes `bytes` as release v<version>, or checks that the published file is the same. */
export async function publish({ repo, token, sha, version, bytes, notes, fetch = globalThis.fetch }) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'quillipi-release', authorization: `Bearer ${token}` };
  async function github(url, init = {}, missingIsAnswer = false) {
    const response = await fetch(url.startsWith('https://') ? url : `https://api.github.com/repos/${repo}${url}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok && !(missingIsAnswer && response.status === 404)) throw new Error(`GitHub answered ${response.status} to ${init.method ?? 'GET'} ${url}.`);
    return response;
  }
  const tag = `v${version}`;
  const name = releaseName(version);

  // A published release is found by its tag; a draft has no tag yet, so it is found in the list.
  let release;
  const tagged = await github(`/releases/tags/${tag}`, {}, true);
  if (tagged.ok) release = await tagged.json();
  else release = (await (await github('/releases?per_page=100')).json()).find((draft) => draft.draft && draft.tag_name === tag);
  release ??= await (await github('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: sha, name: `Quillipi ${version}`, body: notes, draft: true }) })).json();

  const asset = release.assets?.find((file) => file.name === name);
  if (asset) {
    const published = await github(asset.url, { headers: { accept: 'application/octet-stream' } });
    const found = sha256(Buffer.from(await published.arrayBuffer()));
    if (found !== sha256(bytes)) {
      throw new Error(`Release ${tag} already has ${name}, and it is a different file (SHA-256 ${found}). A version is published once: give Quillipi a new version.`);
    }
  } else {
    const upload = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    await github(upload, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
  }
  if (release.draft) {
    await github(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) });
    return `Published Quillipi ${version} as release ${tag}.`;
  }
  return asset ? `Release ${tag} already has this file.` : `Added ${name} to release ${tag}.`;
}

/**
 * Copies look for new releases in the repository their pin names, so a release published anywhere
 * else would never reach them: the pin must name this repository, the one publishing.
 */
export function checkSource(pin, repo) {
  if (pin.source.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`deploy/${PIN_FILE} says Quillipi comes from ${pin.source}, but this is ${repo}, so copies would never see this release. Set its "source" to "${repo}".`);
  }
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
  if (!token || !repo || !sha) throw new Error('Publishing needs GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA, as GitHub Actions gives.');
  const pin = readPin(readFileSync(join(ROOT, 'deploy', PIN_FILE), 'utf8'));
  checkSource(pin, repo);
  const bytes = readFileSync(join(ROOT, 'release', releaseName(pin.version)));
  if (sha256(bytes) !== pin.sha256) throw new Error(`release/${releaseName(pin.version)} isn't the pinned release: run \`npm run release\`, which says why.`);
  const notes = changelogNotes(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), pin.version);
  if (!notes) throw new Error(`CHANGELOG.md has no notes for ${pin.version}.`);
  console.log(await publish({ repo, token, sha, version: pin.version, bytes, notes }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
