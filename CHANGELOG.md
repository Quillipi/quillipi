# Changelog

What is new in each version of Quillipi, called InkLog until 0.4.0. Each version's notes are its
release notes on GitHub, and a Quillipi made with the Deploy to Cloudflare button shows them in
the issue that says it is ready.

## 0.4.3 (2026-11-23)

Fixes from the first newcomer test, which went from no accounts to a first notebook in 23 minutes.

- **Turn on updates.** A copy made with the Deploy to Cloudflare button had no update check:
  Cloudflare's GitHub app can't add workflow files, so `.github/workflows/update.yml` never reached
  the new repository, and its owner was never told of a new Quillipi. Home's Get started now starts
  with **Turn on updates**: one button opens GitHub with the file filled in, you press **Commit
  changes**, and once Cloudflare has deployed that commit the step ticks itself. If GitHub can't
  find the page, the step shows the file's name and text to add by hand. **A copy made before
  0.4.3 doesn't hear of this release**: add
  [`update.yml`](https://github.com/quillipi/quillipi/blob/main/deploy/.github/workflows/update.yml)
  to your copy as `.github/workflows/update.yml`, then run **Actions, Update Quillipi, Run
  workflow**.
- **`/status` names the real commit.** Cloudflare's first build of a new copy gave the branch,
  `main`, where a commit ID belongs, and `/status` showed `"commit": "main"`. Only a real commit ID
  counts now; otherwise the build reads the checkout's own, or says `unknown`.
- **Connect Claude follows claude.ai's new menu**: Settings, Plugins, Browse plugins, Add, Add
  custom connector (or Settings, Connectors, where Claude still shows that).
- **The README points newcomers to the [setup guide](https://quillipi.app/start)**, which shows
  every screen, accounts included.
- A copy's build now tells Quillipi its GitHub repository (`REPOSITORY`, from the checkout, or set
  in `wrangler.jsonc`) and whether its update workflow is there (`UPDATE_WORKFLOW`).

## 0.4.2 (2026-11-20)

- **Quillipi is source-available under the PolyForm Shield License 1.0.0.** Its code was under
  MIT while the repository was private; from this version on, the license is
  [PolyForm Shield](LICENSE). Anyone may read, run and change Quillipi and contribute to it, but
  not use it to compete with Quillipi.
- **A copy carries the license.** The Deploy to Cloudflare button and every update put `LICENSE`
  in your copy's repository, and its README says so.
- **Contributing** is explained in `CONTRIBUTING.md`, with a contributor agreement (`CLA.md`) that
  a bot asks you to sign once.

## 0.4.1 (2026-11-20)

Security fixes from an audit before the code went public. No setting or notebook changes.

- **Sign-in can't send you to another site.** After signing in, Quillipi goes back to the page
  you came from, and only to a page of its own. A link with a hidden tab in that address could
  get past the check and send a signed-in browser elsewhere; now control characters and
  backslashes are refused, and the address must still be Quillipi's when a browser reads it.
- **Drawings can't carry page code.** A drawing's elements are checked when a notebook opens and
  when one is saved (plain IDs, known kinds, finite numbers, image paths inside the notebook), and
  every value is escaped when it is drawn. A drawing file arriving through Git, such as in a
  notebook added from GitHub, could put markup into the page before; in the cloud the app's
  security policy stopped it from running.
- **The laptop program's pages have the cloud's security headers**: only its own scripts, only
  its own address, never inside another site.
- **Strangers can start only so many sign-ins.** Registering an app and the consent page write to
  Workers KV, which the Free plan allows 1,000 times a day. A visitor may start 20 of these steps
  in ten minutes and everyone together 300 a day, counted in the library, so your connected apps
  can always renew their tokens. You, signed in to the app in that browser, are never limited.
  No address is stored.
- **Dependencies updated**: the MCP SDK 1.32.2 (with `hono` 4.13.19 and `@hono/node-server`
  2.1.9) and Wrangler 4.165.0, for `npm audit` advisories; none was reachable in Quillipi.
- **The workflows' actions are pinned to their commits** (`actions/checkout` and
  `actions/setup-node` v4.4.0), so a moved tag can't change what runs. A copy made from this
  release gets the pinned update workflow.

## 0.4.0 (2026-11-19)

- **InkLog is now Quillipi.** Everything you read says Quillipi: the app and its install name,
  the setup and sign-in pages, the name and text Claude sees, the guide a new notebook's
  `AGENTS.md` starts with, the laptop program's command (`quillipi`), and the docs. Notebooks keep
  their format (`inklog.json`, `.inklog/`), so none needs an upgrade, and an InkLog keeps its
  address, its sign-ins and its notebooks.
- **Quillipi's home is [quillipi/quillipi](https://github.com/quillipi/quillipi)**, where its
  releases are published, and its website is [quillipi.app](https://quillipi.app).
- **A new copy is called quillipi.** The Deploy to Cloudflare button suggests the Worker name
  `quillipi`, so a copy's address is `https://quillipi.<your subdomain>.workers.dev`, and the
  setup suggests the GitHub App name "Quillipi <organization>".
- **A copy's own files say Quillipi too**: its pin is `quillipi-release.json`, its releases are
  `quillipi-<version>.json`, and its workflow is **Update Quillipi**, set with
  `QUILLIPI_UPDATES`. Copies made from an earlier release look for the old names, so they don't
  find this one; only test copies were made from those.
- **Connect Claude** suggests the name `quillipi` for Claude Code and Quillipi for claude.ai.
  A connection you made under another name keeps working.
- `GET /api/settings` says `"from": "quillipi"` for a setting Quillipi keeps itself (it said
  `"inklog"`).
- **SECURITY.md** says how to report a security problem privately.
- The code holds no one's own values: its tests and comments use example values.

## 0.3.1 (2026-11-18)

- **The setup says what each button does.** Before each of its buttons, a short box says where
  it goes, what to press there, and how you come back, so nobody has to guess on GitHub's pages.
- **Whose setup it is, said plainly.** The setup names the GitHub account it is for, says that
  name was given when the InkLog was deployed and that only that account can finish it, and says
  where to change it.
- 0.3.0's notes said a release is the same file wherever it is built; it is the same on any
  Linux computer, which is where releases are built.

## 0.3.0 (2026-11-18)

- **InkLog is ready to share.** Anyone can have their own InkLog in their own Cloudflare account:
  the Deploy to Cloudflare button makes a small repository with their settings and the release it
  runs, and Cloudflare deploys it. Its first-time setup then takes about 3 minutes.
- **Tested releases.** Each version of InkLog is one release file: the Worker, the app and InkLog's
  Cloudflare settings, built once, the same byte for byte on any Linux computer. It runs on
  InkLog's own copy first and is published only when that copy answers with its notebooks open.
  Every copy runs that exact file, checked by its SHA-256 fingerprint.
- **Updates in one click.** Once a week a copy looks for a newer release, and opens an issue
  saying what is new. Running its Update InkLog workflow applies it in one commit, which
  Cloudflare deploys; reverting that commit undoes it. One line makes updates automatic.
- **Storage versions.** The library and every notebook record which storage version wrote them.
  An older InkLog refuses to open what a newer one saved, so going back to an older release can
  never damage notebooks; it says to update instead.
- **No one's settings in the code.** InkLog's code carries only what it needs; each InkLog keeps its
  own settings inside itself, and a copy's few others are in its own `wrangler.jsonc`.
- Every package of InkLog now has the same version, this one.
