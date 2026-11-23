# Quillipi architecture

Quillipi keeps a folder of documents under version control and lets people and AI agents edit
them safely. Every paragraph is a *block* with a permanent ID, so Quillipi always knows exactly
what changed, who changed it, and how to undo it.

This file explains how the code is organised and why. Read it before making larger changes.

**InkLog is Quillipi's code name.** The project was called InkLog until 0.4.0. The name stays where
changing it would break what already exists, and nowhere people read: the notebook format
(`inklog.json`, `.inklog/`, the `InkLog-Agent` commit trailer, and the key `inklog` that names a
release file's format), the packages (`@inklog/*`, `apps/inklog`), and names a browser keeps
(cookies such as `__Host-inklog`, local storage keys, the service worker's caches). Everything
else, from the app to the setup, the agent tools' text and the docs, says Quillipi.

## Layout

```
packages/core     Pure TypeScript, no I/O.
  blocks.ts         the block model
  inline.ts         inline formatting: Markdown text <-> runs of marked text, and the editor's
                    form of it, which agents' text is stored in
  instructions.ts   the owner's AI instructions: where they live in AGENTS.md, how agents get them
  markdown.ts       the section file format, and IDs for blocks that arrive without one
  diff.ts           block diffs (added, edited, moved, removed) and word diffs
  merge.ts          three-way merge, block by block
  after-save.ts     what the editor does with the answer to a save (pure, so it is tested alone)
  partial.ts        the staged version of a section for partial commits
  canvas.ts         drawings: model, agent edits, SVG rendering
  patch.ts          agent edits, addressed by block ID and version hash
  ai.ts             the text agents read: map, read, search, related blocks
  protocol.ts       what the program and the editor send each other

packages/engine   The engine, the agent tools and the stores. Runs anywhere JavaScript runs:
                  Node, a browser or a Cloudflare Worker, so the laptop and the cloud share it.
  engine.ts         owns one notebook: sections in memory, saves, merges, commits
  editor-api.ts     the editor's calls, files and live saves, the same for the laptop and the cloud
  store.ts          NotebookStore: the only way the engine reaches files and history
  memory-store.ts   a store in memory, for tests and as the model for the cloud store
  notebook.ts       starting a notebook in any store
  agent.ts          the agent tools, as functions that return text
  calls.ts          the call log: every agent tool call, in .inklog/calls/ (inklog calls)
  mcp.ts            the tools over the Model Context Protocol
  emitter.ts        a small event emitter that runs anywhere, used by the engine
  digest.ts         SHA hashes with the Web Crypto API
  git-objects.ts    Git's blob, tree and commit IDs, so every store names things as Git does

apps/inklog       The program you run on a laptop.
  cli.ts            commands: init, import, serve, mcp, calls
  setup.ts          init, import, and opening a folder (openFolder)
  repo.ts           the store on a laptop, a folder with Git; the only module that touches the disk
  server.ts         the editor's local server: sign-in, address checks, the built editor's files,
                    and EditorApi at the notebook's addresses
  owner.ts          one owner process per folder; other processes forward to it
  watch.ts          picks up edits other programs make to the files
  session.ts        starts and stops an owner: engine, server, watcher, remote access
  remote.ts         remote access: the door that apps in the cloud reach through a tunnel
  remote-auth.ts    sign-in for remote access: Quillipi's own OAuth authorization server
  approval-page.ts  the page where the person approves an app

apps/web          The app and the editor: React and TipTap, served by apps/inklog and the cloud.
  editor/schema.ts  the document schema
  editor/blockIds.ts, convert.ts, sync.ts, Margin.tsx, FigureView.tsx, CanvasEditor.tsx
  index.css         the look: colours and type as tokens for Tailwind, and a few base rules
  editor/editor.css the document's own styles: the page, figures, the margin, the drawing editor
  frame/            the rail, the panel, the switcher, the notebook's tree (NotebookTree), the
                    top bar, and the History panel (HistoryPanel)
  tree/             the animated-file-tree component (AnimatedTree.tsx) and the tree's moves
                    as pure functions (model.ts)
  installable.ts    the app installed (step 3.5): the service worker, updates after a deploy,
                    and installing
  sw/               the service worker (service-worker.ts) and the Vite plugin that builds it
                    with the app (plugin.ts)
  public/           the manifest, the app icons (icons/, drawn from icons/*.svg) and the
                    header rules Cloudflare applies to the app's files (_headers)
  ui/               the primitives, on Radix: Button, Menu, Dialog, Tooltip; the marks; the
                    notebook's tile and folder (NotebookFolder)
  dialogs/          New notebook, naming, moving and deleting, and the AI instructions editor
  pages/            Home, a notebook's overview, a section, Agents
  components/       the tabs, the toolbar, the breadcrumb and the views

apps/cloud        Quillipi in the cloud, on Cloudflare: always on, in its owner's own account
  src/index.ts           the Worker: workers-oauth-provider in front, /status, and the /dev/
                         routes under `wrangler dev` only
  src/door.ts            Claude's door, /mcp: the tools for every notebook, and create_notebook,
                         behind sign-in
  src/sign-in.ts         sign-in with GitHub, letting in one account: consent, GitHub, callback
  src/pages.ts           the consent page and the sign-in messages
  src/sign-in-limits.ts  how many sign-in steps strangers may start, per visitor and per day
  src/library.ts         the library: a card for every notebook, permanent IDs, New notebook,
                         adding from GitHub, the instructions for every notebook, last visits
  src/library-object.ts  the library's Durable Object, one in the cloud, with Home's live news
  src/notebook-object.ts the Durable Object that owns one notebook, one instance per notebook
  src/notebook-host.ts   the notebook's store, engine and mirror, opened on first use, and its
                         report to the library
  src/durable-store.ts   NotebookStore on the object's SQLite: chunked files, commits, Git IDs
  src/mirror.ts          the GitHub mirror: imports a notebook's history, pushes every commit
  src/github.ts          the GitHub App's sign-in and the Git Data API calls the mirror makes
  scripts/dev-vars.mjs   writes .dev.vars with the App's key, for trying the mirror locally
  scripts/release.mjs    builds the release file, the same byte for byte wherever it is built
  scripts/deploy.mjs     deploys this repository's Quillipi from the release, as a copy deploys
  scripts/publish.mjs    publishes a new version's release file on GitHub, for copies
  wrangler.jsonc         Quillipi's own Cloudflare settings, including the Durable Object migrations;
                         nobody's values

deploy            what the Deploy to Cloudflare button copies: a Quillipi of one's own
  wrangler.jsonc         the copy's own settings: its Worker's name, its owner, its resources' IDs
  quillipi-release.json  the release it runs, pinned by its SHA-256 fingerprint
  build.mjs              gets that release, checks it, and makes dist/ for `wrangler deploy`
  update.mjs             the weekly update check and the update, run by .github/workflows/update.yml
  package.json           the build and deploy commands, Wrangler, and the deploy form's words
```

`core` is shared by the program and the editor, so a diff in the margin is computed by exactly
the same code that answers an agent.

## Data model

A **repo** is a folder. A **section** is one Markdown file under `sections/`, known by a
permanent **section ID** kept in its front matter (`id: pricing`): made from its title when it is
created, unique in the notebook, and never changed, so a section can be renamed or moved between
folders without breaking anything that names it. **Folders** are directories under `sections/`,
which may nest. A section is an ordered list of **blocks**:

```ts
interface Block {
  id: string;        // permanent, 8 characters, unique within the repo
  type: BlockType;   // p, h1, h2, h3, li, ol, task, quote, callout, code, hr, table, image, canvas
  text: string;      // inline Markdown for text blocks, raw code for code blocks
  attrs?: BlockAttrs // task state, table rows, figure placement, drawing elements…
}
```

IDs never change while a block exists. Edits keep the ID; a split keeps it on the half with
more text; a pasted copy gets a new one; a dragged block keeps its own. Margin marks, history,
agent patches and merges all rely on this.

## The file format

Section files are ordinary Markdown that GitHub renders, with a block ID at the end of each
block. The full rules are in `packages/core/src/markdown.ts`; in short:

```markdown
---
id: marketing-plan
---

# Marketing plan ^g2h7a3k9

Goal: earn **organic installs** first. ^k3f9b2m4

- [ ] New screenshots are live. ^c4xnf6p2

> [!NOTE]
> Give the store changes time to work. ^u3x5q8r2

![How a sound travels](canvas/k3m9pq2a.svg "canvas right 46% 1.6") ^k3m9pq2a
```

- One block per line, never hard-wrapped, so Git diffs are per block.
- Tables and dividers carry their ID on the next line; code blocks carry it in the fence.
- Inline formatting is `**bold**`, `_italic_`, `~~strike~~`, `==highlight==`, `` `code` `` and
  `[label](url)`. Italic is written with `_` so it can never merge with bold's `**` into an
  ambiguous `***`; `*italic*` is still read. The round trip is exact (randomized tests).
- Text an agent writes is stored in the form the editor writes (`inEditorForm` in `core/patch.ts`,
  checked against the editor's own conversion in `apps/web/test`), so opening it in the editor
  changes nothing and no change is credited to the person. An agent's Markdown is read as GitHub
  reads it: `_` inside a word is an underscore (`create_section` is stored as `create\_section`),
  where the general reader would read the text between two of them as italics. That reading is
  applied only to what the agent sent, never to stored text, which may hold a person's italics
  inside a word.
- A drawing is stored as `canvas/<id>.json`, with a rendered `canvas/<id>.svg` that GitHub
  shows. Images live in `assets/`, named by a hash of their content. Figure placement is in the
  image title, which keeps the line valid Markdown.
- **A drawing's elements are checked** whenever they are read or saved (`canvasElements` in
  `canvas.ts`, since 0.4.1): plain IDs, known kinds, finite numbers, labels as text and image
  paths inside the notebook; anything else is left out. A canvas file arrives through Git from
  anyone, and the app draws the SVG into the page, so the renderer also escapes every value.
- A section file is named after its ID, `sections/<folders>/<id>.md`; a file keeps its name when
  it moves, and a file found under another name keeps it too. A file without an `id:` (written by
  another tool) gets one from its name, written into it once, as missing block IDs are. When two
  files claim one ID, such as a file and its copy, the file at that ID's path in the last commit
  keeps it, then one named after it.
- `inklog.json` holds the notebook's name and its **tree**: the order, each folder's display name,
  and empty folders, which Git can't keep (`packages/core/src/layout.ts`):
  `"tree": ["start-here", { "folder": "research", "name": "Research", "items": ["pricing"] }]`.
  The files are the truth about which sections exist and which folder each is in; `placeTree`
  joins the two and repairs a tree that disagrees, so a hand-edited `inklog.json` never loses a section.
- `AGENTS.md` is Quillipi's short guide for programs that edit the files, then the owner's **AI
  instructions** for this notebook under the heading `## Instructions` (`core/instructions.ts`).
- `.gitattributes` (`* text=auto eol=lf`) keeps the Unix line endings Quillipi writes on every
  computer, so Git on Windows doesn't warn on every commit. New notebooks get it.
- An image in `assets/` that no section uses and no commit holds is removed once it has been
  unused for a day (tracked in `.inklog/state.json`), not at once, so a person who deletes an image
  can still undo that in the editor. Images a commit holds stay.
- `.inklog/` holds local state that is never committed: who touched which block and who changed
  the arrangement, what the person left out of the next commit, agent changes held for review,
  and which process owns the folder.

The reader is tolerant: Markdown from other tools (hard-wrapped paragraphs, nested lists, deep
headings, front matter, GitHub alerts) loads, and front matter survives a save. Blocks that
arrive without an ID are matched back to the previous version by content (`restoreIds`), so a
tool that strips IDs causes edits rather than delete-and-add.

## Folders and the arrangement

The **arrangement** is where each section's file is, the order, and the folders with their names.
It is compared with the last commit for the sections in both, and any difference is one pending
change, `{ section: '', key: 'layout' }` (`LAYOUT_CHANGE`), credited to whoever made it, which can be
left out like any other. A new or deleted section isn't an arrangement change; it comes and goes
with its text.

- `Engine.organize` makes sections and folders, moves them and renames folders, all or nothing:
  its ops are tried on a copy (`Arrangement` in `engine.ts`), then the in-memory state changes in
  one go before any file is written. Moved files are written in the order they moved, before
  their old paths are removed, and a path another section uses by then is kept. Renaming a folder
  renames its directory. Names become slugs, never the device names Windows keeps (`con`, `aux`…),
  and a path stays under 180 characters for Windows.
- Deleting is the person's only (`deleteSection`, `deleteFolder`), and a deletion counts as the
  person's even in blocks an agent edited, so an agent's commit never commits it.
- A commit puts each section where the committed arrangement has it: its file now when the
  arrangement is included or unchanged, else where the last commit had it; a moved section's old
  path is removed, and `inklog.json` gets the matching tree. A commit can hold only a move. An
  agent's commit includes the arrangement only when no person changed it too.
- `history` with a path follows a section's ID back through moves; `compare` and `changes` show
  moves, such as `pricing: moved from research/ to the top`.
- The file watcher sees a file that turns up carrying the ID of a section whose file is gone
  (as after `git mv`) as that section, moved; a file without an `id:` carries the one its name gives.
- **The upgrade from nested sections.** Before folders, a section's ID was its path and a section
  could have sections under it. Opening such a notebook (`inklog.json` with `sections` instead of
  `tree`) makes one commit, built from the last commit's files so uncommitted work stays
  uncommitted, that adds an `id:` to every file and writes the tree; the working files follow, and
  local state moves to the new IDs. A section's ID comes from its file name (`-2` on a clash); files
  keep their names and places, so old names, which were paths, still resolve; a section with
  sections under it moves into their folder, which takes its title. Commits from before are read
  with the IDs the upgrade gives, so history and comparisons reach across it. Running it again,
  such as after an older Quillipi wrote the old `inklog.json` back, changes nothing it did before.

## How a change flows

One **engine** owns a folder. It holds every section in memory and is the only writer, so the
editor, agents and the disk never race.

```
editor  --WebSocket: save(section, baseVersion, blocks)-->  engine  --debounced, atomic-->  files
agent   --MCP: patch(section, ops)----------------------->  engine  --WebSocket broadcast-->  editors
files   --watcher: an edit made by another program------->  engine
```

- **Editor saves** go over the WebSocket shortly after typing stops and name the version they
  were based on. The engine merges them block by block (`core/merge.ts`) with anything that
  changed since, so an agent's edit to another paragraph is never lost. Where both changed the
  same block, the person's version wins. The editor applies changes from elsewhere the same way
  (`editor/sync.ts`), keeping the cursor and keeping them out of the person's undo history.
- **Agent patches** name each block's version hash. If the block changed since the agent read
  it, nothing is applied and the reply shows the current text so the agent can retry. One patch
  can edit several sections, all or nothing. Agents can't edit a block a person typed in during
  the last four seconds.
- **Edits by other programs** (another editor, `git pull`, a script) reach the engine through
  the file watcher and are merged the same way.

### Saves across a restart

A section's version is a string, `<run>.<n>`. `run` is a random ID made each time the engine
opens, and `n` counts the section's changes. The engine keeps the last 50 versions in memory and
nothing else, because in the cloud a notebook's room loses its memory after about ten seconds idle
while the editor stays connected (WebSocket hibernation), and starts again on the next message.

- A save based on a version the engine knows is merged as above.
- A save based on a version it doesn't know (from before it started, or older than the kept
  ones) changes nothing. The reply is **stale**: the engine's current version and text. Because
  `run` is new each time, a version from before a restart can never pass for one after it, as a
  plain counter that restarts at 1 could.
- The editor decides what to do with a reply in `core/after-save.ts`. A stale reply is merged
  the way changes from elsewhere are: the base is the last text the engine confirmed, ours is
  the engine's text and theirs is the editor's. So everything typed since wins, an agent's edits
  to other blocks stay, and the editor saves again on the new version.
- Whoever hosts the engine must store a save before confirming it, so a confirmed save survives
  the restart. The laptop writes 300 ms after a change and flushes on exit; the cloud's room
  flushes before it replies, as it already does after every tool call.

### The editor's addresses

`EditorApi` (`packages/engine/src/editor-api.ts`) answers everything the editor asks of a
notebook, with plain values in and out, so the laptop and the cloud serve the editor the same way
and can't drift apart. Each home keeps only its own parts: sign-in, address checks, the built
editor's files and its sockets.

```
/n/<id>                     the notebook's overview (the app reads where it is from the address)
/n/<id>/f/<folder path>     the overview of a folder in it
/n/<id>/s/<section>         a section, in the editor
/api/n/<id>/<call>          repo, overview, visit, details, section, snapshot, agent-view,
                            sections, organize, delete, commit, include, held, undo,
                            instructions, assets
/api/n/<id>/files/<path>    images and drawings, only from assets/ and canvas/
/api/n/<id>/ws              the live connection: saves out, changes from elsewhere in
/api/notebooks              the notebooks this Quillipi serves; on a laptop, its one
/api/me                     which Quillipi this is: in the cloud, who is signed in; on a
                            laptop, its one notebook
```

- On a laptop the ID is a slug of the folder's name (`notebookId`), and `/` and the login link
  lead to `/n/<id>` until there is a home page. Any other ID is refused with 404, and the live
  connection opens only at the notebook's own address, signed in and from Quillipi's own page.
- Files are served with a policy that lets nothing load or run (`sandbox`), because a notebook's
  files can come from anywhere and an SVG can carry a script. In an `<img>` it never runs, but
  opened on its own it would run with the editor's address.
- The laptop alone keeps `/api/ping` and `/api/tool`, which other Quillipi processes use
  (`owner.ts`), and `/api/remote/…`, for remote access.
- The app keeps open tabs per notebook in the browser, and whether the panel is shown. It is
  light only for now.
- `overview` gives the last commit that changed each section, in one walk back through history
  that stops once every section has its commit; `visit` records that the person opened the
  overview and says when they did before, for its "since your last visit"; `details` renames
  the notebook or changes its line or colour, committed at once on its own, like renaming a
  repository, leaving anything uncommitted as it was.

The engine reaches files and history only through `NotebookStore` (`store.ts`). On a laptop
that is a folder with Git (`RepoFiles`); in the cloud it is SQLite in a Durable Object. Every
store passes the same contract tests, every store gives Git's own blob, tree and commit IDs
(checked against the real git program), and the engine's tests run both on a folder and in memory.

The engine, the agent tools and the stores live in `packages/engine` and are portable: they use
no Node-only module or global, so they can run in a Cloudflare Worker or a browser. Two guards
keep it so: the package compiles with web types only (no Node types), and `portable.test.ts`
fails on any Node import or global, or any import from outside the package. Every store passes
the contract suite in `packages/engine/test/store-contract.ts`.

In the cloud, each notebook lives in its own Durable Object, which Cloudflare runs exactly once
per notebook name: the notebook's single owner, as one engine per folder is on the laptop. Its
store is SQLite inside the object. The store is tested in Node on `node:sqlite` with the same
contract tests (Cloudflare's own test runner doesn't support vitest 5 yet), and the Worker is
tried under `wrangler dev` with `--var DEV_ROUTES:on --var PUBLIC_URL:http://localhost:8787`,
which turns on `POST /dev/tool` (any tool, `create_notebook` included, as Claude's door runs
it), `GET /dev/status`, `POST /dev/mirror` (`{"action": "retry"}`) and `GET /dev/library`.

**The library** (`library.ts`, step 3.3) is one more Durable Object, with a card for every
notebook; it replaced the list `NOTEBOOKS` in `wrangler.jsonc`, so a notebook is made with no
deploy. A notebook's ID is made from its title when it is made (`gym-rollup`, then
`gym-rollup-2`; lowercase letters, digits and hyphens, at most 60), and it is also its room's
name and its repo's name, so it never changes; the title, its line about what it is for and its
colour live in the notebook's own `inklog.json` and travel with its history. The ID is taken
before the room is asked, so two New notebooks at once never get the same one, and a room that
already holds a notebook the library doesn't list is skipped. At most 20 notebooks are made a
day, so a runaway agent can't fill the organization with repos. Claude's door asks the library
which notebook a call is for (by ID, by title, or the default: the one chosen, else the one made
first), so an unknown name creates nothing and is answered with the list; the same call brings
the owner's instructions for every notebook, which the library keeps with their earlier
versions. Each room reports how it stands after a change (`NotebookSummary` in core's
`protocol.ts`: counts, the latest commit, the four sections edited most recently, agents'
commits, the backup), at most every 2 seconds, from its alarm when it has to wait, so Home can
draw every notebook from one request without waking them; open Homes get each changed card over
a hibernating WebSocket at `/api/library/ws`.

