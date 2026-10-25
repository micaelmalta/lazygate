// src/oauth.ts
// PKCE OAuth 2.0 flow for HTTP MCP servers.
// Finds AS metadata (RFC 9728 / 8414), registers a public client when needed
// (RFC 7591), runs the browser flow, and persists tokens to disk (mode 0600).

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  chmodSync,
  statSync,
  unlinkSync,
} from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import {
  discoverOAuthServerInfo,
  registerClient,
  type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { APP_NAME, configDir } from "./paths.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { assertSafeUrl, assertTokenEndpointMatchesIssuer, safeFetch } from "./ssrf.js";

/** Explicit overrides; all fields optional — missing values are auto-discovered. */
export interface OAuthConfig {
  clientId?: string;
  callbackPort?: number;
  scopes?: string[];
}

export interface GetAccessTokenOptions {
  /** Skip the cached access token (e.g. after the server answered 401). */
  force?: boolean;
  /** Store/read the token for this user instead of the shared per-server token (gateway mode). */
  owner?: string;
  /**
   * When false, never open a browser or start a loopback callback — only use a cached/refreshable
   * token. Gateway mode sets this so a remote user's missing token becomes a connect link instead
   * of an authorization on the gateway host. Default true.
   */
  interactive?: boolean;
}

/** Thrown when a token is needed but `interactive: false` and nothing is cached/refreshable. */
export class NeedsAuthorizationError extends Error {
  constructor(readonly serverName: string) {
    super(
      `Server "${serverName}" needs OAuth. Open the gateway UI (Credentials → Connect) or call connect_server.`
    );
    this.name = "NeedsAuthorizationError";
  }
}

interface PendingAuth {
  serverName: string;
  owner?: string;
  clientId: string;
  verifier: string;
  redirectUri: string;
  resource: string;
  tokenEndpoint: string;
  /** IdP authorize URL (after the gateway /oauth/start confirmation). */
  authorizationUrl: string;
  /** Bound to an HttpOnly cookie so only the browser that confirmed Connect can finish. */
  bindToken: string;
  expiresAt: number;
}

export const OAUTH_BIND_COOKIE = "lzg_oauth";

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // unix ms
  token_type?: string;
  client_id?: string;
  /** Canonical MCP server URL this token was issued for (RFC 8707). */
  resource?: string;
}

interface OAuthMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface StoredClient {
  client_id: string;
  redirect_uri: string;
  resource?: string;
  callback_port?: number;
}

const CONFIG_DIR = configDir();
const TOKEN_DIR = resolve(CONFIG_DIR, "tokens");
const CLIENT_DIR = resolve(CONFIG_DIR, "clients");

