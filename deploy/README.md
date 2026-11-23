# Quillipi

This repository is your own [Quillipi](https://quillipi.app), in your own Cloudflare account:
notebooks with history, written by you and your AI agents together. It holds no Quillipi code.
Cloudflare runs Quillipi's tested releases, and this repository says which one, and how yours is
set up. Quillipi's code is at [quillipi/quillipi](https://github.com/quillipi/quillipi).

## Finish setting it up

Open your Quillipi's address, `https://<name>.<your subdomain>.workers.dev` (Cloudflare's
dashboard shows it under Workers & Pages). One page takes you through four steps in about
3 minutes: a GitHub organization for your notebooks (GitHub makes one for free), Quillipi's GitHub
App there, installing it, and signing in. Only the GitHub account named in `wrangler.jsonc` as
`GITHUB_USER_LOGIN` can finish it. Home's Get started then turns on updates and shows how to
connect Claude. New to all this? [quillipi.app/start](https://quillipi.app/start) shows every
screen.

## What's here

| File | What it is | Changed by |
| --- | --- | --- |
| `wrangler.jsonc` | Your Worker's name, your GitHub username, your resources' IDs | You |
| `quillipi-release.json` | Which Quillipi release runs here, and its SHA-256 fingerprint | Updates |
| `.github/workflows/update.yml` | The weekly update check, added by you from Home's **Turn on updates** | You (a workflow can't change workflow files) |
| Everything else | Quillipi's scripts: `build.mjs`, `update.mjs`, `package.json`, `package-lock.json`, `.node-version`, `.gitignore`, this README | Updates, which replace any changes |

## How it deploys

On every push to `main`, Cloudflare runs `npm run build` and `npm run deploy`. `build.mjs`
downloads the release that `quillipi-release.json` names, checks that its fingerprint is the
pinned one, and joins Quillipi's own settings with yours from `wrangler.jsonc` into
`dist/wrangler.json`; Wrangler uploads exactly that. So every copy runs the same file, the one
that passed Quillipi's tests.

## Updates

**Turn them on first.** Cloudflare's GitHub app can't add workflow files, so a copy made with the
Deploy to Cloudflare button starts without `.github/workflows/update.yml`. Home's Get started has a
**Turn on updates** step: its button opens GitHub with that file filled in, and you press
**Commit changes**. Cloudflare then deploys again, and the step ticks once the build finds the file.
The build finds this repository from its Git checkout; if Home names the wrong one, set
`"REPOSITORY": "<owner>/<name>"` under `vars` in `wrangler.jsonc`.

Once a week, the workflow **Update Quillipi** looks for a newer release. When there is one, it
opens an issue, "Quillipi 0.5.0 is ready", saying what is new. To update, open **Actions**,
**Update Quillipi**, **Run workflow**: it commits the new release here, Cloudflare deploys it
within a few minutes, and the issue closes.

- **To undo** an update, revert its commit, "Update Quillipi to …".
- **To update without being asked**, change `QUILLIPI_UPDATES: notice` to
  `QUILLIPI_UPDATES: automatic` in `.github/workflows/update.yml`.
- **Without GitHub Actions** (or on GitLab): `npm run update` says whether a newer Quillipi is
  out, and `npm run update -- apply` writes it here; then commit and push.

When an update moves how Quillipi stores its data forward, its issue and commit say so. After such
an update has run, going back to an older Quillipi isn't possible: the older one refuses to open
what the newer one saved, so nothing is lost, but it stays unavailable until you update again.

## Settings

Quillipi's setup keeps its settings inside Quillipi. A variable in `wrangler.jsonc` wins over the
one kept inside, so you can set any of them there
([the list](https://github.com/quillipi/quillipi/blob/main/docs/ARCHITECTURE.md#quillipis-settings)).
Variables set in Cloudflare's dashboard are removed by the next deploy, so put them in
`wrangler.jsonc` instead. Secrets set with `wrangler secret put` stay.

To deploy from your own computer: `npm install`, then `npx wrangler login` and `npm run deploy`.

## License

Quillipi is source-available under the PolyForm Shield License 1.0.0, in `LICENSE`. Each update
brings the current copy of it.
