// src/gateway/ui-api.ts
// Web UI backend: static assets under /ui and a small JSON API under /ui/api.
//
// Auth is the same bearer token as the MCP endpoint, sent in an Authorization header by the page's
// script (no cookies, so no CSRF). Everyone can manage their own stored credentials and see their own
// audit entries; tokens, secrets, sessions and server settings need an admin token.

import type { IncomingMessage, ServerResponse } from "http";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { parseServersConfig, parseSkillsConfig } from "../config.js";
import { effectiveAuthScope, sharedScopeMultiGroup, type ServerConfig } from "../router.js";
import type { Registry } from "../registry.js";
import { isStdioCommandAllowed, parseStdioCommandAllowlist } from "../stdio-policy.js";
import { CredentialResolver, SecretStore, canAccess, credHeaderName, secretEnvName } from "./credentials.js";
import { TokenStore, bearerToken, parseDuration, type UserIdentity } from "./tokens.js";
import { UserVault } from "./vault.js";
import { UserProfileStore } from "./profile.js";
import { AuditLog } from "./audit.js";
import { readBody, sendJson } from "./http-util.js";
import { UI_HTML, UI_JS, UI_CSS } from "./ui-assets.js";
import { warmSharedToolIndex } from "./tool-index-warm.js";

/**
 * Stdio commands the UI may set (`LAZYGATE_STDIO_ALLOWLIST` / `LAZYGATE_ALLOWED_COMMANDS`).
 * When unset/empty, the UI cannot set or change `command`/`args` (edit servers.json on the host).
 */
export function allowedCommands(env: NodeJS.ProcessEnv = process.env): string[] | null {
  return parseStdioCommandAllowlist(env) ?? null;
}

export function isCommandAllowed(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = parseStdioCommandAllowlist(env);
  if (!list) return false; // UI: unset = CLI-only (activation policy differs — see stdio-policy.ts)
  return isStdioCommandAllowed(command, list);
}

function assertUiCommand(command: string): void {
  if (isCommandAllowed(command)) return;
  const list = allowedCommands();
  if (!list) {
    throw new HttpError(
      403,
      "Setting stdio command via the UI is disabled. Set LAZYGATE_ALLOWED_COMMANDS (or LAZYGATE_STDIO_ALLOWLIST) or edit servers.json on the host."
    );
  }
  throw new HttpError(403, `Command "${command}" is not on the gateway allowlist`);
}

export interface SessionInfo {
  id: string;
  user: string;
  createdAt: number;
  lastSeen: number;
  servers: string[];
}

export interface UiContext {
  registry: Registry;
  tokens: TokenStore;
  secrets: SecretStore;
  vault?: UserVault;
  profiles: UserProfileStore;
  audit: AuditLog;
  startedAt: number;
  publicUrl: string;
  /** Start an OAuth authorization; returns the URL to send the user to. */
  beginOAuth(userId: string, name: string, cfg: ServerConfig): Promise<string>;
  oauthConnected(userId: string, name: string, cfg: ServerConfig): boolean;
  clearOAuth(userId: string, name: string, cfg: ServerConfig, admin: boolean): boolean;
  sessions(): SessionInfo[];
  /** Passed through to admin tool-index warm (stdio allowlist). */
  stdioCommandAllowlist?: readonly string[];
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const MAX_UI_BODY = 256 * 1024;
const MAX_SKILL_BODY = 200 * 1024;
const TEMPLATE_CRED = /\$\{cred:([^}]+)\}/g;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** `${cred:x}` field names a server asks users for. */
function userFields(cfg: ServerConfig): string[] {
  const out = new Set<string>();
  for (const group of [cfg.auth?.env, cfg.auth?.headers]) {
    for (const v of Object.values(group ?? {})) for (const m of v.matchAll(TEMPLATE_CRED)) out.add(m[1].toLowerCase());
  }
  return [...out];
}

const asObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Expected a JSON object");
  return v as Record<string, unknown>;
};

const asString = (v: unknown, what: string, max = 8192): string => {
  if (typeof v !== "string" || !v.length) throw new HttpError(400, `${what} is required`);
  if (v.length > max) throw new HttpError(400, `${what} is too long`);
  return v;
};

