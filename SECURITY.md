# Security

## Reporting a problem

Please report a security problem privately, never in a public issue, pull request or discussion:

- **On GitHub:** [report a vulnerability](https://github.com/quillipi/quillipi/security/advisories/new)
  (this repository's **Security** tab, then **Report a vulnerability**). Only the maintainers see it.
- **By email:** security@quillipi.app

Say what you found, how to make it happen, and what someone could do with it. You'll get a reply
within a week. Please give a fix the time it needs before telling anyone else; the advisory will
credit you, unless you'd rather it didn't.

## What is covered

The code in this repository: the Worker and its sign-in (`apps/cloud`), the app (`apps/web`), the
engine and the agent tools (`packages/`), the laptop program (`apps/inklog`), and the scripts a
copy runs (`deploy/`), including how a copy checks the release it downloads. Problems in
Cloudflare, GitHub or an AI app themselves belong to them.

## Versions that get fixes

Only the newest release. A copy made with the Deploy to Cloudflare button hears of a new release
within a week, in an issue in its own repository; running its **Update Quillipi** workflow
updates it at once.

## How Quillipi is built to stay safe

- Only the GitHub account that owns a Quillipi can sign in, checked by GitHub's numeric user ID,
  so a renamed account keeps working and a new account with the old name gets nothing.
- Every app that connects (such as Claude) passes a consent page first, and the sign-in is tied
  to the browser that started it, so a link or a form from another site can't let an app in.
- Tokens are stored only as hashes. The GitHub App's keys stay in the owner's own Cloudflare
  account, are never shown on a page, and are used only to talk to GitHub.
- Strangers can start only a limited number of sign-ins, per visitor and per day, so they can't
  use up the Cloudflare account's daily storage writes; the signed-in owner is never limited.
- What a notebook holds is shown as content, never run as page code: its text and drawings are
  checked and escaped, its files are served sandboxed, and the app runs only its own scripts.
- Agents edit through tools that can't change the owner's AI instructions, and a large deletion
  waits for the owner's approval.
- Every copy runs a release file checked against its pinned SHA-256 fingerprint, the exact file
  that passed the tests and ran first on this repository's own Quillipi.
