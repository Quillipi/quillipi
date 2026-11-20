#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readCalls, renderCalls, sinceDays } from '@inklog/engine';
import { UserError } from '@inklog/engine';
import { DEFAULT_REMOTE_PORT } from './remote.js';
import { RepoFiles } from './repo.js';
import { LAYOUT } from '@inklog/engine';
import { DEFAULT_PORT, rememberedPublicUrl, serve, serveMcp } from './session.js';
import { importMarkdown, initFolder } from './setup.js';

const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `Quillipi ${VERSION}: documents with history, for people and AI agents.

Usage
  quillipi init [folder]            Start a docs folder (default: this folder)
  quillipi import <from> [folder]   Copy the Markdown files in <from> into a docs folder
  quillipi serve [folder]           Open the editor in your browser
  quillipi mcp [folder]             Run the MCP server for Claude and other AI agents
  quillipi calls [folder]           Show the tool calls AI agents made, and how much text they carried

Options
  --name <name>     Your name for commits (init; default: from Git or your user name)
  --email <email>   Your email for commits (init)
  --port <port>     Port for the editor (default: ${DEFAULT_PORT})
  --no-open         Don't open the browser (serve)
  --public-url <url>   Let Claude on claude.ai and in the Claude apps use this notebook,
                       through a tunnel from this address (serve; or set QUILLIPI_PUBLIC_URL).
                       Remembered for the notebook; "off" turns remote access off.
  --remote-port <port> Port the tunnel forwards to (default: ${DEFAULT_REMOTE_PORT})
  --days <days>     How many days back to show (calls; default: 7)
  -h, --help        Show this help
  -v, --version     Show the version
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      name: { type: 'string' },
      email: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean', default: true },
      'public-url': { type: 'string' },
      'remote-port': { type: 'string' },
      days: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) return console.log(VERSION);
  if (values.help || !command) return console.log(HELP);
  const folder = (index: number) => path.resolve(rest[index] ?? '.');

  switch (command) {
    case 'init': {
      const dir = folder(0);
      await initFolder(dir, { name: values.name, email: values.email });
      console.log(`Started a Quillipi folder in ${dir}.\nNext: quillipi serve "${dir}"`);
      return;
    }
    case 'import': {
      if (!rest[0]) throw new UserError('Say which folder to import from: quillipi import <from> [folder]');
      const { imported, skipped } = await importMarkdown(rest[0], folder(1));
      console.log(`Imported ${imported.length} document(s).${skipped.length ? ` Skipped ${skipped.length} that already exist: ${skipped.join(', ')}` : ''}`);
      return;
    }
    case 'serve': {
      const dir = folder(0);
      const port = portNumber(values.port, DEFAULT_PORT);
      const publicUrl = rememberedPublicUrl(dir, values['public-url'] ?? process.env.QUILLIPI_PUBLIC_URL);
      const remote = publicUrl && { publicUrl, port: portNumber(values['remote-port'], DEFAULT_REMOTE_PORT) };
      return serve(dir, { port, open: values.open, version: VERSION, remote });
    }
    case 'mcp':
      return serveMcp(folder(0), VERSION);
    case 'calls': {
      const repo = new RepoFiles(folder(0));
      if ((await repo.read(LAYOUT.meta)) === undefined) throw new UserError(`${repo.dir} is not a Quillipi folder.`);
      const days = values.days === undefined ? 7 : Number(values.days);
      if (!Number.isInteger(days) || days < 1) throw new UserError(`"${values.days}" is not a number of days.`);
      return console.log(renderCalls(await readCalls(repo, sinceDays(days)), { days }));
    }
    default:
      throw new UserError(`There is no "${command}" command. Run quillipi --help to see them.`);
  }
}

function portNumber(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`"${value}" is not a port number.`);
  return port;
}

main().catch((error) => {
  console.error(error instanceof UserError || (error instanceof Error && 'code' in error && error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') ? error.message : error);
  process.exit(1);
});