function stringMap(v: unknown, what: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  const o = asObject(v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) {
    if (typeof val !== "string") throw new HttpError(400, `${what}.${k} must be a string`);
    out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

export function isUiPath(path: string): boolean {
  return path === "/ui" || path.startsWith("/ui/");
}

export async function handleUi(
  ctx: UiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams
): Promise<void> {
  const headers = SECURITY_HEADERS;

  if (req.method === "GET" || req.method === "HEAD") {
    const asset =
      path === "/ui" || path === "/ui/"
        ? ([UI_HTML, "text/html; charset=utf-8"] as const)
        : path === "/ui/app.js"
          ? ([UI_JS, "text/javascript; charset=utf-8"] as const)
          : path === "/ui/app.css"
            ? ([UI_CSS, "text/css; charset=utf-8"] as const)
            : null;
    if (asset) {
      res.writeHead(200, { "Content-Type": asset[1], ...headers });
      res.end(req.method === "HEAD" ? undefined : asset[0]);
      return;
    }
  }

  if (!path.startsWith("/ui/api/")) return sendJson(res, 404, { error: "not found" }, headers);

  const user = ctx.tokens.verify(bearerToken(req.headers.authorization));
  if (!user) return sendJson(res, 401, { error: "unauthorized" }, { ...headers, "WWW-Authenticate": 'Bearer realm="lazygate"' });

  try {
    let body: unknown;
    if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "HEAD") {
      try {
        body = await readBody(req, MAX_UI_BODY);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    const result = await route(ctx, user, req.method ?? "GET", path.slice("/ui/api/".length).split("/").map(decodeURIComponent), query, body);
    if (result === undefined) {
      res.writeHead(204, headers).end();
      return;
    }
    sendJson(res, 200, result, headers);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, headers);
    console.error(`[lazygate] ui request failed: ${(err as Error).message}`);
    sendJson(res, 500, { error: "internal error" }, headers);
  }
}

function requireAdmin(user: UserIdentity): void {
  if (!user.admin) throw new HttpError(403, "This needs an admin token (lazygate token create --admin)");
}

async function route(
  ctx: UiContext,
  user: UserIdentity,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: unknown
): Promise<unknown> {
  const [area, a, b] = seg;
  const { registry } = ctx;

  // ── Anyone with a token ────────────────────────────────────────────────
  if (area === "me" && method === "GET" && seg.length === 1) {
    return { user: user.id, groups: user.groups, admin: user.admin, vault: Boolean(ctx.vault), configPath: user.admin ? registry.configPath : undefined };
  }

  if (area === "connections") return connections(ctx, user, method, seg, body);

  if (area === "audit" && method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(query.get("limit") ?? 100) || 100));
    return { events: ctx.audit.tail(limit, user.admin && query.get("all") === "1" ? undefined : user.id) };
  }

  // Marketplace catalog — every signed-in user can browse what they can use.
  if (area === "catalog") {
    if (method === "GET" && a === "servers" && seg.length === 2) return catalogServers(ctx, user);
    if (method === "GET" && a === "skills" && seg.length === 2) return catalogSkills(ctx, user);
  }

  // Per-user install list (opt-in from the shared catalog).
  if (area === "profile") {
    if (a === "servers" && b && seg.length === 3) {
      if (method === "POST") return installServer(ctx, user, b);
      if (method === "DELETE") return uninstallServer(ctx, user, b);
    }
    if (a === "skills" && b && seg.length === 3) {
      if (method === "POST") return installSkill(ctx, user, b);
      if (method === "DELETE") return uninstallSkill(ctx, user, b);
    }
  }

  // ── Admin only ─────────────────────────────────────────────────────────
  requireAdmin(user);

  if (area === "status" && method === "GET") {
    return {
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      sessions: ctx.sessions(),
      servers: registry.router.listAll().length,
      skills: registry.skillRouter.listAll().length,
      tokens: ctx.tokens.count(),
      secrets: ctx.secrets.list().length,
    };
  }

  // Pre-warm shared ToolIndex for shared-scope servers only (never user-cred tool lists).
  if (area === "tool-index" && a === "rebuild" && method === "POST" && seg.length === 2) {
    const warm = await warmSharedToolIndex({
      registry,
      secrets: ctx.secrets,
      stdioCommandAllowlist: ctx.stdioCommandAllowlist,
    });
    ctx.audit.recordAdmin({
      user: user.id,
      action: "tool-index.rebuild",
      after: {
        indexed: warm.indexed.length,
        skipped: warm.skipped.length,
        failed: warm.failed.length,
      },
    });
    return warm;
  }

  if (area === "tokens") {
    if (method === "GET" && seg.length === 1) return { tokens: ctx.tokens.list() };
    if (method === "POST" && seg.length === 1) {
      const o = asObject(body);
      const name = asString(o.user, "user", 64);
      if (!NAME.test(name)) throw new HttpError(400, "user may contain letters, digits, '.', '_' and '-'");
      const groups = Array.isArray(o.groups) ? o.groups.map((g) => String(g).trim()).filter(Boolean) : [];
      let expiresInMs: number | undefined;
      if (typeof o.expires === "string" && o.expires.trim()) {
        try {
          expiresInMs = parseDuration(o.expires);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 100) : undefined;
      const admin = o.admin === true;
      const created = ctx.tokens.create({ user: name, groups, expiresInMs, label, admin });
      ctx.audit.recordAdmin({
        user: user.id,
        action: "token.create",
        target: created.id,
        after: { user: name, groups, admin, label: label ?? null, expires: Boolean(expiresInMs) },
      });
      return created;
    }
    if (method === "DELETE" && a) {
      if (a === user.tokenId) throw new HttpError(409, "You can't revoke the token you're signed in with");
      const prior = ctx.tokens.list().find((t) => t.id === a);
      if (!ctx.tokens.revoke(a)) throw new HttpError(404, "No such token");
      ctx.audit.recordAdmin({
        user: user.id,
        action: "token.revoke",
        target: a,
        before: prior ? { user: prior.user, groups: prior.groups, admin: prior.admin, label: prior.label ?? null } : { id: a },
      });
      return undefined;
    }
  }

  if (area === "secrets") {
    if (method === "GET" && seg.length === 1) {
      registry.router.reloadServersFromDisk();
      const stored = ctx.secrets.list();
      const storedSet = new Set(stored);
      const required: Array<{ path: string; servers: string[]; stored: boolean }> = [];
      const byPath = new Map<string, string[]>();
      for (const name of registry.router.listAll()) {
        const cfg = registry.router.getConfig(name) as ServerConfig;
        for (const ref of secretRefsFor(name, cfg, storedSet)) {
          const list = byPath.get(ref.path) ?? [];
          list.push(name);
          byPath.set(ref.path, list);
        }
      }
      for (const [path, servers] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        required.push({ path, servers, stored: storedSet.has(path) });
      }
      return { secrets: stored, required };
    }
    if (method === "PUT" && seg.length === 1) {
      const o = asObject(body);
      const name = asString(o.path, "path", 200);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) throw new HttpError(400, "Invalid secret path");
      const existed = ctx.secrets.list().includes(name);
      ctx.secrets.set(name, asString(o.value, "value"));
      ctx.audit.recordAdmin({
        user: user.id,
        action: "secret.set",
        target: name,
        before: { stored: existed },
        after: { stored: true },
      });
      return { stored: name, env: secretEnvName(name) };
    }
    if (method === "DELETE" && seg.length === 1) {
      const name = asString(query.get("path") ?? "", "path", 200);
      if (!ctx.secrets.delete(name)) throw new HttpError(404, "No such secret");
      ctx.audit.recordAdmin({
        user: user.id,
        action: "secret.delete",
        target: name,
        before: { stored: true },
        after: { stored: false },
      });
      return undefined;
    }
  }

  if (area === "servers") {
    if (method === "GET" && seg.length === 1) {
      registry.router.reloadServersFromDisk();
      const storedSet = new Set(ctx.secrets.list());
      const allow = allowedCommands();
      return {
        editable: true,
        /** null when UI cannot set stdio command/args; otherwise the allowlist. */
        commandAllowlist: allow,
        servers: registry.router.listAll().map((name) =>
          describeServer(name, registry.router.getConfig(name) as ServerConfig, storedSet)
        ),
      };
    }
    if (method === "POST" && seg.length === 1) return createServer(ctx, user, asObject(body));
    if (method === "PATCH" && a && seg.length === 2) return patchServer(ctx, user, a, asObject(body));
    if (method === "DELETE" && a && seg.length === 2) return deleteServer(ctx, user, a);
  }

  if (area === "skills") {
    if (method === "GET" && seg.length === 1) return listSkillsAdmin(ctx);
    if (method === "GET" && a && seg.length === 2) return getSkillAdmin(ctx, a);
    if (method === "POST" && seg.length === 1) return createSkill(ctx, user, asObject(body));
    if (method === "PUT" && a && seg.length === 2) return updateSkill(ctx, user, a, asObject(body));
    if (method === "DELETE" && a && seg.length === 2) return deleteSkill(ctx, user, a);
  }

  throw new HttpError(404, "not found");
}

