/**
 * Sign-in for remote access. Quillipi is its own OAuth authorization server, for one person.
 *
 * An app such as Claude registers itself, then sends the person to Quillipi's approval page.
 * The person approves by typing the six-digit code Quillipi shows on their laptop, so only
 * someone at the laptop can grant access. The SDK's router handles the protocol (discovery,
 * registration, PKCE checks, rate limits); this class decides who gets in. Tokens are random,
 * and only their SHA-256 hashes are kept, in .inklog/connections.json.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { RemoteStatus } from '@inklog/core';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { approvalPage, messagePage, pageHeaders } from './approval-page.js';
import { LAYOUT, type NotebookStore } from '@inklog/engine';

export const SCOPE = 'notebook';

const STATE_FILE = `${LAYOUT.local}/connections.json`;
const MINUTE = 60_000;
const ACCESS_TOKEN_LIFETIME = 60 * MINUTE;
/** Refresh tokens rotate on every use. A connection unused for this long must be approved again. */
const REFRESH_TOKEN_LIFETIME = 90 * 24 * 60 * MINUTE;
const APPROVAL_LIFETIME = 10 * MINUTE;
const AUTHORIZATION_CODE_LIFETIME = MINUTE;
const CODE_ATTEMPTS = 5;
/** Anyone can register (approval is the gate), so the list of registered apps is kept short. */
const MAX_APPS = 20;
const MAX_WAITING = 3;

interface Grant {
  id: string;
  clientId: string;
  refreshHash: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

interface Waiting {
  id: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  code: string;
  attempts: number;
  expiresAt: number;
}

type Outcome = 'approved' | 'declined' | 'replaced';

/** What the approval form leads to: back to the app, or a page shown again (with an error). */
export type Decision = { redirect: string } | { status: number; html: string; returnTo?: string };

export class RemoteAuth implements OAuthServerProvider {
  private waiting = new Map<string, Waiting>();
  private codes = new Map<string, { clientId: string; params: AuthorizationParams; expiresAt: number }>();
  /** Kept on disk with the grants, so a restart of Quillipi doesn't sign apps out. */
  private accessTokens = new Map<string, { clientId: string; grantId: string; expiresAt: number }>();
  /** What became of requests that no longer wait, so an old approval page can say what happened. */
  private finished = new Map<string, { outcome: Outcome; at: number }>();
  private saveTimer?: NodeJS.Timeout;

  private constructor(
    private readonly repo: NotebookStore,
    /** This server's MCP address. Tokens are only valid for it. */
    private readonly resource: URL,
    private readonly notebook: string,
    private readonly onChange: () => void,
    private readonly saved: { clients: OAuthClientInformationFull[]; grants: Grant[] },
  ) {}

  static async load(repo: NotebookStore, resource: URL, notebook: string, onChange: () => void): Promise<RemoteAuth> {
    const saved = JSON.parse((await repo.read(STATE_FILE)) ?? '{}');
    const auth = new RemoteAuth(repo, resource, notebook, onChange, { clients: saved.clients ?? [], grants: saved.grants ?? [] });
    for (const { hash: key, ...entry } of saved.accessTokens ?? []) if (entry.expiresAt > Date.now()) auth.accessTokens.set(key, entry);
    return auth;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.saved.clients.find((client) => client.client_id === clientId),
      // The SDK assigns client_id before calling this, because client ID generation is on.
      registerClient: (client) => this.register(client as OAuthClientInformationFull),
    };
  }

  private async register(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    for (const uri of client.redirect_uris) {
      const url = new URL(uri);
      const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !loopback) throw new InvalidClientMetadataError('Redirect addresses must use https.');
    }
    const connected = new Set(this.saved.grants.map((grant) => grant.clientId));
    this.saved.clients.push(client);
    while (this.saved.clients.length > MAX_APPS) {
      const unused = this.saved.clients.findIndex((old) => old !== client && !connected.has(old.client_id));
      if (unused < 0) break;
      this.saved.clients.splice(unused, 1);
    }
    await this.save();
    return client;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    this.forgetExpired();
    // One waiting request per app: asking again replaces the previous request and its code.
    for (const other of this.waiting.values()) if (other.client.client_id === client.client_id) this.retire(other, 'replaced');
    if (this.waiting.size >= MAX_WAITING) this.retire(this.waiting.values().next().value!, 'replaced');

