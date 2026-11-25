import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import type { ZodRawShape } from 'zod';
import { INSTRUCTIONS, TOOLS } from './agent.js';

/** Where tool calls run: in this process, or in the Quillipi process that owns the folder. */
export interface ToolHost {
  call(name: string, args: unknown, agent: string): Promise<string>;
}

export interface McpServerOptions {
  /**
   * Who is calling, for commit trailers and the activity list. By default it comes from the name
   * the client gave when it connected.
   */
  agent?: () => string;
  /** Instructions for the agent in place of the usual ones, such as with the cloud's notebooks. */
  instructions?: string;
  /** Arguments every tool takes besides its own, which the host reads, such as which notebook. */
  extraArgs?: ZodRawShape;
  /**
   * Tools only this host has, such as the cloud's create_notebook. They take only their own
   * arguments, and their calls go to the host like the others.
   */
  tools?: Record<string, HostTool>;
  /** The address of Quillipi's icon, for apps that show the server with one (a PNG of 192 by 192). */
  icon?: string;
}

export interface HostTool {
  title: string;
  description: string;
  schema: ZodRawShape;
  readOnly: boolean;
}

/**
 * Names of MCP clients as they introduce themselves over stdio, and how Quillipi credits them. A
 * client that gives a title (MCP 2025-06-18) and isn't listed here is credited by its title.
 */
const KNOWN_CLIENTS: Record<string, string> = {
  'claude-ai': 'Claude via Claude Desktop',
  'claude-code': 'Claude via Claude Code',
  'codex-mcp-client': 'Codex',
  'cursor-vscode': 'Cursor',
  'Visual Studio Code': 'VS Code',
  'gemini-cli-mcp-client': 'Gemini CLI',
};

/**
 * Quillipi never asks the person questions through the agent (MCP elicitation), so it needs no
 * JSON Schema checker. Without this, the SDK builds Ajv for every server, and remote doors make a
 * server per request; in the cloud a request may use only 10 ms of CPU.
 */
const NO_ELICITATION: jsonSchemaValidator = {
  getValidator: () => () => ({ valid: false, data: undefined, errorMessage: 'Quillipi does not ask questions.' }),
};

/** How the server introduces itself to an app that connects: its name, the one people read, and its website. */
const SERVER = { name: 'quillipi', title: 'Quillipi', websiteUrl: 'https://quillipi.app' };

/**
 * What a tool may do, for apps that ask the person before a tool writes (ChatGPT and Codex ask
 * before any tool not marked read-only, and MCP takes a tool without hints as destructive and
 * reaching outside). Readers change nothing. Writers are not destructive: every change is
 * uncommitted work or a commit, which can be undone, and large deletions wait for the person.
 * No tool reaches beyond the notebooks.
 */
function hints(title: string, readOnly: boolean) {
  // Apps from before MCP 2025-06-18 read a tool's title only here.
  return readOnly
    ? { title, readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    : { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

export function createMcpServer(host: ToolHost, version: string, options: McpServerOptions = {}): McpServer {
  const icons = options.icon ? [{ src: options.icon, mimeType: 'image/png', sizes: ['192x192'] }] : undefined;
  const server = new McpServer({ ...SERVER, version, ...(icons ? { icons } : {}) }, { instructions: options.instructions ?? INSTRUCTIONS, jsonSchemaValidator: NO_ELICITATION });
  const agent =
    options.agent ??
    (() => {
      const client = server.server.getClientVersion();
      const name = client?.name ?? 'An AI agent';
      return KNOWN_CLIENTS[name] ?? (client?.title?.trim() || name);
    });

  const tools = [
    ...Object.entries(TOOLS).map(([name, definition]) => [name, { ...definition, schema: { ...definition.schema, ...options.extraArgs } }] as const),
    ...Object.entries(options.tools ?? {}),
  ];
  for (const [name, definition] of tools) {
    const config = { title: definition.title, description: definition.description, inputSchema: definition.schema, annotations: hints(definition.title, definition.readOnly) };
    server.registerTool(name, config, async (args: unknown) => {
      try {
        return { content: [{ type: 'text' as const, text: await host.call(name, args, agent()) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `✗ ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    });
  }
  return server;
}