const TEMPLATE_SECRET = /\$\{secret:([^}]+)\}/g;
const TEMPLATE_CRED_ANY = /\$\{cred:([^}]+)\}/g;

/** Secret store paths a server’s auth templates need (values never included). */
function secretRefsFor(name: string, c: ServerConfig, stored: Set<string>): Array<{ path: string; stored: boolean }> {
  const paths = new Set<string>();
  const scope = effectiveAuthScope(c);
  for (const group of [c.auth?.env, c.auth?.headers]) {
    for (const v of Object.values(group ?? {})) {
      for (const m of v.matchAll(TEMPLATE_SECRET)) paths.add(m[1]);
      // Server-scope `${cred:field}` is satisfied by secret `<server>/<field>`.
      if (scope === "server" || c.auth?.fallback === "server") {
        for (const m of v.matchAll(TEMPLATE_CRED_ANY)) paths.add(`${name}/${m[1].toLowerCase()}`);
      }
    }
  }
  return [...paths].sort().map((path) => ({ path, stored: stored.has(path) }));
}

function describeServer(name: string, c: ServerConfig, secretPaths?: Set<string>) {
  const stored = secretPaths ?? new Set<string>();
  const scope = effectiveAuthScope(c);
  return {
    name,
    description: c.description,
    keywords: c.keywords ?? [],
    transport: c.url ? "http" : "stdio",
    target: c.url ?? [c.command, ...(c.args ?? [])].join(" "),
    oauth: Boolean(c.oauth),
    autoActivate: Boolean(c.autoActivate),
    disabled: Boolean(c.disabled),
    local: Boolean(c.local),
    groups: c.groups ?? [],
    sharedScopeMultiGroup: sharedScopeMultiGroup(c),
    secretRefs: secretRefsFor(name, c, stored),
    auth: c.auth
      ? {
          scope: c.auth.scope ?? scope,
          fallback: c.auth.fallback === "server",
          // Templates only (`${cred:…}` / `${secret:…}`) — they hold no values.
          env: c.auth.env ?? {},
          headers: c.auth.headers ?? {},
        }
      : null,
  };
}