    const waiting: Waiting = {
      id: randomToken(16),
      client,
      params,
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      attempts: 0,
      expiresAt: Date.now() + APPROVAL_LIFETIME,
    };
    this.waiting.set(waiting.id, waiting);
    this.onChange();
    res.status(200).set(pageHeaders(params.redirectUri)).send(approvalPage({ notebook: this.notebook, app: this.appName(client.client_id), request: waiting.id }));
  }

  /** The person's answer on the approval page. */
  decide(requestId: string, answer: { approve: true; code: string } | { approve: false }): Decision {
    this.forgetExpired();
    const waiting = this.waiting.get(requestId);
    if (!waiting) return this.ended(requestId);
    const returnTo = waiting.params.redirectUri;

    if (!answer.approve) {
      this.retire(waiting, 'declined');
      return { redirect: errorRedirect(waiting.params, 'access_denied', 'The person declined.') };
    }
    if (!sameCode(answer.code, waiting.code)) {
      waiting.attempts++;
      const left = CODE_ATTEMPTS - waiting.attempts;
      if (left <= 0) {
        this.retire(waiting, 'declined');
        return { redirect: errorRedirect(waiting.params, 'access_denied', 'Too many wrong codes.') };
      }
      const error = `That code doesn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
      return { status: 200, html: approvalPage({ notebook: this.notebook, app: this.appName(waiting.client.client_id), request: waiting.id, error }), returnTo };
    }

    this.retire(waiting, 'approved');
    const code = randomToken(32);
    this.codes.set(code, { clientId: waiting.client.client_id, params: waiting.params, expiresAt: Date.now() + AUTHORIZATION_CODE_LIFETIME });
    const target = new URL(returnTo);
    target.searchParams.set('code', code);
    if (waiting.params.state !== undefined) target.searchParams.set('state', waiting.params.state);
    return { redirect: target.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const issued = this.codes.get(code);
    if (!issued || issued.clientId !== client.client_id) throw new InvalidGrantError('The authorization code is not valid.');
    return issued.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const issued = this.codes.get(code);
    this.codes.delete(code); // codes work once
    if (!issued || issued.clientId !== client.client_id || issued.expiresAt < Date.now()) {
      throw new InvalidGrantError('The authorization code is not valid or has expired.');
    }
    if (redirectUri !== undefined && redirectUri !== issued.params.redirectUri) throw new InvalidGrantError('The redirect address does not match.');
    this.checkResource(resource);

    const now = Date.now();
    const refreshToken = randomToken(32);
    const grant: Grant = { id: randomToken(8), clientId: client.client_id, refreshHash: hash(refreshToken), createdAt: now, lastUsedAt: now, expiresAt: now + REFRESH_TOKEN_LIFETIME };
    this.saved.grants.push(grant);
    await this.save();
    this.onChange();
    return this.tokensFor(grant, refreshToken);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const grant = this.saved.grants.find((candidate) => candidate.refreshHash === hash(refreshToken));
    if (!grant || grant.clientId !== client.client_id || grant.expiresAt < Date.now()) {
      throw new InvalidGrantError('The refresh token is not valid or has expired.');
    }
    this.checkResource(resource);
    // Rotate: the refresh token just used stops working.
    const next = randomToken(32);
    grant.refreshHash = hash(next);
    grant.lastUsedAt = Date.now();
    grant.expiresAt = grant.lastUsedAt + REFRESH_TOKEN_LIFETIME;
    this.dropAccessTokens(grant.id);
    await this.save();
    return this.tokensFor(grant, next);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.accessTokens.get(hash(token));
    const grant = entry && this.saved.grants.find((candidate) => candidate.id === entry.grantId);
    if (!entry || !grant || entry.expiresAt < Date.now()) throw new InvalidTokenError('The access token is not valid or has expired.');
    grant.lastUsedAt = Date.now();
    this.saveSoon();
    return { token, clientId: entry.clientId, scopes: [SCOPE], expiresAt: Math.floor(entry.expiresAt / 1000), resource: this.resource };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const tokenHash = hash(request.token);
    const grant = this.saved.grants.find(
      (candidate) => candidate.clientId === client.client_id && (candidate.refreshHash === tokenHash || this.accessTokens.get(tokenHash)?.grantId === candidate.id),
    );
    if (grant) await this.disconnect(grant.id);
  }

  // ---------------------------------------------------------------------------
  // For the person, through the editor

  status(): Omit<RemoteStatus, 'url'> {
    this.forgetExpired();
    const latest = [...this.waiting.values()].at(-1);
    return {
      pending: latest && { app: this.appName(latest.client.client_id), code: `${latest.code.slice(0, 3)} ${latest.code.slice(3)}`, expiresAt: latest.expiresAt },
      connections: this.saved.grants.map((grant) => ({ id: grant.id, app: this.appName(grant.clientId), since: grant.createdAt, lastUsed: grant.lastUsedAt })),
    };
  }

  async disconnect(grantId: string): Promise<void> {
    this.saved.grants = this.saved.grants.filter((grant) => grant.id !== grantId);
    this.dropAccessTokens(grantId);
    await this.save();
    this.onChange();
  }

  denyWaiting(): void {
    this.waiting.clear();
    this.onChange();
  }

  /** How commits and the activity list name an app's work. */
  agentFor(clientId: string): string {
    const name = this.appName(clientId);
    return /claude/i.test(name) ? 'Claude via claude.ai' : name;
  }

  async flush(): Promise<void> {
    if (this.saveTimer) await this.save();
  }

  // ---------------------------------------------------------------------------

  private appName(clientId: string): string {
    return this.saved.clients.find((client) => client.client_id === clientId)?.client_name || 'An app';
  }

  /** RFC 8707: a token is only issued for this server. Clients may name its address or its origin. */
  private checkResource(resource: URL | undefined): void {
    if (!resource) return;
    const named = resource.href.replace(/\/$/, '');
    if (named !== this.resource.href.replace(/\/$/, '') && named !== this.resource.origin) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resource.href}.`);
    }
  }

  private tokensFor(grant: Grant, refreshToken: string): OAuthTokens {
    const accessToken = randomToken(32);
    this.accessTokens.set(hash(accessToken), { clientId: grant.clientId, grantId: grant.id, expiresAt: Date.now() + ACCESS_TOKEN_LIFETIME });
    this.saveSoon();
    return { access_token: accessToken, token_type: 'bearer', expires_in: ACCESS_TOKEN_LIFETIME / 1000, refresh_token: refreshToken, scope: SCOPE };
  }

  private dropAccessTokens(grantId: string): void {
    for (const [key, entry] of this.accessTokens) if (entry.grantId === grantId) this.accessTokens.delete(key);
  }

  private retire(waiting: Waiting, outcome: Outcome): void {
    this.waiting.delete(waiting.id);
    this.finished.set(waiting.id, { outcome, at: Date.now() });
    this.onChange();
  }

  /** The page for a request that no longer waits, saying what became of it. */
  private ended(requestId: string): Decision {
    switch (this.finished.get(requestId)?.outcome) {
      case 'approved':
        return { status: 200, html: messagePage('Already approved', 'The app is connected. You can close this tab.') };
      case 'declined':
        return { status: 410, html: messagePage('This request was declined', 'Start connecting again from the app if you meant to approve it.') };
      case 'replaced':
        return { status: 410, html: messagePage('A newer request replaced this one', 'Use the approval page the app opened most recently, with the latest code Quillipi shows.') };
      default:
        return { status: 410, html: messagePage('This request has expired', 'Start connecting again from the app.') };
    }
  }

  private forgetExpired(): void {
    const now = Date.now();
    for (const [id, waiting] of this.waiting) if (waiting.expiresAt < now) this.waiting.delete(id);
    for (const [code, issued] of this.codes) if (issued.expiresAt < now) this.codes.delete(code);
    for (const [id, ended] of this.finished) if (ended.at < now - 30 * MINUTE) this.finished.delete(id);
  }

  /** Last-used times change on every call, so they are written at most once a minute. */
  private saveSoon(): void {
    this.saveTimer ??= setTimeout(() => void this.save().catch((error) => console.error('Could not save connections:', error)), MINUTE);
  }

  private async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const now = Date.now();
    const accessTokens = [...this.accessTokens].filter(([, entry]) => entry.expiresAt > now).map(([key, entry]) => ({ hash: key, ...entry }));
    await this.repo.write(STATE_FILE, `${JSON.stringify({ version: 1, ...this.saved, accessTokens }, null, 2)}\n`);
  }
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compares in constant time, ignoring spaces the person typed. */
function sameCode(typed: string, expected: string): boolean {
  const digits = typed.replace(/\s/g, '');
  return digits.length === expected.length && timingSafeEqual(Buffer.from(digits), Buffer.from(expected));
}

function errorRedirect(params: AuthorizationParams, error: string, description: string): string {
  const target = new URL(params.redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (params.state !== undefined) target.searchParams.set('state', params.state);
  return target.href;
}
