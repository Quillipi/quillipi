# Quillipi

**Project memory that you and your AI write together, with every change in Git.**

[Website](https://quillipi.app) · [Deploy your own](#your-own-quillipi-in-about-5-minutes) · [How it works](docs/ARCHITECTURE.md)

Every new chat, the AI has forgotten your project. A handoff file goes stale, and when the AI
updates it, it quietly rewrites things and you can't see what changed. Quillipi keeps your
project's notes as notebooks that you and AI agents such as Claude write together:

| How it works | What you get |
| --- | --- |
| A permanent ID for every paragraph | The AI edits one paragraph instead of rewriting the whole doc |
| Git history | Every AI change is a commit you can see and undo |
| MCP tools | The AI reads the project at the start of every chat, with no pasting |
| People and AI on the same notebook | You and your AI keep one source of truth |

Notebooks are plain Markdown files with Git history, kept in your own Cloudflare account and your
own GitHub, so you can take them anywhere. Quillipi's code is public, and it runs on Cloudflare's
free plan.

## Your own Quillipi, in about 5 minutes

**New to Cloudflare or GitHub?** Follow the [setup guide](https://quillipi.app/start): it shows
every screen, makes the free accounts with you, and ticks each step off. If you have both accounts:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/quillipi/quillipi/tree/main/deploy)

1. Press **Deploy to Cloudflare** and sign in to Cloudflare and GitHub. Choose a name (it becomes
   your Quillipi's address) and enter your GitHub username. Cloudflare makes a small repository in
   your GitHub account, with your settings and the Quillipi release it runs, and deploys it.
2. Open its address, `https://<name>.<your subdomain>.workers.dev`. One page takes you through four
   steps in about 3 minutes, with nothing to copy and no file to edit: a GitHub organization for
   your notebooks (GitHub makes one for free), Quillipi's GitHub App there (GitHub hands Quillipi
   its keys itself), installing it, and signing in. Only the GitHub account you entered can
   finish it.
3. Home's Get started turns on updates (one button opens GitHub with the update check filled in,
   and you press Commit; Cloudflare can't add that file for you), then shows how to connect
   Claude, then make your first notebook.

Each notebook gets a private repo in that organization, with the same commit IDs as Quillipi, so
its whole history is on GitHub too. Your copy runs Quillipi's tested releases: once a week it
opens an issue in its repository when a new one is out, and running its **Update Quillipi**
workflow updates it in one commit (reverting that commit undoes it). Its own README explains the
rest.

## Connect Claude

Claude connects once, at your Quillipi's address followed by `/mcp`, and signs in with GitHub;
only the GitHub account that owns your Quillipi is let in.

- **claude.ai and the Claude apps:** in Claude, open **Settings → Plugins → Browse plugins**, press
  **Add**, then **Add custom connector** (or **Settings → Connectors → Add custom connector**, where
  Claude still shows Connectors), name it Quillipi and paste `https://<your address>/mcp`, then
  **Add**, **Connect** and **Continue with GitHub**. The phone app and Claude Desktop use the same
  connector, through your Claude account.
- **Claude Code:**

  ```sh
  claude mcp add --transport http --scope user quillipi https://<your address>/mcp
  ```

  Then run `/mcp` in Claude Code, choose quillipi and **Authenticate**.

Then ask Claude to make a notebook ("make a Quillipi notebook for my gym idea") and it is ready at
once, with a permanent ID made from its title, such as `gym-idea`. Quillipi makes its private
GitHub repo by itself.

The same address opens the app in a browser, on the laptop or the phone: Home with every notebook,
New notebook, each notebook's overview, the editor and the History panel, and Agents, where you
see the apps connected to Claude and can disconnect one. Install it as an app so it opens in one
tap, even without a connection: on Android and computers (Chrome, Edge), the menu under your
picture has **Install Quillipi**; on an iPhone or iPad, tap Share, then **Add to Home Screen**.
After an update it is the new version the next time you open it or leave a notebook; Update,
beside the bell, does it at once. What you typed is saved first.

## Using Quillipi

- **The margin** shows a bar beside each block changed since the last commit: green for added,
  blue for edited, dashed amber for moved, a red marker where something was removed. ✦ marks a
  change made by an AI agent. Click a bar to see the change, revert it, or leave it out of your
  next commit.
- **History** (the clock at the top right, or Ctrl+Enter) opens the History panel beside the
  page. **Now** lists the uncommitted changes by section; untick a section or a single change to
  leave it out, write a message and press Commit. Pressing a change shows it in the text.
- **The history** under it shows every commit, newest first: a dot for yours, an orange diamond
  for an AI's, hollow until GitHub has it. Click one to see what it touched, view that version,
  compare it with now, or **undo that commit**, which turns its changes back into uncommitted
  changes for you to look over and commit.
- **File** shows the section exactly as stored on disk. **AI view** shows exactly what an agent
  reads.
- **Agent safety:** if an agent's commit would delete a long paragraph or cut one by more than
  40%, it waits for you at the top of the History panel, where you can approve or undo it.
  Agents also leave alone any paragraph you typed in during the last few seconds.
- **AI instructions:** press AI instructions on a notebook's overview and write how AIs should
  work there, such as "Write completely and correctly. Say what you didn't check." Every agent
  gets them at the top of `map`, the first call of every chat, and again after 30 minutes. No
  agent tool can change them, and a change you make is an uncommitted change like any other.
  They are kept under `## Instructions` in the notebook's `AGENTS.md`. The Agents page also holds
  instructions for every notebook, which an AI gets first.

| Shortcut | Does |
| --- | --- |
| Ctrl+B, Ctrl+I, Ctrl+E | Bold, italic, code |
| Ctrl+Shift+H, Ctrl+Shift+S | Highlight, strikethrough |
| Ctrl+Alt+1, 2, 3 / Ctrl+Alt+0 | Title, heading, subheading / normal text |
| Ctrl+Shift+8, 7, 9 | Bulleted list, numbered list, checklist |
| Alt+Up, Alt+Down | Move the block up or down |
| `- `, `1. `, `[ ] `, `> `, `# ` at the start of a line | Start a list, checklist, quote or heading |
| Ctrl+Enter | Open History at the commit message; press it again there to commit |

On a Mac, use Cmd instead of Ctrl.

## Your files

A notebook is an ordinary Git repository. Its files keep Quillipi's code name, InkLog:

```
gym-idea/
  sections/about.md           one Markdown file per section; a block ID ends each block
  sections/product/sound.md   a folder; sections keep their IDs when they move between folders
  canvas/k3m9pq2a.json        each drawing, with an .svg next to it that GitHub shows
  assets/9f2c41d0….png        images, named by their content
  inklog.json                 the notebook's name, its folders and the order
  AGENTS.md                   how agents should work in this folder, and your AI instructions
  .gitattributes              keeps Unix line endings on every computer
  .inklog/                    local state that is never committed
```

Each section file starts with its permanent ID, such as `id: sound`, which lets it move between
folders without breaking anything. If you edit or move the files yourself, keep that line.

## On your laptop instead

Quillipi also runs as a program on your own computer, for one notebook kept in a folder there.
Claude Desktop and Claude Code reach it directly; claude.ai and the phone need it to be on and
reachable through a tunnel, which the cloud version above doesn't.

You need **Node.js 22.13 or newer** (`node --version`). Git is optional: Quillipi has Git built in.
In a terminal in this repository's folder:

```sh
npm install
npm run build
npm run quillipi -- init "C:\Users\you\Documents\gym-idea"
npm run quillipi -- serve "C:\Users\you\Documents\gym-idea"
```

`init` starts an empty notebook; `npm run quillipi -- import <folder of .md files> <notebook>`
brings Markdown you already have instead, giving every paragraph an ID. `serve` opens the editor
in your browser at `http://localhost:4321/n/<id>`; keep the terminal open while you work, and
Ctrl+C stops it.

**Claude Desktop:** in **Settings → Developer → Edit Config**, add Quillipi under `mcpServers`
with your own paths, then quit Claude Desktop completely (from the system tray) and open it again:

```json
{
  "mcpServers": {
    "quillipi": {
      "command": "node",
      "args": ["C:\\Users\\you\\code\\quillipi\\apps\\inklog\\dist\\cli.js", "mcp", "C:\\Users\\you\\Documents\\gym-idea"]
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add --transport stdio quillipi -- node "C:\Users\you\code\quillipi\apps\inklog\dist\cli.js" mcp "C:\Users\you\Documents\gym-idea"
```

**claude.ai through a tunnel:** start a Cloudflare quick tunnel to Quillipi's remote port with
`cloudflared tunnel --protocol http2 --url http://127.0.0.1:4330` (`--protocol http2` matters on
Windows), start Quillipi with the address it prints
(`npm run quillipi -- serve "<notebook>" --public-url https://<the address>`), and add
`https://<the address>/mcp` as a custom connector in Claude. Claude opens an approval page; type
the six-digit code the editor and the terminal show. Only sign-in and the agent tools can be
reached through the tunnel; the editor stays private to your computer. A quick tunnel's address
changes every time it starts; a named tunnel on a domain you own keeps it, and Quillipi remembers
the address for the notebook (`--public-url off` forgets it).

## Developing Quillipi

```sh
npm test            # unit and integration tests
npm run typecheck   # strict TypeScript across all packages
npm run build       # everything, into each package's dist/
npm run dev:web     # the editor with live reload; needs `quillipi serve` on port 4321 running
npm run release     # the cloud's release file, checked against deploy/quillipi-release.json
```

A change to what the cloud runs gets a new version: raise `version` in every `package.json`
(they share one), add its notes to `CHANGELOG.md`, run `npm run build`, then
`npm run release -- --pin` on Linux (Windows builds the app's CSS slightly differently; there,
push and take the fingerprint GitHub Actions prints). A push to main then tests it, deploys this
repository's own Quillipi from the release, and publishes the release for copies.

The code is in five packages, and `deploy/` holds what a copy of Quillipi is made from. Package
and folder names keep the code name, InkLog:

```
packages/core     block model, file format, diffs, merges, AI text. Pure TypeScript, no I/O.
packages/engine   the engine, the agent tools, the editor's calls and the stores; runs anywhere
                  JavaScript runs, so the laptop and the cloud share it
apps/inklog       the program for a laptop: CLI, Git, local server, MCP server, remote access
apps/web          the app and the editor: React and TipTap, and the service worker that lets
                  the cloud's app be installed and open offline (apps/web/sw)
apps/cloud        Quillipi in your own Cloudflare account: a Worker and one Durable Object per notebook
deploy            what the Deploy to Cloudflare button copies: settings, the pinned release, scripts
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making larger changes; it explains how
changes flow and why things are built the way they are.

## Security

Please report a security problem privately, as [SECURITY.md](SECURITY.md) explains, not in a
public issue.

## Contributing

Improvements are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how, including the
contributor agreement you sign once.

## License

Source-available under the [PolyForm Shield License 1.0.0](LICENSE).