/** Browseable MCP catalog for the signed-in user (group-filtered; install is separate). */
function catalogServers(ctx: UiContext, user: UserIdentity): unknown {
  const { registry, vault, profiles } = ctx;
  const stored = vault?.list(user.id) ?? {};
  registry.router.reloadServersFromDisk();
  const secretPaths = user.admin ? new Set(ctx.secrets.list()) : null;
  const servers = [];
  for (const name of registry.router.listAll()) {
    const cfg = registry.router.getConfig(name) as ServerConfig;
    if (!canAccess(cfg, user)) continue;
    // local: true needs the user's machine — hide from remote users (admins see it labelled).
    if (cfg.local && !user.admin) continue;
    if (cfg.disabled && !user.admin) continue;
    const scope = effectiveAuthScope(cfg);
    const fields = scope === "user" ? userFields(cfg) : [];
    const oauth = isOauthServer(cfg) && (scope === "user" || user.admin);
    const fieldStored = (stored[name] ?? []).length;
    const needsCreds = fields.length > 0 || oauth;
    const connected =
      (!fields.length || (fields.length > 0 && fieldStored >= fields.length)) &&
      (!oauth || ctx.oauthConnected(user.id, name, cfg));
    const refs = secretPaths ? secretRefsFor(name, cfg, secretPaths) : [];
    servers.push({
      name,
      description: cfg.description,
      keywords: cfg.keywords ?? [],
      transport: cfg.url ? "http" : "stdio",
      // command/args/URL can embed keys — admins only
      ...(user.admin
        ? { target: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].join(" ") }
        : {}),
      autoActivate: Boolean(cfg.autoActivate),
      disabled: Boolean(cfg.disabled),
      local: Boolean(cfg.local),
      oauth,
      sharedScopeMultiGroup: sharedScopeMultiGroup(cfg),
      needsCredentials: needsCreds,
      connected: needsCreds ? connected : true,
      installed: profiles.isServerInstalled(user.id, name),
      secretRefs: refs,
      missingSecrets: refs.filter((r) => !r.stored).length,
      fields: fields.map((f) => ({
        name: f,
        stored: (stored[name] ?? []).includes(f),
      })),
    });
  }
  return { servers };
}

/** Browseable skills catalog (same registry the broker uses). */
function catalogSkills(ctx: UiContext, user: UserIdentity): unknown {
  const skills = ctx.registry.skillRouter;
  skills.reloadFromDisk();
  const configured = existsSync(ctx.registry.skillsConfigPath);
  return {
    configured,
    skills: skills.listAll().flatMap((name) => {
      const c = skills.getConfig(name)!;
      if (!canAccess(c, user)) return [];
      if (c.disabled && !user.admin) return [];
      const instructionsPath = c.path.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
      const available = existsSync(instructionsPath) || existsSync(c.path);
      return [
        {
          name,
          description: c.description,
          keywords: c.keywords ?? [],
          ...(user.admin ? { path: c.path } : {}),
          plugin: c.plugin ?? null,
          migratedFrom: c.migratedFrom ?? null,
          available,
          disabled: Boolean(c.disabled),
          groups: c.groups ?? [],
          installed: ctx.profiles.isSkillInstalled(user.id, name),
          managed: isManagedSkillPath(ctx, c.path),
        },
      ];
    }),
  };
}

function installServer(ctx: UiContext, user: UserIdentity, name: string): unknown {
  ctx.registry.router.reloadServersFromDisk();
  const cfg = ctx.registry.router.getConfig(name);
  if (!cfg || cfg.disabled || !canAccess(cfg, user)) throw new HttpError(404, "No such server");
  if (cfg.local) {
    throw new HttpError(400, `Server "${name}" is local-only and cannot be used through the gateway`);
  }
  ctx.profiles.installServer(user.id, name);
  return { installed: true, name };
}

function uninstallServer(ctx: UiContext, user: UserIdentity, name: string): unknown {
  ctx.profiles.uninstallServer(user.id, name);
  return undefined;
}

function installSkill(ctx: UiContext, user: UserIdentity, name: string): unknown {
  ctx.registry.skillRouter.reloadFromDisk();
  const cfg = ctx.registry.skillRouter.getConfig(name);
  if (!cfg || cfg.disabled || !canAccess(cfg, user)) throw new HttpError(404, "No such skill");
  ctx.profiles.installSkill(user.id, name);
  return { installed: true, name };
}

function uninstallSkill(ctx: UiContext, user: UserIdentity, name: string): unknown {
  ctx.profiles.uninstallSkill(user.id, name);
  return undefined;
}