function safeFileName(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Tokens are shared per server, or per user when `owner` is set (gateway user-scope servers). */
export function tokenPath(serverName: string, owner?: string, tokenDir: string = TOKEN_DIR): string {
  return owner
    ? resolve(tokenDir, "users", safeFileName(owner), `${safeFileName(serverName)}.json`)
    : resolve(tokenDir, `${safeFileName(serverName)}.json`);
}

function clientPath(serverName: string): string {
  return resolve(CLIENT_DIR, `${safeFileName(serverName)}.json`);
}

/** Private (0700 dir / 0600 file) atomic JSON write. */
function writePrivateJson(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort (e.g. Windows) */
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    // Files written by older versions used the default umask; tighten them.
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function loadToken(serverName: string, owner?: string): TokenSet | null {
  return readJson<TokenSet>(tokenPath(serverName, owner));
}

function saveToken(serverName: string, token: TokenSet, owner?: string): void {
  writePrivateJson(tokenPath(serverName, owner), token);
}

/** Whether a non-expired (or refreshable) token is on disk for this server/owner. */
export function hasStoredToken(serverName: string, owner?: string): boolean {
  const t = loadToken(serverName, owner);
  if (!t?.access_token) return false;
  if (!isExpired(t)) return true;
  return Boolean(t.refresh_token);
}

/** Remove a stored OAuth token (disconnect). Returns true when something was deleted. */
export function clearStoredToken(serverName: string, owner?: string): boolean {
  const path = tokenPath(serverName, owner);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

const pendingAuth = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60_000;

function purgeExpiredPending(): void {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (v.expiresAt <= now) pendingAuth.delete(k);
}

function loadClient(serverName: string): StoredClient | null {
  return readJson<StoredClient>(clientPath(serverName));
}

function saveClient(serverName: string, client: StoredClient): void {
  writePrivateJson(clientPath(serverName), client);
}

function isExpired(token: TokenSet): boolean {
  if (!token.expires_at) return false;
  return Date.now() > token.expires_at - 60_000; // 1 min buffer
}

/** Canonical resource identifier for RFC 8707 (no fragment). */
function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = "";
  return u.toString();
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Open a URL in the user's browser without going through a shell.
 * The URL is always echoed to stderr as a manual fallback.
 */
export function openBrowser(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error(`[oauth] Refusing to open invalid URL: ${url}`);
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    console.error(`[oauth] Refusing to open non-http(s) URL: ${parsed.protocol}`);
    return;
  }

  const href = parsed.toString();
  console.error(`[oauth] If a browser does not open, visit:\n  ${href}`);

  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [href]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", href]]
        : ["xdg-open", [href]];

  try {
    const child = execFile(cmd as string, args as string[], { windowsHide: true }, (err) => {
      if (err) console.error(`[oauth] Could not launch browser (${cmd}): ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.error(`[oauth] Could not launch browser (${cmd}): ${(err as Error).message}`);
  }
}

function asOAuthMeta(metadata: AuthorizationServerMetadata): OAuthMeta {
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("Authorization server metadata missing authorization_endpoint or token_endpoint");
  }
  return {
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    registration_endpoint: metadata.registration_endpoint,
    scopes_supported: metadata.scopes_supported,
    code_challenge_methods_supported: metadata.code_challenge_methods_supported,
  };
}

interface Discovery {
  info: OAuthServerInfo;
  meta: OAuthMeta;
}

/** Validate AS endpoints from discovery (SSRF + token_endpoint origin). */
async function validateDiscoveryEndpoints(info: OAuthServerInfo, meta: OAuthMeta): Promise<void> {
  const issuer = info.authorizationServerUrl || meta.authorization_endpoint;
  await assertSafeUrl(meta.authorization_endpoint);
  await assertSafeUrl(meta.token_endpoint);
  if (meta.registration_endpoint) await assertSafeUrl(meta.registration_endpoint);
  assertTokenEndpointMatchesIssuer(meta.token_endpoint, issuer);
}

/** Discover AS metadata for an MCP resource URL (RFC 9728 → RFC 8414). */
async function discover(serverUrl: string): Promise<Discovery> {
  // Admin-configured MCP URL may be internal; SSRF applies to AS metadata endpoints below.
  const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: safeFetch });
  if (info.authorizationServerMetadata) {
    const meta = asOAuthMeta(info.authorizationServerMetadata);
    await validateDiscoveryEndpoints(info, meta);
    return { info, meta };
  }

  // Fallback: origin well-known (older deployments)
  const base = new URL(serverUrl).origin;
  const wellKnown = `${base}/.well-known/oauth-authorization-server`;
  await assertSafeUrl(wellKnown);
  const res = await safeFetch(wellKnown);
  if (!res.ok) {
    throw new Error(`OAuth discovery failed for ${serverUrl}: no AS metadata`);
  }
  const meta = (await res.json()) as OAuthMeta;
  await validateDiscoveryEndpoints(info, meta);
  return { info, meta };
}

async function registerDynamicClient(
  serverName: string,
  resource: string,
  discovery: Discovery,
  redirectUri: string,
  port: number,
  scopes: string[]
): Promise<string> {
  const { info, meta } = discovery;
  if (!meta.registration_endpoint) {
    throw new Error(
      `OAuth for ${serverName} needs a clientId (no registration_endpoint on AS)`
    );
  }

  console.error(`[oauth] Registering public client for ${serverName}...`);
  const supportedGrants = info.authorizationServerMetadata?.grant_types_supported;
  const grantTypes =
    supportedGrants && supportedGrants.length > 0
      ? supportedGrants.filter((g) => g === "authorization_code" || g === "refresh_token")
      : ["authorization_code"];
  if (!grantTypes.includes("authorization_code")) grantTypes.unshift("authorization_code");

  const registered = await registerClient(info.authorizationServerUrl, {
    metadata: info.authorizationServerMetadata,
    clientMetadata: {
      client_name: `${APP_NAME}:${serverName}`,
      redirect_uris: [redirectUri],
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    },
    fetchFn: safeFetch,
  });

  saveClient(serverName, {
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    resource,
    callback_port: port,
  });
  return registered.client_id;
}

async function resolveClientId(
  serverName: string,
  resource: string,
  discovery: Discovery,
  redirectUri: string,
  port: number,
  config: OAuthConfig,
  scopes: string[]
): Promise<string> {
  if (config.clientId) return config.clientId;

  const cached = loadClient(serverName);
  // Reuse a cached client only for the same resource and an identical redirect URI.
  if (
    cached &&
    cached.redirect_uri === redirectUri &&
    (!cached.resource || cached.resource === resource)
  ) {
    return cached.client_id;
  }

  return registerDynamicClient(serverName, resource, discovery, redirectUri, port, scopes);
}

interface CallbackListener {
  port: number;
  wait: Promise<{ code: string }>;
  close: () => void;
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((res, rej) => {
    const onError = (err: Error) => rej(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      res();
    });
  });
}

/**
 * Loopback callback listener. Only `GET /callback` with the expected `state`
 * settles the flow; anything else is rejected without affecting it.
 * Binds 127.0.0.1 (and ::1 on the same port when available) so both
 * `127.0.0.1` and `localhost` redirect URIs work.
 */
async function startCallbackServer(
  preferredPort: number | undefined,
  strictPort: boolean,
  expectedState: string
): Promise<CallbackListener> {
  let waitResolve: (v: { code: string }) => void = () => {};
  let waitReject: (e: Error) => void = () => {};
  const wait = new Promise<{ code: string }>((res, rej) => {
    waitResolve = res;
    waitReject = rej;
  });
  wait.catch(() => undefined); // avoid unhandled rejection if nobody awaits yet

  const servers: Server[] = [];
  let timer: NodeJS.Timeout | undefined;
  let done = false;

  const close = () => {
    done = true;
    if (timer) clearTimeout(timer);
    for (const s of servers) {
      try {
        s.close();
        s.closeAllConnections?.();
      } catch {
        /* ignore */
      }
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const state = url.searchParams.get("state") ?? "";
    if (!safeEqual(state, expectedState)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid OAuth state");
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(code ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    if (code) {
      res.end("<html><body><h2>Authenticated. You can close this tab.</h2></body></html>");
      close();
      waitResolve({ code });
    } else {
      const msg = error ?? "unknown";
      res.end(`<html><body><h2>Error: ${escapeHtml(msg)}</h2></body></html>`);
      close();
      waitReject(new Error(`OAuth error: ${msg}`));
    }
  };

  const bind = async (port: number): Promise<Server> => {
    const s = createServer(handler);
    await listenOn(s, port, "127.0.0.1");
    return s;
  };

  let primary: Server;
  try {
    primary = await bind(preferredPort ?? 0);
  } catch (err) {
    if (preferredPort && !strictPort) {
      primary = await bind(0); // remembered port is busy — fall back to ephemeral
    } else {
      throw err;
    }
  }
  servers.push(primary);

  const addr = primary.address();
  if (!addr || typeof addr === "string") {
    close();
    throw new Error("Failed to bind OAuth callback server");
  }

  // Best-effort IPv6 loopback on the same port.
  try {
    const v6 = createServer(handler);
    await listenOn(v6, addr.port, "::1");
    servers.push(v6);
  } catch {
    /* IPv6 unavailable or port taken — fine */
  }

  primary.on("error", (err) => {
    if (!done) waitReject(err);
  });

  timer = setTimeout(() => {
    if (!done) {
      close();
      waitReject(new Error("OAuth callback timed out after 5 minutes"));
    }
  }, 5 * 60 * 1000);
  timer.unref();

  console.error(`[oauth] Waiting for OAuth callback on port ${addr.port}...`);
  return { port: addr.port, wait, close };
}

async function tokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  what: string
): Promise<Record<string, unknown>> {
  const res = await safeFetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`${what} failed: HTTP ${res.status} (non-JSON response)`);
  }
  if (!res.ok || data.error) {
    throw new Error(
      `${what} failed: ${data.error ?? res.status}${
        data.error_description ? ` — ${data.error_description}` : ""
      }`
    );
  }
  if (typeof data.access_token !== "string") {
    throw new Error(`${what} failed: response had no access_token`);
  }
  return data;
}

function toTokenSet(
  data: Record<string, unknown>,
  clientId: string,
  resource: string,
  fallbackRefresh?: string
): TokenSet {
  const token: TokenSet = {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string | undefined) ?? fallbackRefresh,
    token_type: data.token_type as string | undefined,
    client_id: clientId,
    resource,
  };
  if (typeof data.expires_in === "number") {
    token.expires_at = Date.now() + data.expires_in * 1000;
  }
  return token;
}

async function exchangeCode(
  tokenEndpoint: string,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string,
  resource: string
): Promise<TokenSet> {
  const data = await tokenRequest(
    tokenEndpoint,
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    },
    "Token exchange"
  );
  return toTokenSet(data, clientId, resource);
}

async function refreshToken(
  tokenEndpoint: string,
  clientId: string,
  refreshTok: string,
  resource: string
): Promise<TokenSet> {
  const data = await tokenRequest(
    tokenEndpoint,
    {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshTok,
      resource,
    },
    "Token refresh"
  );
  return toTokenSet(data, clientId, resource, refreshTok);
}

const inFlight = new Map<string, Promise<string>>();

/**
 * Returns a valid Bearer token for the given server, running the OAuth flow if needed.
 * clientId / callbackPort / scopes are optional — discovered via DCR + remembered port.
 * Concurrent calls for the same server share one flow (one browser window).
 */
export function getAccessToken(
  serverName: string,
  serverUrl: string,
  config: OAuthConfig = {},
  opts: GetAccessTokenOptions = {}
): Promise<string> {
  const key = `${opts.owner ?? ""}\u0000${serverName}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = obtainAccessToken(serverName, serverUrl, config, opts).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function obtainAccessToken(
  serverName: string,
  serverUrl: string,
  config: OAuthConfig,
  opts: GetAccessTokenOptions
): Promise<string> {
  const resource = canonicalResource(serverUrl);

  const owner = opts.owner;
  let token = loadToken(serverName, owner);
  if (token?.resource && token.resource !== resource) {
    // Token was issued for a different server URL — never replay it here.
    console.error(`[oauth] Ignoring stored token for ${serverName}: issued for a different URL`);
    token = null;
  }
  if (token && !token.resource) {
    token.resource = resource; // adopt legacy token
    saveToken(serverName, token, owner);
  }

  // Fast path: no network when the cached token is still good.
  if (!opts.force && token && !isExpired(token)) {
    return token.access_token;
  }

  const discovery = await discover(serverUrl);
  const { meta, info } = discovery;
  const scopes = config.scopes ?? info.resourceMetadata?.scopes_supported ?? [];

  const clientIdForRefresh =
    config.clientId ?? token?.client_id ?? loadClient(serverName)?.client_id;

  if (token?.refresh_token && clientIdForRefresh) {
    console.error(`[oauth] Refreshing token for ${serverName}...`);
    try {
      const refreshed = await refreshToken(
        meta.token_endpoint,
        clientIdForRefresh,
        token.refresh_token,
        resource
      );
      saveToken(serverName, refreshed, owner);
      return refreshed.access_token;
    } catch (err) {
      console.error(`[oauth] Refresh failed: ${(err as Error).message} — re-authorizing`);
    }
  }

  if (opts.interactive === false) {
    throw new NeedsAuthorizationError(serverName);
  }

  console.error(`[oauth] Authorizing ${serverName} — a browser window will open`);

  const state = base64url(randomBytes(16));
  const cachedClient = config.clientId ? null : loadClient(serverName);
  const preferredPort = config.callbackPort ?? cachedClient?.callback_port;
  const listener = await startCallbackServer(
    preferredPort,
    config.callbackPort !== undefined,
    state
  );
  try {
    // Pre-registered clients (explicit clientId) usually registered `localhost`;
    // dynamically registered ones use the RFC 8252 loopback IP literal.
    const host = config.clientId ? "localhost" : "127.0.0.1";
    const redirectUri = `http://${host}:${listener.port}/callback`;
    const clientId = await resolveClientId(
      serverName,
      resource,
      discovery,
      redirectUri,
      listener.port,
      config,
      scopes
    );

    const { verifier, challenge } = generatePKCE();

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    if (scopes.length) authUrl.searchParams.set("scope", scopes.join(" "));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", resource);

    openBrowser(authUrl.toString());

    const { code } = await listener.wait;
    const fresh = await exchangeCode(
      meta.token_endpoint,
      clientId,
      code,
      verifier,
      redirectUri,
      resource
    );
    saveToken(serverName, fresh, owner);

    console.error(`[oauth] ${serverName} authorized successfully`);
    return fresh.access_token;
  } finally {
    listener.close();
  }
}

/**
 * Start an authorization-code + PKCE flow that will return to `redirectUri` (the gateway's
 * `/oauth/callback`). Does not open a browser — the caller sends the user to `authorizationUrl`.
 * The pending state is single-use and expires in 10 minutes.
 */
export async function startRemoteAuthorization(opts: {
  serverName: string;
  serverUrl: string;
  config?: OAuthConfig;
  /** When set, the token is stored per user; omit for a shared server-level token. */
  owner?: string;
  redirectUri: string;
}): Promise<{ authorizationUrl: string; state: string; bindToken: string }> {
  const { serverName, serverUrl, owner, redirectUri } = opts;
  const config = opts.config ?? {};
  const resource = canonicalResource(serverUrl);
  const discovery = await discover(serverUrl);
  const { meta, info } = discovery;
  const scopes = config.scopes ?? info.resourceMetadata?.scopes_supported ?? [];

  let port = 0;
  try {
    port = new URL(redirectUri).port ? Number(new URL(redirectUri).port) : 0;
  } catch {
    throw new Error(`Invalid redirect URI: ${redirectUri}`);
  }

  const clientId = await resolveClientId(serverName, resource, discovery, redirectUri, port, config, scopes);
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const bindToken = base64url(randomBytes(24));

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (scopes.length) authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", resource);
  const authorizationUrl = authUrl.toString();

  purgeExpiredPending();
  // One in-flight connect per (owner, server) — a new Connect replaces the previous pending state.
  for (const [k, v] of pendingAuth) {
    if (v.serverName === serverName && v.owner === owner) pendingAuth.delete(k);
  }
  pendingAuth.set(state, {
    serverName,
    owner,
    clientId,
    verifier,
    redirectUri,
    resource,
    tokenEndpoint: meta.token_endpoint,
    authorizationUrl,
    bindToken,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  return { authorizationUrl, state, bindToken };
}

/** Peek a pending remote auth (for the /oauth/start confirmation page). */
export function peekPendingAuth(state: string): {
  serverName: string;
  owner?: string;
  authorizationUrl: string;
  bindToken: string;
} | null {
  purgeExpiredPending();
  const pending = pendingAuth.get(state);
  if (!pending || pending.expiresAt <= Date.now()) return null;
  return {
    serverName: pending.serverName,
    owner: pending.owner,
    authorizationUrl: pending.authorizationUrl,
    bindToken: pending.bindToken,
  };
}

/**
 * Finish a remote authorization: exchange the code, store the token for the pending owner.
 * `bindToken` must match the HttpOnly cookie set at /oauth/start (browser binding).
 */
export async function finishRemoteAuthorization(
  state: string,
  code: string,
  bindToken?: string
): Promise<{ serverName: string; owner?: string }> {
  purgeExpiredPending();
  const pending = pendingAuth.get(state);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingAuth.delete(state);
    throw new Error("OAuth state is invalid or expired — start Connect again from the UI");
  }
  if (!bindToken || bindToken !== pending.bindToken) {
    throw new Error(
      "OAuth callback was not started from this browser — open Connect again and continue in the same browser"
    );
  }
  pendingAuth.delete(state); // single use

  const fresh = await exchangeCode(
    pending.tokenEndpoint,
    pending.clientId,
    code,
    pending.verifier,
    pending.redirectUri,
    pending.resource
  );
  saveToken(pending.serverName, fresh, pending.owner);
  console.error(
    `[oauth] ${pending.serverName} authorized` + (pending.owner ? ` for ${pending.owner}` : " (shared)")
  );
  return { serverName: pending.serverName, owner: pending.owner };
}

/** Confirmation page before redirecting to the IdP (binds the flow to this browser via cookie). */
export function oauthStartPage(opts: {
  serverName: string;
  owner?: string;
  confirmUrl: string;
  uiUrl?: string;
}): string {
  const who = opts.owner ? escapeHtml(opts.owner) : "a shared gateway connection";
  const link = opts.uiUrl ? `<p><a href="${escapeHtml(opts.uiUrl)}">Cancel</a></p>` : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Connect ${escapeHtml(opts.serverName)}</title></head>` +
    `<body style="font:14px system-ui;max-width:420px;margin:60px auto">` +
    `<h2>Connect “${escapeHtml(opts.serverName)}”</h2>` +
    `<p>You are connecting as <strong>${who}</strong>. Continue only if that is you.</p>` +
    `<p><a href="${escapeHtml(opts.confirmUrl)}" style="display:inline-block;padding:8px 14px;background:#111;color:#fff;text-decoration:none;border-radius:4px">Continue</a></p>` +
    link +
    `</body></html>`
  );
}

/** HTML response body for the browser tab that lands on `/oauth/callback`. */
export function oauthCallbackPage(ok: boolean, message: string, uiUrl?: string): string {
  const title = ok ? "Connected" : "Connection failed";
  const link = uiUrl
    ? `<p><a href="${escapeHtml(uiUrl)}">Back to lazygate</a></p>`
    : `<p>You can close this tab.</p>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font:14px system-ui;max-width:420px;margin:60px auto">` +
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${link}</body></html>`
  );
}

/** Test helper — how many remote authorizations are waiting. */
export function pendingAuthCount(): number {
  purgeExpiredPending();
  return pendingAuth.size;
}
