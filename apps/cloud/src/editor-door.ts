/**
 * The editor's calls to a notebook's room, /api/n/<id>/…, turned into EditorApi calls and back
 * into responses. The room's Durable Object (notebook-object.ts) uses it, and so do the tests in
 * Node, so both run the same code. The Worker has already checked the browser's sign-in.
 */
import { type EditorCall, MAX_IMAGE_BYTES, UserError } from '@inklog/engine';
import type { NotebookHost } from './notebook-host.js';

/** The path after `/api/n/<id>/`, such as `section` or `files/assets/9f2c41d0.png`, still URL-encoded. */
export function editorPath(pathname: string): string {
  return pathname.slice('/api/n/'.length).split('/').slice(1).join('/');
}

/**
 * Answers one call. `shared` gives the owner's instructions for every notebook, which only the
 * calls that show what an AI gets need, so the library is asked only for those.
 */
export async function answerEditor(host: NotebookHost, request: Request, shared: () => Promise<string>): Promise<Response> {
  const url = new URL(request.url);
  const path = editorPath(url.pathname);
  // The body is read before answering, even by calls that don't use it: the Worker streams it
  // here, and a stream left unread when the answer goes back is reported as an error.
  let bytes: Uint8Array;
  try {
    bytes = await readBody(request, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof UserError) return Response.json({ error: error.message }, { status: 413 });
    throw error;
  }
  const call: EditorCall = {
    method: request.method,
    path,
    query: url.searchParams,
    contentType: request.headers.get('content-type') ?? undefined,
    body: async (limit) => {
      if (bytes.length > limit) throw tooLarge(limit);
      return bytes;
    },
  };
  const instructions = path === 'agent-view' || path === 'instructions' ? await shared() : undefined;
  const reply = await host.editorCall(call, instructions || undefined);
  if ('json' in reply) return Response.json(reply.json, { status: reply.status, headers: { 'cache-control': 'no-store' } });
  return new Response(reply.bytes, { status: reply.status, headers: reply.headers });
}

/** The request's body, refusing more than `limit` bytes, before reading any of it when the size is known. */
async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw tooLarge(limit);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > limit) throw tooLarge(limit);
  return bytes;
}

function tooLarge(limit: number): UserError {
  return new UserError(`That is too large; the limit is ${Math.round(limit / 1024 / 1024)} MB.`);
}