function readServersFile(path: string): { servers: Record<string, Record<string, unknown>> } {
  if (!existsSync(path)) return { servers: {} };
  try {
    const file = JSON.parse(readFileSync(path, "utf-8")) as { servers?: Record<string, Record<string, unknown>> };
    return { servers: file.servers && typeof file.servers === "object" ? file.servers : {} };
  } catch (e) {
    throw new HttpError(500, `Could not read servers.json: ${(e as Error).message}`);
  }
}

function writeServersFile(path: string, file: { servers: Record<string, Record<string, unknown>> }): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  if (existsSync(path)) writeFileSync(`${path}.bak-ui`, readFileSync(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function readSkillsFile(path: string): { skills: Record<string, Record<string, unknown>> } {
  if (!existsSync(path)) return { skills: {} };
  try {
    const file = JSON.parse(readFileSync(path, "utf-8")) as { skills?: Record<string, Record<string, unknown>> };
    return { skills: file.skills && typeof file.skills === "object" ? file.skills : {} };
  } catch (e) {
    throw new HttpError(500, `Could not read skills.json: ${(e as Error).message}`);
  }
}

function writeSkillsFile(path: string, file: { skills: Record<string, Record<string, unknown>> }): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  if (existsSync(path)) writeFileSync(`${path}.bak-ui`, readFileSync(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function managedSkillsRoot(ctx: UiContext): string {
  return resolve(ctx.registry.configDir, "managed-skills");
}

function isManagedSkillPath(ctx: UiContext, skillPath: string): boolean {
  // Trailing slash so `managed-skills-evil/...` cannot match `managed-skills`.
  const root = managedSkillsRoot(ctx).replace(/\/?$/, "/");
  const resolved = resolve(skillPath);
  return resolved.startsWith(root);
}

/**
 * Directory owned by one managed skill (`managed-skills/<name>/`).
 * Never returns the managed root itself or a parent that could hold other skills.
 */
function managedSkillOwnDir(ctx: UiContext, skillPath: string): string | undefined {
  const root = resolve(managedSkillsRoot(ctx));
  const resolved = resolve(skillPath);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const name = rel.split(/[/\\]/)[0];
  if (!name || name === "." || name === "..") return undefined;
  return join(root, name);
}

function writeManagedSkillFiles(skillDir: string, name: string, description: string, body: string): string {
  mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  const desc = description.replace(/\r?\n/g, " ").replace(/"/g, '\\"');
  const skillMd =
    `---\nname: ${name}\ndescription: "${desc}"\n---\n\n` +
    `<!-- lazygate: full instructions in INSTRUCTIONS.md -->\n`;
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, skillMd, { mode: 0o600 });
  writeFileSync(join(skillDir, "INSTRUCTIONS.md"), body, { mode: 0o600 });
  return skillPath;
}

function readSkillBody(skillPath: string): string {
  const instructionsPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
  if (existsSync(instructionsPath)) return readFileSync(instructionsPath, "utf-8");
  if (!existsSync(skillPath)) return "";
  const raw = readFileSync(skillPath, "utf-8");
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1].trimStart() : raw;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function createServer(ctx: UiContext, user: UserIdentity, body: Record<string, unknown>): unknown {
  const name = asString(body.name, "name", 64);
  if (!NAME.test(name)) throw new HttpError(400, "name may contain letters, digits, '.', '_' and '-'");
  const path = ctx.registry.configPath;
  const file = readServersFile(path);
  if (file.servers[name]) throw new HttpError(409, `Server "${name}" already exists`);

  const entry: Record<string, unknown> = {
    description: typeof body.description === "string" ? body.description : "",
    keywords: stringList(body.keywords),
    autoActivate: body.autoActivate === true,
  };
  if (typeof body.url === "string" && body.url.trim()) {
    entry.type = "http";
    entry.url = body.url.trim();
    if (body.headers && typeof body.headers === "object") entry.headers = stringMap(body.headers, "headers") ?? {};
    if (body.oauth !== undefined) entry.oauth = body.oauth;
  } else {
    const command = asString(body.command, "command", 4096);
    assertUiCommand(command);
    entry.command = command;
    if (Array.isArray(body.args)) entry.args = body.args.map((x) => String(x));
    if (body.env && typeof body.env === "object") entry.env = stringMap(body.env, "env") ?? {};
  }
  if (Array.isArray(body.groups)) {
    const g = stringList(body.groups);
    if (g.length) entry.groups = g;
  }
  if (body.auth !== undefined && body.auth !== null) {
    const a = asObject(body.auth);
    const scope = a.scope === "user" ? "user" : "server";
    const auth: Record<string, unknown> = { scope };
    if (scope === "user" && a.fallback === true) auth.fallback = "server";
    const env = stringMap(a.env, "auth.env");
    const headers = stringMap(a.headers, "auth.headers");
    if (env) auth.env = env;
    if (headers) auth.headers = headers;
    if (!env && !headers) throw new HttpError(400, "Add at least one env var or header, or omit auth");
    entry.auth = auth;
  }

  const checked = parseServersConfig({ servers: { [name]: entry } }, path);
  if (checked.errors.length) throw new HttpError(400, checked.errors.join("; "));

  file.servers[name] = entry;
  writeServersFile(path, file);
  ctx.registry.router.reloadServersFromDisk();
  ctx.audit.recordAdmin({ user: user.id, action: "server.create", target: name, after: sanitizeServerEntry(entry) });
  return describeServer(name, ctx.registry.router.getConfig(name) as ServerConfig, new Set(ctx.secrets.list()));
}

/** Write the editable fields of one server back to servers.json (validated, atomic, backed up). */
function patchServer(ctx: UiContext, user: UserIdentity, name: string, patch: Record<string, unknown>): unknown {
  const path = ctx.registry.configPath;
  const file = readServersFile(path);
  const entry = file.servers[name];
  if (!entry) throw new HttpError(404, "No such server");
  const before = sanitizeServerEntry(entry);

  if ("description" in patch && typeof patch.description === "string") entry.description = patch.description;
  if ("keywords" in patch) entry.keywords = stringList(patch.keywords);
  if ("groups" in patch) {
    const g = stringList(patch.groups);
    if (g.length) entry.groups = g;
    else delete entry.groups;
  }
  if ("autoActivate" in patch) entry.autoActivate = patch.autoActivate === true;
  if ("disabled" in patch) {
    if (patch.disabled === true) entry.disabled = true;
    else delete entry.disabled;
  }
  if ("local" in patch) {
    if (patch.local === true) entry.local = true;
    else delete entry.local;
  }
  if ("command" in patch && typeof patch.command === "string") {
    // Unchanged command is allowed (UI resubmits it on every save); new/changed needs the allowlist.
    if (patch.command !== entry.command) assertUiCommand(patch.command);
    entry.command = patch.command;
    delete entry.url;
    delete entry.type;
  }
  if ("args" in patch) {
    const nextArgs = Array.isArray(patch.args) ? patch.args.map((x) => String(x)) : undefined;
    const prevArgs = Array.isArray(entry.args) ? (entry.args as unknown[]).map((x) => String(x)) : undefined;
    const argsChanged = JSON.stringify(nextArgs ?? null) !== JSON.stringify(prevArgs ?? null);
    if (argsChanged) {
      const cmd = typeof entry.command === "string" ? entry.command : "";
      if (!cmd) throw new HttpError(400, "Cannot set args without a stdio command");
      assertUiCommand(cmd);
    }
    if (nextArgs) entry.args = nextArgs;
    else delete entry.args;
  }
  if ("env" in patch) {
    const env = stringMap(patch.env, "env");
    if (env) entry.env = env;
    else delete entry.env;
  }
  if ("url" in patch && typeof patch.url === "string" && patch.url.trim()) {
    entry.type = "http";
    entry.url = patch.url.trim();
    delete entry.command;
    delete entry.args;
  }
  if ("headers" in patch) {
    const headers = stringMap(patch.headers, "headers");
    if (headers) entry.headers = headers;
    else delete entry.headers;
  }
  if ("oauth" in patch) {
    if (patch.oauth === null || patch.oauth === undefined) delete entry.oauth;
    else entry.oauth = patch.oauth;
  }
  if ("inheritEnv" in patch) {
    if (patch.inheritEnv === null || patch.inheritEnv === undefined) delete entry.inheritEnv;
    else entry.inheritEnv = patch.inheritEnv;
  }
  if ("toolTimeoutMs" in patch) {
    if (typeof patch.toolTimeoutMs === "number" && patch.toolTimeoutMs > 0) entry.toolTimeoutMs = patch.toolTimeoutMs;
    else delete entry.toolTimeoutMs;
  }
  if ("auth" in patch) {
    if (patch.auth === null) {
      delete entry.auth;
    } else {
      const a = asObject(patch.auth);
      const scope = a.scope === "user" ? "user" : "server";
      const auth: Record<string, unknown> = { scope };
      if (scope === "user" && a.fallback === true) auth.fallback = "server";
      const env = stringMap(a.env, "auth.env");
      const headers = stringMap(a.headers, "auth.headers");
      if (env) auth.env = env;
      if (headers) auth.headers = headers;
      if (!env && !headers) throw new HttpError(400, "Add at least one env var or header (use ${cred:field} / ${secret:path}), or remove auth");
      entry.auth = auth;
    }
  }

  const checked = parseServersConfig({ servers: { [name]: entry } }, path);
  if (checked.errors.length) throw new HttpError(400, checked.errors.join("; "));

  writeServersFile(path, file);
  ctx.registry.router.reloadServersFromDisk();
  ctx.audit.recordAdmin({
    user: user.id,
    action: "server.patch",
    target: name,
    before,
    after: sanitizeServerEntry(entry),
  });
  return describeServer(name, ctx.registry.router.getConfig(name) as ServerConfig, new Set(ctx.secrets.list()));
}

function deleteServer(ctx: UiContext, user: UserIdentity, name: string): unknown {
  const path = ctx.registry.configPath;
  const file = readServersFile(path);
  const prior = file.servers[name];
  if (!prior) throw new HttpError(404, "No such server");
  delete file.servers[name];
  writeServersFile(path, file);
  ctx.registry.router.reloadServersFromDisk();
  ctx.profiles.removeServerEverywhere(name);
  ctx.audit.recordAdmin({ user: user.id, action: "server.delete", target: name, before: sanitizeServerEntry(prior) });
  return undefined;
}

/** Snapshot safe for audit hashes (no secret values — templates and structure only). */
function sanitizeServerEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if (out.env && typeof out.env === "object") {
    out.env = Object.fromEntries(Object.keys(out.env as object).map((k) => [k, "[redacted]"]));
  }
  return out;
}

function listSkillsAdmin(ctx: UiContext): unknown {
  ctx.registry.skillRouter.reloadFromDisk();
  return {
    skills: ctx.registry.skillRouter.listAll().map((name) => {
      const c = ctx.registry.skillRouter.getConfig(name)!;
      return {
        name,
        description: c.description,
        keywords: c.keywords ?? [],
        path: c.path,
        plugin: c.plugin ?? null,
        migratedFrom: c.migratedFrom ?? null,
        managed: isManagedSkillPath(ctx, c.path),
        disabled: Boolean(c.disabled),
        groups: c.groups ?? [],
      };
    }),
  };
}

function getSkillAdmin(ctx: UiContext, name: string): unknown {
  ctx.registry.skillRouter.reloadFromDisk();
  const c = ctx.registry.skillRouter.getConfig(name);
  if (!c) throw new HttpError(404, "No such skill");
  return {
    name,
    description: c.description,
    keywords: c.keywords ?? [],
    path: c.path,
    plugin: c.plugin ?? null,
    migratedFrom: c.migratedFrom ?? null,
    managed: isManagedSkillPath(ctx, c.path),
    disabled: Boolean(c.disabled),
    groups: c.groups ?? [],
    body: readSkillBody(c.path),
  };
}

function createSkill(ctx: UiContext, user: UserIdentity, body: Record<string, unknown>): unknown {
  const name = asString(body.name, "name", 64);
  if (!NAME.test(name)) throw new HttpError(400, "name may contain letters, digits, '.', '_' and '-'");
  const description = typeof body.description === "string" ? body.description : "";
  const keywords = stringList(body.keywords);
  const skillBody = asString(body.body, "body", MAX_SKILL_BODY);
  const groups = Array.isArray(body.groups) ? stringList(body.groups) : [];

  const skillsPath = ctx.registry.skillsConfigPath;
  const file = readSkillsFile(skillsPath);
  if (file.skills[name]) throw new HttpError(409, `Skill "${name}" already exists`);

  const skillDir = join(managedSkillsRoot(ctx), name);
  const skillPath = writeManagedSkillFiles(skillDir, name, description, skillBody);
  const entry: Record<string, unknown> = { description, keywords, path: skillPath };
  if (groups.length) entry.groups = groups;
  const checked = parseSkillsConfig({ skills: { [name]: entry } }, skillsPath);
  if (checked.errors.length) throw new HttpError(400, checked.errors.join("; "));

  file.skills[name] = entry;
  writeSkillsFile(skillsPath, file);
  ctx.registry.skillRouter.reloadFromDisk();
  ctx.audit.recordAdmin({
    user: user.id,
    action: "skill.create",
    target: name,
    after: { description, keywords, path: skillPath, groups },
  });
  return getSkillAdmin(ctx, name);
}

function updateSkill(ctx: UiContext, user: UserIdentity, name: string, body: Record<string, unknown>): unknown {
  const skillsPath = ctx.registry.skillsConfigPath;
  const file = readSkillsFile(skillsPath);
  const entry = file.skills[name];
  if (!entry) throw new HttpError(404, "No such skill");
  const before = {
    description: entry.description ?? "",
    keywords: stringList(entry.keywords),
    path: entry.path,
    disabled: Boolean(entry.disabled),
    groups: stringList(entry.groups),
  };

  const contentEdit = "description" in body || "keywords" in body || "body" in body;
  if (contentEdit) {
    const description = typeof body.description === "string" ? body.description : String(entry.description ?? "");
    const keywords = "keywords" in body ? stringList(body.keywords) : stringList(entry.keywords);
    const skillBody =
      typeof body.body === "string" ? asString(body.body, "body", MAX_SKILL_BODY) : readSkillBody(String(entry.path));

    let skillPath = String(entry.path);
    const dir = isManagedSkillPath(ctx, skillPath)
      ? skillPath.endsWith("SKILL.md")
        ? dirname(skillPath)
        : skillPath
      : join(managedSkillsRoot(ctx), name);
    skillPath = writeManagedSkillFiles(dir, name, description, skillBody);

    entry.description = description;
    entry.keywords = keywords;
    entry.path = skillPath;
  }
  if ("disabled" in body) {
    if (body.disabled === true) entry.disabled = true;
    else delete entry.disabled;
  }
  if ("groups" in body) {
    const g = stringList(body.groups);
    if (g.length) entry.groups = g;
    else delete entry.groups;
  }
  const checked = parseSkillsConfig({ skills: { [name]: entry } }, skillsPath);
  if (checked.errors.length) throw new HttpError(400, checked.errors.join("; "));

  writeSkillsFile(skillsPath, file);
  ctx.registry.skillRouter.reloadFromDisk();
  ctx.audit.recordAdmin({
    user: user.id,
    action: "skill.update",
    target: name,
    before,
    after: {
      description: entry.description ?? "",
      keywords: stringList(entry.keywords),
      path: entry.path,
      disabled: Boolean(entry.disabled),
      groups: stringList(entry.groups),
    },
  });
  return getSkillAdmin(ctx, name);
}

function deleteSkill(ctx: UiContext, user: UserIdentity, name: string): unknown {
  const skillsPath = ctx.registry.skillsConfigPath;
  const file = readSkillsFile(skillsPath);
  const entry = file.skills[name];
  if (!entry) throw new HttpError(404, "No such skill");
  const skillPath = String(entry.path);
  delete file.skills[name];
  writeSkillsFile(skillsPath, file);
  ctx.registry.skillRouter.reloadFromDisk();
  ctx.profiles.removeSkillEverywhere(name);
  const ownDir = managedSkillOwnDir(ctx, skillPath);
  if (ownDir) {
    try {
      rmSync(ownDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  ctx.audit.recordAdmin({
    user: user.id,
    action: "skill.delete",
    target: name,
    before: { description: entry.description ?? "", path: skillPath },
  });
  return undefined;
}

// ── Connections (a user's own credentials + OAuth) ─────────────────────────

/** Same rule as the gateway's OAuth path: HTTP, OAuth not disabled, no static Authorization. */
function isOauthServer(cfg: ServerConfig): boolean {
  if (!cfg.url || cfg.oauth === false) return false;
  for (const group of [cfg.headers, cfg.auth?.headers]) {
    if (group && Object.keys(group).some((k) => k.toLowerCase() === "authorization")) return false;
  }
  return true;
}

async function connections(
  ctx: UiContext,
  user: UserIdentity,
  method: string,
  seg: string[],
  _body: unknown
): Promise<unknown> {
  const { registry, vault } = ctx;
  const resolver = new CredentialResolver(ctx.secrets);

  if (method === "GET" && seg.length === 1) {
    const stored = vault?.list(user.id) ?? {};
    const out = [];
    for (const name of registry.router.listAll()) {
      const cfg = registry.router.getConfig(name) as ServerConfig;
      if (!canAccess(cfg, user)) continue;
      if (cfg.disabled && !user.admin) continue;
      const scope = effectiveAuthScope(cfg);
      const fields = scope === "user" ? userFields(cfg) : [];
      const oauth = isOauthServer(cfg) && (scope === "user" || user.admin);
      if (!fields.length && !oauth) continue;
      if (fields.length && !vault) continue;
      out.push({
        server: name,
        description: cfg.description,
        fields: fields.map((f) => ({
          name: f,
          stored: (stored[name] ?? []).includes(f),
          header: credHeaderName(name, f),
          sharedFallback: cfg.auth?.fallback === "server" && ctx.secrets.get(`${name}/${f}`) !== undefined,
        })),
        oauth,
        oauthConnected: oauth ? ctx.oauthConnected(user.id, name, cfg) : false,
        oauthShared: oauth && scope !== "user",
        sharedScopeMultiGroup: sharedScopeMultiGroup(cfg),
      });
    }
    return { connections: out };
  }

  const [, server, action] = seg;
  const cfg = server ? registry.router.getConfig(server) : undefined;
  if (!cfg || cfg.disabled || !canAccess(cfg, user)) throw new HttpError(404, "No such server");

  if (method === "POST" && action === "oauth" && seg.length === 3) {
    const scope = effectiveAuthScope(cfg);
    if (!isOauthServer(cfg)) throw new HttpError(400, "This server does not use OAuth");
    if (scope !== "user" && !user.admin) throw new HttpError(403, "Only an admin can connect a shared OAuth server");
    const authorizationUrl = await ctx.beginOAuth(user.id, server, cfg);
    return { authorizationUrl };
  }

  if (method === "DELETE" && action === "oauth" && seg.length === 3) {
    const scope = effectiveAuthScope(cfg);
    if (scope !== "user" && !user.admin) throw new HttpError(403, "Only an admin can disconnect a shared OAuth server");
    if (!ctx.clearOAuth(user.id, server, cfg, user.admin)) throw new HttpError(404, "No OAuth token stored");
    return undefined;
  }

  const field = action;
  if (effectiveAuthScope(cfg) !== "user") throw new HttpError(404, "No such server");
  if (!vault) throw new HttpError(501, "Credential storage is not enabled on this gateway");
  const f = (field ?? "").toLowerCase();
  if (!userFields(cfg).includes(f)) throw new HttpError(404, "That server doesn't take this credential");

  if (method === "PUT" && seg.length === 3) {
    vault.set(user.id, server, f, asString(asObject(_body).value, "value"));
    return { stored: true };
  }
  if (method === "DELETE" && seg.length === 3) {
    if (!vault.delete(user.id, server, f)) throw new HttpError(404, "Nothing stored");
    return undefined;
  }
  throw new HttpError(404, "not found");
}
