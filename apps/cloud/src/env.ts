import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { LibraryObject } from './library-object.js';
import type { NotebookObject } from './notebook-object.js';

/**
 * What the Worker gets from Cloudflare: variables and secrets, and bindings. The variables and
 * secrets named in settings.ts are Quillipi's settings: each may also be kept in the library, and
 * any may be missing until Quillipi is set up, so the code reads them after withSettings
 * (settings.ts) and checks them where it needs them.
 */
export interface Env {
  /** Quillipi's address, such as https://quillipi.octocat.workers.dev. Sign-in issues tokens for it alone. */
  PUBLIC_URL?: string;
  /** The commit that is live, set by the build (deploy/build.mjs) from Cloudflare's, GitHub Actions' or the checkout's. */
  COMMIT: string;
  /** A copy's GitHub repository, "owner/name", as its build found it; missing for a Quillipi built outside one. */
  REPOSITORY?: string;
  /** "found" when the copy's build saw .github/workflows/update.yml, its weekly update check; "missing" when not. */
  UPDATE_WORKFLOW?: string;
  /** Who the cloud's commits are made as. Only this person can sign in, so it is always them. */
  OWNER_NAME?: string;
  OWNER_EMAIL?: string;
  /** The GitHub organization for notebooks: each notebook's repo is there, named after its ID. */
  GITHUB_OWNER?: string;
  /** The GitHub App's ID. With the private key, it turns the GitHub mirror on. */
  GITHUB_APP_ID?: string;
  /** The GitHub App's private key: a secret. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Sign-in with GitHub goes through the same App, as its OAuth client. */
  GITHUB_CLIENT_ID?: string;
  /** The App's client secret: a secret. */
  GITHUB_CLIENT_SECRET?: string;
  /** The one GitHub account let in, by its permanent numeric ID, which a renamed account keeps. */
  GITHUB_USER_ID?: string;
  /** That account's name, such as OctoCat: shown on the sign-in pages and suggested to GitHub. Only the ID decides who gets in. */
  GITHUB_USER_LOGIN?: string;
  /** Signs the browser's session cookie (session.ts): a secret of at least 32 characters. Without one, the library makes its own. */
  SESSION_SECRET?: string;
  /** Other addresses for GitHub's API and website, only for trying the cloud against a stand-in. */
  GITHUB_API?: string;
  GITHUB_WEB?: string;
  /** "on" only under `wrangler dev`, for trying the tools by hand. */
  DEV_ROUTES?: string;
  /** One room per notebook, named by the notebook's ID. */
  NOTEBOOK: DurableObjectNamespace<NotebookObject>;
  /** The library: one object, LIBRARY_NAME, with a card for every notebook and Quillipi's own settings. */
  LIBRARY: DurableObjectNamespace<LibraryObject>;
  /** Sign-in records kept by workers-oauth-provider: apps, grants and tokens, the tokens only hashed. */
  OAUTH_KV: KVNamespace;
  /** Set by workers-oauth-provider for the sign-in pages. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Env for one request: its settings filled in, and Quillipi's address always known. */
export type Served = Env & { PUBLIC_URL: string };
