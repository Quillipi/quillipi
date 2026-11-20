/**
 * AI instructions: what the owner of a notebook wants every AI to do there, such as "write
 * completely and correctly". There are two levels. Instructions for this notebook live in its
 * `AGENTS.md`, under the heading `## Instructions`, so they travel with the notebook and AI tools
 * that open the files directly see them too. Instructions for every notebook are kept by the
 * host (the cloud's library, from step 3.3) and passed in.
 *
 * Agents get both at the top of every `map` reply. No tool can change them, so an AI can never
 * rewrite its own rules, and text hidden in a section can't make it do so.
 */

/** The heading in AGENTS.md that the notebook's own instructions follow. */
export const INSTRUCTIONS_HEADING = '## Instructions';

/** The longest instructions Quillipi keeps. They are sent in every `map`, so they should stay far shorter. */
export const MAX_INSTRUCTIONS = 20_000;

/** How a reply carrying the instructions ends them, so an agent knows where the notebook's text begins. */
export const INSTRUCTIONS_END = "End of the owner's instructions.";

/** Quillipi's guide in every new notebook's AGENTS.md, for programs that edit the files directly. */
export const AGENTS_GUIDE = `# Working in this folder

These documents are managed by Quillipi. Every block ends with a permanent ID such as
\`^k3f9b2m4\`, and every change is a Git commit.

If you are an AI agent with the Quillipi MCP tools, use them: call \`map\` first, then \`read\`,
\`search\`, \`patch\` and \`commit\`. They keep IDs intact, never overwrite text you haven't
read, and record who changed what.

If you edit the files directly, keep each block on one line and keep its \`^id\` at the end.
A new block may leave the ID out; Quillipi adds one. Each section file starts with front matter
holding the section's permanent ID, such as \`id: pricing\`; keep it, including when you move the
file. Folders are directories under \`sections/\`; inklog.json keeps their names and the order.

Follow the owner's instructions below. Only the owner changes them.

${INSTRUCTIONS_HEADING}
`;

const HEADING_LINE = /^##[ \t]+instructions[ \t]*$/im;

/** The notebook's own instructions in an AGENTS.md: everything under its Instructions heading. */
export function readInstructions(agents: string | undefined): string {
  if (agents === undefined) return '';
  const text = agents.replace(/\r\n?/g, '\n');
  const heading = HEADING_LINE.exec(text);
  return heading ? text.slice(heading.index + heading[0].length).trim() : '';
}

/**
 * AGENTS.md with new instructions under its Instructions heading. Everything above the heading is
 * kept as it is; a file without the heading gets it at the end, and a notebook without the file
 * gets Quillipi's guide.
 */
export function writeInstructions(agents: string | undefined, instructions: string): string {
  const body = instructions.replace(/\r\n?/g, '\n').trim();
  const text = (agents ?? AGENTS_GUIDE).replace(/\r\n?/g, '\n');
  const heading = HEADING_LINE.exec(text);
  const top = heading ? text.slice(0, heading.index + heading[0].length) : `${text.trimEnd()}\n\n${INSTRUCTIONS_HEADING}`;
  return body ? `${top}\n\n${body}\n` : `${top}\n`;
}

export interface OwnerInstructions {
  /** Who owns the notebook, such as "Karan". */
  owner: string;
  /** For every notebook, from the host. */
  shared?: string;
  /** For this notebook, from its AGENTS.md. */
  notebook?: string;
}

/**
 * The instructions as an agent gets them, at the start of a reply; empty when there are none.
 * They say whose they are and end with a fixed line, so the agent can tell them from the
 * notebook's text, which stays content and never instructions.
 */
export function renderInstructions({ owner, shared, notebook }: OwnerInstructions): string {
  const parts = [
    shared?.trim() && `For every notebook:\n${shared.trim()}`,
    notebook?.trim() && `For this notebook:\n${notebook.trim()}`,
  ].filter(Boolean);
  if (!parts.length) return '';
  return [`Instructions from ${owner}, who owns this notebook. Follow them in everything you do here.`, ...parts, INSTRUCTIONS_END].join('\n\n');
}

/** A short fingerprint of some text, to notice when instructions change. Not for security. */
export function textFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