Each cloud notebook's history lives in a private GitHub repo named after its ID in the
organization for notebooks (`GITHUB_OWNER`), kept by `mirror.ts` through the GitHub App, which is
installed on that organization with Contents read and write and Repository creation (or the
older Administration). The mirror is on when `GITHUB_APP_ID` and the secret
`GITHUB_APP_PRIVATE_KEY` are both set; `/status` says whether the key can be read.

- **Making the repo.** A new notebook starts at once with an About section and a first commit;
  its room's alarm then makes the repo with GitHub's starter commit (the Git Data API refuses an
  empty repo), checks that `main` is exactly that starter (one commit holding only a README), so
  a repo that was already there with other work is never touched, puts the cloud's first commit
  on GitHub, checks `main` once more and moves it, with force, to that commit. GitHub's history
  is then exactly the cloud's, and later commits go out as ordinary pushes. While GitHub is
  still making the repo, the room looks again every 2 seconds for up to 2 minutes before
  counting failures. The token for making repos reaches the whole organization and is used for
  that one request; every other request uses a token limited to the one repo.
- **Import.** The first tool call on a notebook the cloud doesn't have finds its repo and copies
  the first-parent history in under GitHub's own commit IDs: commit lists into an import queue,
  then oldest first each commit's tree and every blob not yet stored, checking every blob ID and
  that the files give GitHub's tree ID. Tool calls wait and say how far it has got. Without a
  repo (or without the App on it, or without `inklog.json`) nothing is created; the call says why.
