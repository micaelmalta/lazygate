// src/gateway/tool-index-warm.ts
// Admin "index all": activate shared-scope catalog servers once to populate ToolIndex.
//
// Safety: never write tool lists fetched with a user's credentials into the shared index.
// Only servers with effectiveAuthScope "server" (stdio default, or HTTP with auth.scope: server)
// are indexed — those use gateway secrets / shared OAuth, not per-user vault keys.

import { ProcessManager } from "../process-manager.js";
import { effectiveAuthScope, type ServerConfig } from "../router.js";
import { bareToolName } from "../tool-names.js";
import type { Registry } from "../registry.js";
import { CredentialResolver, type SecretStore } from "./credentials.js";

export interface WarmIndexResult {
  /** Servers whose tools were written to the shared ToolIndex. */
  indexed: Array<{ name: string; tools: number }>;
  /** Catalog servers skipped (user-scoped, disabled, local, …). */
  skipped: Array<{ name: string; reason: string }>;
  /** Shared-scope servers that failed to activate / list tools. */
  failed: Array<{ name: string; error: string }>;
}

/** True when it is safe to put this server's tool list in the shared ToolIndex. */
export function isSharedIndexable(cfg: ServerConfig): boolean {
  if (cfg.disabled) return false;
  if (cfg.local) return false;
  return effectiveAuthScope(cfg) === "server";
}

export function skipReasonForIndex(cfg: ServerConfig): string | undefined {
  if (cfg.disabled) return "disabled";
  if (cfg.local) return "local (not available in gateway mode)";
  if (effectiveAuthScope(cfg) === "user") {
    return "user-scoped credentials — tool lists must not enter the shared index";
  }
  return undefined;
}

/**
 * Activate each shared-scope catalog server long enough to list tools, record them,
 * then deactivate. Does not touch user sessions or user vault credentials.
 */
export async function warmSharedToolIndex(opts: {
  registry: Registry;
  secrets: SecretStore;
  stdioCommandAllowlist?: readonly string[];
}): Promise<WarmIndexResult> {
  const { registry, secrets } = opts;
  const resolver = new CredentialResolver(secrets);
  const result: WarmIndexResult = { indexed: [], skipped: [], failed: [] };

  const manager = new ProcessManager({
    oauthInteractive: false,
    defaultInheritEnv: false,
    stdioCommandAllowlist: opts.stdioCommandAllowlist,
    idleTtlMs: 0,
    maxActiveServers: 0,
    maxActiveTools: 0,
  });

  try {
    registry.router.reloadServersFromDisk();
    for (const name of registry.router.listAll()) {
      const cfg = registry.router.getConfig(name);
      if (!cfg) continue;

      const skip = skipReasonForIndex(cfg);
      if (skip) {
        result.skipped.push({ name, reason: skip });
        continue;
      }

      try {
        const { runtime } = resolver.resolve(name, cfg, new Map());
        const tools = await manager.activate(name, cfg, runtime);
        // activate() may return exposed (namespaced) names; index bare upstream names.
        const bare = tools.map((t) => ({
          name: bareToolName(name, t.name),
          description: t.description,
        }));
        registry.toolIndex.record(name, cfg, bare);
        result.indexed.push({ name, tools: bare.length });
      } catch (err) {
        result.failed.push({ name, error: (err as Error).message });
      } finally {
        manager.deactivate(name);
      }
    }
  } finally {
    manager.dispose();
  }

  return result;
}
