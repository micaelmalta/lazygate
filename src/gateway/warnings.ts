// src/gateway/warnings.ts
// Startup warnings about permissive catalog defaults (M2). Pure so it can be unit-tested.

import { effectiveAuthScope, type ServerConfig } from "../router.js";
import type { SkillConfig } from "../skill-router.js";

export interface WarningInputs {
  servers: Record<string, ServerConfig>;
  skills: Record<string, SkillConfig>;
  /** Distinct user ids that hold an access token. */
  userCount: number;
}

/** True when the entry is shared-scope (any transport) and visible to more than one group or everyone. */
export function sharedScopeVisibleToMany(cfg: ServerConfig): boolean {
  if (effectiveAuthScope(cfg) !== "server") return false;
  return !cfg.groups || cfg.groups.length !== 1;
}

export function gatewayStartupWarnings(input: WarningInputs): string[] {
  const out: string[] = [];
  const noGroups: string[] = [];

  for (const [name, cfg] of Object.entries(input.servers)) {
    if (cfg.local || cfg.disabled) continue;
    const stdio = !cfg.url && cfg.type !== "http";
    if (sharedScopeVisibleToMany(cfg)) {
      out.push(
        stdio
          ? `warning: stdio server "${name}" uses shared scope (auth.scope=server) and is visible to more than one group — every caller shares one process identity and credential`
          : `warning: server "${name}" uses shared credentials (auth.scope=server) and is visible to more than one group — every caller acts as the same identity`
      );
    }
    if (!cfg.groups || cfg.groups.length === 0) noGroups.push(`server "${name}"`);
  }
  for (const [name, cfg] of Object.entries(input.skills)) {
    if (cfg.disabled) continue;
    if (!cfg.groups || cfg.groups.length === 0) noGroups.push(`skill "${name}"`);
  }

  if (input.userCount > 1 && noGroups.length) {
    const shown = noGroups.slice(0, 10).join(", ");
    const more = noGroups.length > 10 ? ` and ${noGroups.length - 10} more` : "";
    out.push(
      `warning: ${noGroups.length} catalog entr${noGroups.length === 1 ? "y has" : "ies have"} no \`groups\` while ${input.userCount} users have tokens — visible to everyone: ${shown}${more}`
    );
  }
  return out;
}