- **Push.** After a tool call that made commits, the object's alarm recreates each new commit
  on GitHub: one create-tree on top of the parent's tree (new text inline, other content as
  blobs first), then create-commit with the message exactly as Git hashed it and the date in the
  commit's own time zone, then one fast-forward of `main` per step. GitHub must return the
  cloud's own tree and commit IDs.
- **Stops.** If an ID differs, or `main` moved without the cloud, the mirror stops and says so
  (in `/dev/status`, and at the top of `map`) instead of letting the histories split. Other
  failures are tried again after 30 seconds, doubling up to 30 minutes.
- **Budget.** A free-plan invocation may make 50 outgoing requests, so each step makes at most
  40, saves its progress as it goes, and asks the alarm for the next step.
- The DurableStore keeps each commit's message as Git hashed it (one newline at the end) so it
  can be sent to GitHub unchanged; `log()` shows it trimmed, as on the laptop.

Only one engine runs per folder. The first `quillipi serve` or `quillipi mcp` process writes
`.inklog/owner.json`; later ones find it and send their work to that process's local API.

## Version control

History is real Git through isomorphic-git, so people don't need Git installed.

- A commit is repo-wide. Its author is the person; when an agent made the change, a trailer
  says so: `InkLog-Agent: Claude via Claude Code`.
- **Partial commits:** people can leave out single changes. The engine builds the staged
  version of each file block by block (`core/partial.ts`) and writes the commit's tree
  directly, so the working files keep everything. Git's index is then reset to the new commit,
  so Git tools see what was left out as ordinary unstaged edits.
- **Agent commits** include only blocks the agent changed and no person touched. If a commit
  would delete a long block or cut one by more than 40%, it is held until the person approves
  it; undoing a held change puts those blocks back as they were at the last commit.
- Commit numbers (#1, #2…) are positions in history, used in the editor and in agent text.
- **Undo this commit** (`Engine.undoCommit`, the editor's `POST undo`) turns a commit's changes
  back into uncommitted changes, credited to the person. Each section is merged three ways with
  `mergeBlocks(commit, parent, now)`: the commit is the base, so its changes are reversed, and
  `now` wins where both differ, so whatever was written since stays (the reply counts those
  blocks). A section the commit made goes unless someone wrote in it since; one it deleted comes
  back where it was. A section it moved goes back unless it was moved again since, and when
  nothing changed the arrangement since, the order and folder names go back too. AI instructions
  go back unless they changed since. The notebook's first commit and the upgrade to folders can't
  be undone. It is a person's action, not an agent tool.

## Agent interface (MCP)

`quillipi mcp` speaks the Model Context Protocol over stdio. Tools: `map`, `read`, `search`,
`changes`, `patch`, `commit`, `compare`, `history`, `organize`. The server's instructions
and each tool's description are the agent's manual (`packages/engine/src/agent.ts`).

- Tools name sections by ID; a section's path, as IDs were before folders (`research/pricing`,
  with or without `sections/` and `.md`), works too while the file is there.
- `map` lists folders as `research/ "Research" · 3 sections`, with their sections indented.

- Replies are compact text, one line per block with its ID and version hash.
- Every call is one step in which the agent's app reads the whole conversation again, so the
  tools let an agent do a task in few calls: `map` can read sections too, `read` takes several
  sections, and `patch` edits several sections and can commit in the same call. Tool
  definitions ride along in every step as well, so they stay small: patch has one list of ops,
  and an op names its own section when it isn't the call's; organize's ops share one flat shape,
  because a union of four shapes repeats each field's description (313 tokens instead of 548).
- Every call is logged in `.inklog/calls/`; `inklog calls` sums the log up.
- Everything an agent reads is generated from the files by code, so it can't drift.
- After a patch, the reply lists blocks in other sections that mention the same key terms, so
  related sections stay consistent.
- Document text is described to agents as content, never instructions. The one exception is the
  owner's **AI instructions**: `runTool` puts them at the very start of every `map` reply, and of
  any other call when the agent hasn't had them for 30 minutes or they changed (who had which
  version when is kept in `.inklog/state.json`, so a cloud room waking from a nap doesn't resend
  them). They name the owner and end with a fixed line, and the server's instructions say to
  follow them. Those for every notebook come first, passed in by the host (`ToolContext`; the
  cloud's library, from step 3.3). No tool can change them, so an AI can't rewrite its own rules;
  the person changes them in the editor or by editing `AGENTS.md` (the laptop's watcher sees it),
  as an uncommitted change (`INSTRUCTIONS_CHANGE`) that only the person's commit includes.

## Remote access

Claude on claude.ai and in the Claude apps runs in the cloud and connects to MCP servers
through a public HTTPS address. `quillipi serve --public-url <address>` opens a second listener,
the door, on 127.0.0.1:4330; a tunnel (Cloudflare Tunnel) forwards the public address to it.

- **The door is a separate listener.** It serves only OAuth sign-in, the approval page and
  `/mcp`. The editor and its API stay on the local port, so they can't be reached through the
  tunnel by construction, not by a rule that could be got wrong. Requests must also carry the
  public address as their Host.
- **Quillipi is its own OAuth authorization server, for one person.** The MCP SDK's router
  handles the protocol: discovery (RFC 8414 and RFC 9728), dynamic client registration, PKCE,
  rate limits. `remote-auth.ts` decides who gets in.
- **Approval happens at the laptop.** An app's sign-in shows a six-digit code in the editor and
  the terminal; the person types it on the approval page. Five wrong codes end the request, and
  codes expire after ten minutes.
- **Tokens:** access tokens last an hour; refresh tokens rotate on every use and expire after
  90 days without use. Tokens are bound to the server's address (RFC 8707). Only SHA-256 hashes
  are stored, in `.inklog/connections.json`.
- **Stateless JSON transport.** Each request gets a fresh MCP server, and replies are plain
  JSON rather than streams, so nothing breaks when Quillipi or the tunnel restarts, and tunnels
  that can't stream still work.
- Agent work through the door is credited to the app, for example "Claude via claude.ai".
- The tools answer at `/mcp` and at the bare address, each with its own discovery document, so
  a connector added either way works.
- Access-token hashes are saved with the grants, so restarting Quillipi doesn't sign apps out.
- Failed requests are reported in the terminal in plain words. The 401 that normally starts
  sign-in is not reported, so the report has no false alarms.
- The public address is remembered per notebook in `.inklog/remote.json`.

## Claude's door in the cloud

The Worker in `apps/cloud` is the always-on way in: Claude adds `<PUBLIC_URL>/mcp` once as a
connector and signs in with GitHub, and the laptop can be off.

- **workers-oauth-provider is the authorization server.** It answers discovery (RFC 9728 and
  RFC 8414), registers apps (dynamic registration at `/register`, or an app's published identity,
  a Client ID Metadata Document, which needs the `global_fetch_strictly_public` flag), checks
  PKCE, issues and rotates tokens at `/token`, and checks the token on every request to `/mcp`.
  Its records live in the KV namespace `OAUTH_KV`: tokens only as hashes, and each grant's props
  encrypted with a key that only the token can unwrap.
- **One address.** `PUBLIC_URL` is Quillipi's address; requests sent to any other are refused with
  421. Tokens are bound to one address, and the provider keeps its helpers on `env`, which
  Cloudflare reuses between requests, so a second address would quietly use the first one's
  settings. Before the setup, with no address set anywhere, Quillipi serves the one it is reached
  at (Quillipi's settings, below).
- **Sign-in lets in one person** (`sign-in.ts`). `/authorize` shows which app asks and where
  access will be sent; Continue sends the browser to GitHub through the GitHub App's OAuth client,
  with PKCE; `/callback` trades GitHub's code for a GitHub token, asks GitHub who signed in, and
  lets in only `GITHUB_USER_ID`, GitHub's permanent numeric ID, which a renamed account keeps and
  a new account with the old name doesn't get. GitHub's token is then dropped; the grant keeps
  only how the app's work is credited.
- **The consent page is required.** Every app reaches GitHub through Quillipi's one GitHub App, so
  without it a stranger's app could ride on the person's GitHub session (MCP calls this the
  confused deputy). The library binds the consent page and GitHub's `state` to the browser with
  `__Host-` cookies, so a form posted from another site, or a sign-in link opened in another
  browser, is refused. The pages run no scripts, can't be framed, and show an app's name as text.
- **Strangers can start only so many sign-ins** (`sign-in-limits.ts`, since 0.4.1). Registering
  an app (`POST /register`) and the consent page (`/authorize`) make workers-oauth-provider write
  to Workers KV, which the Free plan allows 1,000 times a day for the whole account; if anyone
  could spend them, the owner's apps couldn't renew their tokens until midnight UTC. So the
  Worker asks the library first: a visitor (an IP address, or an IPv6 /64) may start 20 of these
  steps in ten minutes, counted only in memory, and everyone together 300 a UTC day, counted in
  the library's database. A refusal is a 429 with `Retry-After` and writes nothing. The owner,
  signed in to the app in that browser, is never limited, and if the library can't be asked the
  sign-in goes ahead. The library is one Durable Object, so the counts are exact everywhere, on
  every plan, with nothing for a newcomer to set up; Cloudflare's rate-limiting binding counts per
  location, and its docs don't say it is on the Free plan.
- **Tokens:** access tokens last an hour; refresh tokens rotate on every use, and a grant ends
  after 90 days without use, as on the laptop.
- **`/mcp` is stateless** (`door.ts`): a fresh MCP server per request on the SDK's web-standard
  transport, with plain JSON replies. It skips Ajv, which the SDK would otherwise build for every
  server, because Quillipi never asks questions through the agent and a free-plan request may use
  only 10 ms of CPU; a tool call through the whole door takes about 1 ms in Node.
- **One door, every notebook.** Every tool takes an optional `notebook`; the library says which
  room that is, and the server's instructions, sent when Claude connects, list the notebooks
  with their titles. An unknown name is refused before any room is touched. A tool call goes to
  its notebook's Durable Object over RPC, credited to "Claude via claude.ai", or "Claude via
  Claude Code" when access goes to an app on this computer. The door has one tool of its own,
  `create_notebook` (`{title, about}`, or `{github}` to add a repo already in the organization),
  about 180 tokens of definition; its reply carries the new notebook's map and About section, so
  Claude can write at once.
- `/status` says whether sign-in has its settings (`"signIn": "ready"`) without calling GitHub.
  Every failed sign-in is logged in plain words, so Cloudflare's logs show why.
- Trying it locally: `npx wrangler dev --var PUBLIC_URL:http://localhost:8787`, since only
  `PUBLIC_URL` is served; `GITHUB_WEB` and `GITHUB_API` point sign-in and the mirror at a
  stand-in GitHub.

## The app in the cloud

Since step 3.4a the cloud serves the app too: Home, every notebook, and the editor, in a browser
on any device.

- **The app's files are static assets.** `wrangler.jsonc` points Cloudflare at `apps/web/dist`;
  they are served before the Worker runs, free, and an address that matches no file gets the
  app's page, which reads the address itself. The Worker's own routes are listed in
  `run_worker_first`. The files' security headers come from `apps/web/public/_headers`, because
  Cloudflare applies `_headers` only to static files; the Worker sets its own on what it answers.
- **The browser signs in with GitHub too** (`app-sign-in.ts`), through the same GitHub App at its
  second callback, `/signin/callback`, with PKCE and the state in a short-lived signed cookie, so
  only the browser that started a sign-in can finish it. Only `GITHUB_USER_ID` is let in.
  `GITHUB_USER_LOGIN` is that account's name, for the pages and GitHub's account hint; only the
  ID decides who gets in. There is no consent page: the person signs in their own browser.
- **The session is a signed cookie** (`session.ts`), `__Host-inklog`: HttpOnly, Secure,
  SameSite=Lax, signed with HMAC-SHA-256 and the secret `SESSION_SECRET` (at least 32
  characters; without one the library makes its own). It says who signed in and until when, so nothing is written per sign-in or per
  request, and Workers KV's daily writes are untouched. It lasts 90 days and is renewed, at most
  once a day, whenever it is used. One cookie can't be cancelled alone; changing `SESSION_SECRET`
  signs every browser out. `/status` says whether it is set up (`"app": "ready"`).
- **The app's calls** (`app-api.ts`, under `/api`) need the session; those that change something,
  and every live connection, must also carry Quillipi's own `Origin`. `GET /api/home` gives Home
  everything in one request (who is signed in, every card, the visit before this one, the
  default notebook). New notebook, archiving, the default and Add from GitHub go to the
  library; the Agents page lists the apps connected to Claude's door with the provider's
  `listUserGrants` and disconnects one with `revokeGrant`. Each grant keeps the app's name in
  its readable metadata from step 3.4a; older ones are named from the app's record.
- **A notebook's calls go to its room**, only when the library has a card for it, so an unknown
  name creates nothing. The room (`notebook-object.ts`, `editor-door.ts`) answers them with the
  same `EditorApi` as the laptop, saves before replying, and pushes a new commit to GitHub. Its
  live connections are hibernating WebSockets tagged with the notebook: while the room naps the
  connections stay open at no cost, the next message wakes it, and a save based on a version
  from before is answered as stale, so the editor merges and saves again and no words are lost.
  An agent's edit reaches every open editor; a save reaches every editor but the one that made it.

### Installed, offline and updated (step 3.5)

The cloud's app can be installed, so it opens in one tap from a phone's Home Screen or a
computer's dock, and opens even without a connection.

- **The manifest and icons** (`apps/web/public/manifest.webmanifest`, `public/icons/`) name the
  app, open it at Home in its own window (`standalone`), and give its icon: Quillipi's drop of ink
  on a pale violet ground, edge to edge for Android's shapes and iPhones (`icons/icon-full.svg`),
  as a rounded tile for computers (`icons/icon.svg`). iPhones take the icon and name from
  `index.html` (`apple-touch-icon`, `apple-mobile-web-app-title`). The page reaches the screen's
  edges (`viewport-fit=cover`), so the frame keeps clear of a notch and a home bar with
  `env(safe-area-inset-*)`.
- **The service worker** (`apps/web/sw/service-worker.ts`) keeps one copy of the app's files per
  build. The app's pages (`/`, `/agents`, `/n/…`, read as `router.ts` reads them) come from the
  network first, so a fresh open is always the newest build and a deploy never leaves an old app
  talking to a new cloud; when the network fails or takes more than 4 seconds, the page kept with
  the build opens, and it says plainly that Quillipi can't be reached, with Try again, and opens
  again by itself when Quillipi answers. The app's files come from the copy, since their names
  change with their contents. Everything else, the Worker's own routes above all, is left alone.
  It is registered only in the cloud: the laptop program serves one notebook on the computer it
  runs on.
- **The build names itself.** `sw/plugin.ts` lists every file of the build after Vite has made
  them, names the build from their names and contents (so the same code builds the same app,
  byte for byte), writes the name into the page as `<meta name="inklog-build">`, and builds
  `sw.js` on its own with the name and the list in it. A new deploy changes `sw.js` only when
  the app changed, which is how a browser learns of it.
- **Updates wait for a safe moment** (`apps/web/src/installable.ts`). An app left open, as an
  installed app on a phone is, looks for a new build when it comes back to the screen, when its
  live connection comes back (a deploy closes every connection) and every hour. A new build's
  worker installs beside the one in use and waits; asked which build it has, it says, and when
  that isn't the page's own, Update shows beside the bell. The update is used on the next move
  out of the open notebook, which then loads the page afresh (a move inside it keeps the page,
  so a half-written commit message stays), or when Update is pressed. Either way every open
  section is saved first (`saveOpenSections` in `editor/sync.ts`); if one can't be, nothing
  reloads. A worker whose build is the page's own (the page came fresh from the network)
  takes over quietly. Nothing reloads by itself while you work.
- **Installing.** Chrome and Edge offer to install the app; the offer is kept for the menu under
  you (Install Quillipi), instead of the bar Chrome would show over the page. iPhones and iPads
  make no offer, so on them the menu has Add to Home Screen, which explains the Share menu.
- **Caching** (`public/_headers`): `sw.js` and the manifest are checked on every visit; the
  built files under `/assets/` are kept a year, since their names change with their contents.
- **If a service worker ever had to go**, a deploy whose `sw.js` unregisters itself and empties
  its caches would remove it from every device on its next visit, because the browser always
  checks `sw.js` past its own cache.

## Quillipi's settings

(How a new Quillipi gets them is in The first-time setup, below.)

Quillipi's address, who owns it, the GitHub App and the key that signs the browser's cookie are its
**settings** (`apps/cloud/src/settings.ts`), each named after the Worker variable or secret that
can set it: `PUBLIC_URL`, `OWNER_NAME`, `OWNER_EMAIL`, `GITHUB_OWNER`, `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_USER_ID`,
`GITHUB_USER_LOGIN` and `SESSION_SECRET`. Three are secrets (`SECRETS`): the App's private key,
its client secret and the session secret. They are never shown, and never copied from the Worker.

- **A Worker variable or secret that holds a value wins**; an empty or blank one doesn't count.
  Otherwise the value comes from the library, which keeps the settings in its `settings` table,
  each under its name, beside the default notebook. So a fresh deploy needs no file edited, and a
  key can still be kept as a Worker secret.
- **`withSettings(env, stored)`** gives `env` with the settings the Worker doesn't hold filled in
  from the library. When the Worker holds them all, the library isn't asked and
  `env` itself comes back; otherwise a new object does, so Cloudflare's `env` is never changed and
  workers-oauth-provider puts its helpers on that request's own object.
- **What the library said is kept for 30 seconds** (`KEEP_MS`) per copy of the Worker or of a
  room, keyed by its `env`, which Cloudflare reuses within a copy; never while a setting is
  missing, so no copy goes on saying "not set up" after the setup; and never after a failure.
- **The Worker** fills the settings in before anything else (`index.ts`). With no address
  anywhere, before the setup, it serves the one it is reached at, which on Cloudflare is its own
  `workers.dev` address. If the library can't be read, it goes on with its own settings, and
  `/status` shows the library failing.
- **Each room** reads them once while it is awake (`notebook-object.ts`): who its commits are made
  as (`OWNER_NAME` and `OWNER_EMAIL`, which must be known before a notebook starts) and its
  GitHub mirror, which needs `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_OWNER`. The
  room's host is built behind one promise, so two events that wake it together share it.
- **The library copies the Worker's non-secret settings** whenever it opens (`keepSettings`), since
  its Durable Object sees the same variables; a value that changed is updated, and a secret is
  never copied. When neither the Worker nor the library has a `SESSION_SECRET`, the library makes
  one (32 random bytes, 43 characters) and keeps it, so a new Quillipi never needs one made by hand.
- **`GET /api/settings`**, for the signed-in owner only, lists every setting with where its value
  comes from (`worker`, `quillipi` or `missing`), whether the library keeps it (`kept`), and the
  value of each non-secret; a secret's value is never sent. The library builds it, since it sees
  the Worker's own values.
- `/status` says `"github": "ready"` only when the mirror can run (the App, a readable key and
  the organization), and `"signIn"` names any of `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
  `GITHUB_USER_ID` and `GITHUB_USER_LOGIN` that is missing.

## The first-time setup

A newcomer's Quillipi is deployed knowing only its owner's GitHub username (the Worker variable
`GITHUB_USER_LOGIN`, the deploy form's one field). Until it is **set up** (`isSetUp` in
`settings.ts`: the App's sign-in, the owner's ID, and whom commits are made as), every way in
leads to `/setup` (`setup.ts`): the app's calls answer 503 with `setup: '/setup'` and the app goes
there, `/signin` redirects there, and Claude's `/authorize` says to wait. `/status` says
`"setup": "done"` or `"not done"`. Once set up, `/setup` and everything under it redirect to `/`,
so a Quillipi that is set up never sees it again, nor does one whose settings were set by hand
(as this repository's own was, before the setup existed; it keeps them in its library since 0.3.0).

The setup is one page that ticks off four steps, sent by the Worker with no scripts:

1. **Its address**, done by itself: the one the setup is done at, kept as `PUBLIC_URL`.
2. **An organization** for the notebooks. GitHub's API can't make one for a person, so the page
   links to GitHub's own page and takes the name typed back (`POST /setup/organization`). GitHub's
   public API checks it is an organization, not a person (`findAccount`); when GitHub refuses to
   answer (it allows a few such requests an hour without a key), the name is kept as typed. This
   step starts the setup in progress.
3. **Quillipi's GitHub App**, made from a manifest (`manifest()`): a form posts it to
   `github.com/organizations/<org>/settings/apps/new` with the setup's `state`; GitHub shows the
   App filled in, the person presses Create, and GitHub returns to `GET /setup/app` with a one-time
   code that Quillipi trades for the App's ID, keys and owner (`appFromManifest`). The App is
   private, with no webhook, Contents write, Metadata read and Repository creation write, three
   callbacks (`/callback`, `/signin/callback`, `/setup/callback`), `setup_url` `/setup/installed`
   and `setup_on_update`. Quillipi checks the App belongs to the organization, and that its
   permissions let it make repos (`canMakeRepos`); if not, the page links to the App's permissions
   and checks again with the App's key (`POST /setup/app/check`, `GET /app`).
4. **Install it and sign in.** The Install link carries the state; GitHub returns to
   `/setup/installed`. Its `installation_id` can be made up (GitHub's own warning), so Quillipi asks
   GitHub with the App's key whether it is installed on the organization, and on all
   repositories, which the repos it makes later need (`organizationInstallation`). Then straight
   on to GitHub's sign-in through the new App, with the setup's own state and PKCE, back at
   `/setup/callback`. GitHub's `request_oauth_on_install` isn't used: with it, GitHub skips the
   setup URL, so Quillipi couldn't check the installation first.

**Only the account named at deploy can finish.** The sign-in must be `GITHUB_USER_LOGIN`
(ignoring case); then, in one transaction (`Library.finishSetup`), the library keeps the
address, the owner (GitHub's profile name or the username, and the ID-based noreply address), the
organization, the App's ID, private key, client ID and client secret, and the owner's ID and
name. The browser gets its session cookie and goes Home. Nothing from a setup is used before that.

**A setup belongs to the browser that started it.** It lives in the library's `setups` table for
an hour after its last step (`SETUP_MS`), at most 20 at once, the oldest going first
(`SETUPS_KEPT`), so nobody can fill it. The browser's cookie, `__Host-inklog-setup`, holds only
its ID, signed with the session secret Quillipi makes itself; the App's keys never travel in a
cookie or a page. Every return from GitHub must carry the setup's `state`, so a link someone
sends can't plant their App in this Quillipi. Forms must carry Quillipi's own `Origin`, which is why
these pages, and the app's, send `Referrer-Policy: same-origin`: with `no-referrer` Chrome sends
`Origin: null` on a form. If the Worker already holds a setting the setup makes (such as
`GITHUB_APP_ID`), the page says so instead of starting, since the Worker's value would win and mix
two Apps. Start again throws a setup away.

**After the setup**, Home shows the Get started card (`apps/web/src/pages/GetStarted.tsx`): in a
copy, Turn on updates; then Connect Claude (`components/ConnectClaude.tsx`, also on the Agents
page: tabs for claude.ai and the phone, Claude Code and Claude Desktop, with the address to copy),
then the first notebook. Each ticks itself, and the card goes once all are done (`getStarted` in
`news.ts`):

- **Turn on updates** shows only where the build named the copy's repository (`REPOSITORY`, below).
  Cloudflare's GitHub app can't add workflow files, so a copy made with the button has no
  `.github/workflows/update.yml` (the newcomer test, S4.5). The step's button opens GitHub's
  new-file page in that repository with the file's name and text filled in (`?filename=` and
  `&value=`; the text is `deploy/.github/workflows/update.yml`, built into the app), so the owner
  presses Commit. That push makes Cloudflare build the copy again, the build finds the file
  (`UPDATE_WORKFLOW: "found"`), and the step ticks: after the button is pressed, the card asks
  `GET /api/updates` every 10 seconds for 15 minutes (not `GET /api/home`, which counts as a visit).
  If GitHub doesn't find the page (a renamed repository), the step says how to add the file by
  hand, with its name and text to copy.
- **Connect Claude**: `GET /api/home` says `claudeConnected`, which Claude's sign-in notes in the
  library the first time (`noteClaudeConnected`, also sent live to Home as `{ type: 'claude' }`); a
  Quillipi whose Claude connected before the note existed is found once by its grants
  (`listUserGrants`), then noted, so Workers KV's daily list requests are spent only until Claude
  connects.
- **The first notebook**: any card that isn't archived.

## Releases, copies and updates

Every Quillipi in the cloud runs a **release**: one file, `quillipi-<version>.json`, holding everything
a deploy uploads. It is built once, and the file that passed the tests is the file every Quillipi
runs.

- **What a release holds** (`apps/cloud/scripts/release.mjs`): the Worker as Wrangler bundles it
  (`wrangler deploy --dry-run --outdir`, without its source map), the app's built files, Quillipi's
  own Cloudflare settings from `apps/cloud/wrangler.jsonc` pointed at those files
  (`worker/index.js` with `no_bundle`, the app in `web`, no name, variables or resource IDs), the
  storage versions its code writes, and the files a copy runs (`COPY_FILES` from `deploy/`).
  Text stays text, anything else is base64, and keys and files are sorted. It holds no commit,
  time, path or anyone's settings, so a commit gives the same file on every Linux computer
  (`COMMIT` is set at deploy). Windows gives a slightly different app CSS (Lightning CSS, native
  code per system, rounds two colours differently in the 8th digit), so releases are pinned on
  Linux and CI checks them there; the Worker itself is the same on both.
- **The pin.** `deploy/quillipi-release.json` names the release a copy runs: Quillipi's repository,
  the version, the file's SHA-256 fingerprint and its storage versions. `npm run release` builds
  `release/quillipi-<version>.json` and fails unless it is the pinned file, so code that isn't
  pinned can't deploy; `npm run release -- --pin` pins a new version. Every package has Quillipi's
  one version, from the root `package.json`, and `CHANGELOG.md` says what each version brings.
- **This repository's Quillipi** (`.github/workflows/cloud.yml`, on every push to main): the tests,
  `npm run release`, then `npm run deploy:cloud` (`scripts/deploy.mjs`), which deploys it exactly
  as a copy deploys: it makes a copy from `deploy/` as the button does (`makeOwnCopy`), with
  `deploy/wrangler.jsonc` as it is but for the Worker's name, and runs that copy's `build.mjs
  --release <file>`. So the Worker `inklog` (`OWN_WORKER`, named before the product was renamed;
  its notebooks, sign-ins and address belong to that name, while a new copy's Worker is
  `quillipi`), no variables but `COMMIT` and `UPDATE_WORKFLOW` (no `REPOSITORY`, as its folder has
  no Git, so its Home has no Turn on updates), the KV namespace it already has, and its settings
  kept inside it. It waits for `/status` at the addresses Wrangler reports (its output file,
  `WRANGLER_OUTPUT_FILE_PATH`) to show the version with `"notebooks": "ok"`. Only then
  `npm run publish:release` (`scripts/publish.mjs`) publishes the file as the GitHub release
  `v<version>`, the first time that version is deployed, with its notes from `CHANGELOG.md`: a
  draft first, then the file, then made the latest, so a release is never seen without its file.
  It publishes only in the repository the pin names as its `source` (`checkSource`), because that
  is where copies look.
  A version is published once; when its release exists, its file must be this one, byte for byte.
- **A copy** is what the Deploy to Cloudflare button makes from `deploy/` (the button's address
  ends in `/tree/main/deploy`, and that folder becomes a new repository's root). On each push to
  its main, Cloudflare's builds run `npm run build` and `npm run deploy` from its `package.json`:
  `build.mjs` downloads the pinned release from GitHub (three tries, kept in `dist/`), checks its
  fingerprint, and writes `dist/worker/`, `dist/web/` and `dist/wrangler.json`, the release's
  settings joined with the copy's (`makeConfig`): its Worker's name, its variables (a blank one is
  left out, so Quillipi uses the value kept inside it), its KV namespace's ID, routes and
  `workers_dev`. Anything else in `wrangler.jsonc` is refused, never ignored. Wrangler uploads
  `dist/` as it is. The build adds three variables of what it found: `COMMIT`, the commit being
  deployed (`commitFrom`: `WORKERS_CI_COMMIT_SHA` or `GITHUB_SHA` only when it is a real commit ID,
  since Cloudflare's first build of a new copy gave `main`; else the checkout's `HEAD`, read from
  `.git` without a Git program; else `unknown` in a build service and `by hand` elsewhere);
  `REPOSITORY`, the copy's GitHub repository (`repositoryFrom`: the checkout's remote `origin`, only
  `owner/name` kept, as a clone's address can hold a token; else, in Cloudflare's build,
  `<GITHUB_USER_LOGIN>/<Worker name>`, which is how the button names it; a `REPOSITORY` in
  `wrangler.jsonc` wins); and `UPDATE_WORKFLOW`, `found` or `missing`.
- **The deploy form** asks for what `deploy/wrangler.jsonc` leaves open: the Worker's name, the
  KV namespace (the button makes it and writes its ID into the copy) and `GITHUB_USER_LOGIN`, with
  the words in `package.json`'s `cloudflare.bindings`. Workers Builds installs Wrangler from the
  copy's own lockfile, the same version this repository uses (a test keeps them equal).
- **Updates** (`deploy/update.mjs`, run every Monday by the copy's `.github/workflows/update.yml`):
  when Quillipi's latest GitHub release is newer than the pin, it downloads it and opens one issue,
  "Quillipi 0.4.0 is ready", with the release's notes and how to update, and keeps that issue up to
  date. Running the workflow by hand applies it: the release's copy files and a new pin are
  written, committed as "Update Quillipi to 0.4.0" by `github-actions[bot]` and pushed, which
  Cloudflare deploys, and the issue closes. Reverting that commit undoes it; `QUILLIPI_UPDATES:
  automatic` applies updates in the weekly run. An update never writes `wrangler.jsonc` or
  anything under `.github/` (a workflow's token can't change workflow files), so the workflow
  stays as it is and the work is in `update.mjs`, which every update brings up to date. A
  release's `version` and `copy` keep their shape in every format, so an older `update.mjs` can
  always bring in the scripts that read a newer one. Without GitHub Actions, `npm run update` and
  `npm run update -- apply` do the same by hand.
- **New Cloudflare resources ride with a release.** A binding the release's settings name without
  an ID is made by Wrangler on the copy's next deploy (its automatic provisioning) and kept after.
- **What the newcomer test found** (S4.5, 2026-11-22): the button names the repository after the
  project (`quillipi`, private), the form's `GITHUB_USER_LOGIN` and the KV namespace's ID land in
  the copy's `wrangler.jsonc`, and `.github/workflows/update.yml` is not copied (most likely GitHub
  refuses workflow files from an app without the workflows permission), which is why Home has
  Turn on updates.

### Storage versions

The library and every room record the shape of storage that wrote them: `LIBRARY_STORAGE`
(`library.ts`, under `storage` in its `settings` table) and `ROOM_STORAGE` (`durable-store.ts`,
under `storage` in the room's `meta` table). Both are 1, the shape kept before versions were
recorded, and a database without one is version 1. `claimStorage` checks it before anything else
is written: a database saved by a newer Quillipi is refused (`StorageTooNew`) and left exactly as
it was, so going back to an older release can never damage a notebook; that room or library stays
closed, saying why in `/status`, until Quillipi is updated again. A release that changes a shape
raises its version and moves older databases forward as it opens them. Releases record both
versions, and a copy's update notice and commit say when an update moves them, as reverting it
afterwards would close what the newer one saved.

## Toward several people

Quillipi is one owner with their AIs today; one notebook shared by several people, each with one or
more AIs, is where it is going. What is in place for that, and what comes next:

- **In place.** People are known by GitHub's numeric ID, which survives a rename, and Claude's
  grants are kept per GitHub account. Every change and commit records who made it, a person or
  an agent, and agents commit only their own changes. Each notebook is one Durable Object, which
  takes its changes one at a time. Releases carry storage versions, so the shape that adds members
  can move every notebook forward, and never back.
- **Next.** Members with roles (owner, editor, viewer) per notebook; an actor per person in the
  engine, where today `person` is the one owner and commits are made as `OWNER_NAME`, each with
  their own agents and modes; the person-wins merge, per person; sign-in that lets in members, not
  one account; and Yjs on the save path for two people typing in one block (Decisions). Workers
  KV's free plan allows 1,000 writes a day, which a team's sign-ins would reach, so sign-in
  records move to the library's SQLite before teams.

## Editor

React and TipTap (ProseMirror). The schema is **flat**: every top-level node is one block,
including list items (`bulletItem`, `orderedItem`, `taskItem`), which matches the file format
one to one. Ordered lists are numbered with CSS counters.

- `blockIds.ts` keeps every top-level ID unique and stable through splits, pastes and drags.
- `convert.ts` converts between blocks and TipTap documents, and applies changes from elsewhere
  by replacing only the blocks that differ.
- `Margin.tsx` measures block positions and draws the change bars beside the page. It never
  touches the document.
- Figures are node views that float left or right so text wraps around them. The drawing
  editor keeps changes local until Done, so a whole drawing session is one undo step.

The app's own screens are built with Tailwind CSS 4 and Radix primitives (since step 3.4c): the
colours and type are tokens in `index.css`, named as shadcn/ui names them, so components written
for it work unchanged; menus, dialogs, popovers and tooltips are Radix, wrapped in `ui/`. Only the
document keeps a stylesheet of its own (`editor/editor.css`), loaded into Tailwind's components
layer.

A notebook's pages share one frame: the bar of tabs along the top (`components/Tabs.tsx`; the
first tab is the overview; a tab shows its section's marks, and × when pointed at), then one
toolbar row (`Toolbar.tsx`, with the Doc, File and AI view switch at its end), then the page, with
the breadcrumb above the title, and beside it the History panel (`frame/HistoryPanel.tsx`):
changes waiting for approval, the uncommitted changes with ticks and Commit, and every commit,
each opening in place to what it touched (`GET commit`, worked out once per commit by
`Engine.commitDetails`) with View this version, Compare with now and Undo this commit. The panel
holds the notebook's tree (`frame/NotebookTree.tsx`), which is the 21st.dev `animated-file-tree`
component in `tree/AnimatedTree.tsx` with its own markup, Tailwind classes, timings and springs
(`motion`). The tree adds the WAI-ARIA
keys (one Tab stop, arrows, Home, End, type to jump), keeps rows in closed folders `inert`, shows
the open section's level-2 headings with the accent line following the one being read, and moves
sections and folders by drag and drop or a ··· menu (Move to…, Move up, Move down, Rename, Delete),
all through the editor's `organize` and `delete` calls. Where a drop lands, and where a row may
move, are pure functions in `tree/model.ts`. The tabs, the open folders and the last section open
are remembered per notebook in local storage.

## Decisions and why

| Decision | Why |
| --- | --- |
| Files plus Git, no database | People own their docs; nothing to host; everything is portable |
| Our own Markdown reader and writer | Exact round trips and block IDs; general parsers keep neither |
| Flat block schema | One node per block keeps IDs, diffs and the file format simple |
| Block-level merge, no CRDT yet | A person plus agents only collide per block. Yjs can replace the save path for live team editing later without changing the files |
| Our own drawing format, not Excalidraw | Agents must read and edit drawings cheaply and exactly; the format is small and diffable by element ID |
| isomorphic-git | No native modules and no Git install needed |
| Remote access through a separate listener and a tunnel | The editor can never be reached from outside; no ports are opened on the router |
| OAuth with an approval code typed by the person | Only someone at the laptop can let an app in; it is the sign-in Claude's connectors expect |
| GitHub sign-in for the cloud, one account by its numeric ID | The laptop may be off, so nobody can type a code there; an ID survives a rename and can't be taken over |
| workers-oauth-provider for the cloud's sign-in | Cloudflare's own library for remote MCP servers, with consent and state bound to the browser |
| One `notebook` argument on every tool | One connector for all notebooks, no extra call, and no remembered choice that two chats could share |
| The browser's session is a signed cookie, not a stored session | Nothing to write per sign-in or request, within the free KV limits; the price is that only a new `SESSION_SECRET` signs a browser out |
| Settings kept in the library, a Worker variable winning when it holds a value | A fresh deploy works with no file to edit, the public repo holds nobody's values, and anyone can still keep a key as a Worker secret |
| Renaming a notebook is a commit of its own | The title lives in `inklog.json` so it travels with the history; committing it at once, like renaming a repository, says when it was called what and leaves other work uncommitted |
| Tailwind CSS and Radix for the app's screens | Contributors know them, the supplied tree component uses Tailwind's classes as they are, and Radix gives menus, dialogs and tooltips their keyboard and focus behaviour; hand-written CSS copies of both had drifted and gone wrong |
| A notebook's folder on Home is Quillipi's own component | Three rounded boxes and one inverse corner, with no clip-path or backdrop filter, so every corner is round in every browser; it follows Cloud Dock's folders and keeps the supplied glass folder's idea of sheets that rise on hover |
| No tool can change the AI instructions | An AI can never rewrite its own rules, and text hidden in a page can't make it; only the app's editor (and, for every notebook, the cloud's `POST /api/instructions`, which another site can't call) changes them |
| Dependencies pinned to exact versions at least two weeks old | Reproducible installs, and no fresh release slips in |
| Copies are a small folder that runs Quillipi's release files, pinned by fingerprint (since 0.3.0) | Built once, every Quillipi runs the exact file that passed the tests; an update changes Quillipi's own files and a pin, never code its owner changed, so it can't conflict; migrations and new resources ride with each release |
| Updates come as a weekly issue and one click, automatic on request (since 0.3.0) | The owner sees what is new and decides when; undoing is one revert |
| This repository's Quillipi deploys through the release path, before copies get it (since 0.3.0) | It runs exactly what copies will, and a release is published only after it answers with its notebooks open |
| Storage versions that refuse newer data | Going back to an older release can't damage notebooks, which matters more once several people share one; refusing shows in `/status` |
| One version for every package | One Quillipi: the same number in `/status`, the laptop program and the releases |
| `legacy-peer-deps` in `.npmrc` | npm 10 crashes on an optional peer loop between vite and vitest add-ons that Quillipi never installs |

## Testing

- `packages/core/test`: the file format and inline formatting are checked with thousands of
  random round trips, plus diffs, merges, partial commits, patches and agent text, and what the
  editor does after a save, with a randomized check that a stale reply never drops the person's
  words.
- `packages/engine/test`: the store contract, Git's IDs, the portability guard, `EditorApi` on a
  store in memory, and saves across a restart: an engine opened again on the same store in the
  middle of typing, with the editor played by `core/after-save.ts`. `folders.test.ts` covers
  organize, the arrangement in commits, deletes, history across moves, old names, copies and
  moves made outside Quillipi, and the upgrade from nested sections, including running it twice.
- `apps/inklog/test`: the engine against real folders and real Git history (checked with the
  `git` command when it is installed), including the upgrade and moves with Git left clean and a
  `git mv` seen through the file watcher, the server's security checks at the notebook's addresses,
  the MCP protocol end to end, and remote access as Claude uses it, driven by the MCP SDK's own
  OAuth client.
- `apps/cloud/test`: the cloud's store against the same contract on `node:sqlite`, the Worker's
  routes, sign-in and `/mcp` end to end (the MCP SDK's own OAuth client, a browser that keeps
  cookies, GitHub's side of sign-in with PKCE checked, and KV in memory), including the attacks
  the consent page stops, the library and one-click notebooks end to end (`library.test.ts`,
  `new-notebooks.test.ts`, with the real library and rooms on `node:sqlite` in `fake-cloud.ts`),
  and the GitHub mirror against a stand-in GitHub (`fake-github.ts`, with an organization that
  makes repos with a starter commit) that checks the
  App's JWT signature, limits tokens to one repo, and hashes blobs and commits in its own code
  with messages kept byte for byte, so a wrong message or date shows up as a different ID.
- `packages/engine/test/instructions.test.ts` and `undo.test.ts`: AI instructions (when agents get
  them, across a restart, shared ones first, that no tool can change them, committing them) and
  undo this commit (later edits kept, sections made and deleted, moves, the order, instructions),
  plus tidying unused images and titles kept as plain text.
- `apps/web/test`: the editor's own conversion, run in Node without a browser, checks that
  agents' text comes back from the editor unchanged, and the app's addresses and covers; and
  (step 3.4b) the tree's moves: where a dropped row lands, that a folder never goes inside itself,
  where Move to… may send a row, finding sections, the tabs' order and Home's shelf layout.
- The first-time setup (`setup.test.ts`): a fresh Quillipi through all four steps against the
  stand-in GitHub, which also makes an App from the manifest, installs it and signs the owner in;
  then the App works with the settings kept. And what must not happen: another account
  finishing, returns from another browser or with another state, a made-up installation, an App
  under another account or without Repository creation, some repositories only, a person's
  account as the organization, forms from another site, a setup left for an hour, the owner's
  name shown as page code, and the setup on a Quillipi that is set up.
- The app in the cloud (`app.test.ts`): the browser's sign-in through the stand-in GitHub (a
  return from another browser, an old one, one cancelled, another account, a link that would
  send the browser elsewhere), the session cookie (tampered, another secret, expired, another
  account, renewed), the app's calls with and without Quillipi's `Origin`, New notebook, Home's one
  request with the visit before, and a notebook's calls through its room; `sign-in.test.ts`
  lists and disconnects connected apps; `notebook-host.test.ts` plays the editor's live
  connection, a nap included; `packages/engine/test/app-frame.test.ts` covers renaming, the
  overview's last commits, visits and the last agent.
- `apps/web/test/service-worker.test.ts` runs the service worker against a stand-in for its
  scope: which requests it takes (the app's pages as the router reads them, never a route in
  `wrangler.jsonc`'s `run_worker_first`), the page from the network, the preloaded one, the kept
  one when offline or slower than 4 seconds, files from the copy (never a page kept in a file's
  place), a new build waiting until told, older copies removed; and the build's list and name.
  `save-before-update.test.ts` checks that every open section is saved before an update loads.
- Releases and copies (`release.test.ts`, `copy.test.ts`): a release is the same file whatever
  order it is read in, carries Quillipi's settings pointed at its files and nobody's values, and
  every file of `deploy/` that is Quillipi's; the pin, the versions, Wrangler and Node.js agree
  across the repository, and the deploy form describes what it asks. A copy's build reads JSONC,
  downloads with retries, refuses any file but the pinned one, joins settings and refuses the
  rest, and unpacks byte for byte. Updates against a stand-in GitHub: one issue, kept up to date,
  applied by hand or automatically, a copy's own files never written, issues turned off, the
  storage warning, and the same without Actions. This repository's deploy makes a copy that keeps
  its own Worker, and waits for the version with the notebooks open; publishing makes a draft first,
  publishes a version once, and only where the pin sends copies. The storage
  versions are in `durable-store.test.ts` and `library.test.ts`, including a database a newer
  Quillipi wrote, left untouched.
- By hand for 0.3.0: the release built twice is the same file; a copy made from `deploy/`, with
  Wrangler from its own lockfile, builds from it and uploads exactly what a deploy from source
  does, and runs under `wrangler dev`; `deploy.mjs` and `publish.mjs` ran against stand-ins for
  Wrangler and GitHub.
- The screens are tried in Chrome with Playwright, against the laptop program and against the
  Worker under `wrangler dev` with a stand-in GitHub, at 1440, 1024 and 390 pixels wide. For
  step 3.5 also: installability as Chrome judges it, opening offline, an update across real
  rebuilds, an iPhone with a notch, and Chrome's install offer.
- The editor was tested by hand and with scripted browser runs. Adding those runs to the repo
  as Playwright tests is a good next step.

## Conventions

- Small functions with plain names. If a function needs a comment to say *what* it does,
  rename or split it; comments explain *why*, and anything surprising.
- `core` stays pure: no file system, network, DOM or timers.
- Every change to the file format or the diff and merge rules comes with tests.
