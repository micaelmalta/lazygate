// src/tool-index.ts
// Persistent index of each server's tool names/descriptions, learned on first activation.
// Lets discover_tools route by what a server's tools actually do — including for servers
// whose configured description is generic (e.g. migrated ones) and that are not running.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from "fs";
import { dirname } from "path";
import type { ServerConfig } from "./router.js";
import { LOG_PREFIX } from "./version.js";

export interface IndexedTool {
  name: string;
  description: string;
}

interface Entry {
  /** Hash of the spawn/connect inputs; a changed server invalidates its index. */
  sig: string;
  tools: IndexedTool[];
}

const MAX_TOOLS_PER_SERVER = 200;
const MAX_DESCRIPTION_CHARS = 200;

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function serverSignature(cfg: ServerConfig): string {
  return JSON.stringify([cfg.command ?? null, cfg.args ?? [], cfg.url ?? null]);
}

/** Searchable text for one server: tool names (split on _ and -) plus descriptions. */
export function toolText(tools: IndexedTool[]): string {
  return tools
    .map((t) => `${t.name.replace(/[_-]+/g, " ")} ${t.description}`)
    .join(" ");
}

export class ToolIndex {
  private data: Record<string, Entry> = {};
  private mtime = -1;

  /** @param path JSON file to persist to; omit for a purely in-memory index. */
  constructor(private readonly path?: string) {
    this.ensureLoaded();
  }

  /**
   * Re-read when the on-disk file changed (another process wrote tool-index.json).
   * Avoids last-writer-wins blind overwrite of external updates.
   */
  private ensureLoaded(): void {
    if (!this.path) return;
    const m = fileMtimeMs(this.path);
    if (m === this.mtime) return;
    if (!existsSync(this.path)) {
      this.data = {};
      this.mtime = m;
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as Record<string, Entry>;
      this.data = raw && typeof raw === "object" ? raw : {};
    } catch {
      /* corrupt cache — rebuilt as servers are activated */
      this.data = {};
    }
    this.mtime = m;
  }

  /** Indexed tools for a server, or [] if unknown or stale (config changed). */
  get(name: string, cfg: ServerConfig): IndexedTool[] {
    this.ensureLoaded();
    const e = this.data[name];
    return e && e.sig === serverSignature(cfg) ? e.tools : [];
  }

  /**
   * Servers whose (fresh) index contains an exact tool name.
   * Used for auto-activation when the client calls a known tool by name.
   */
  findServersWithTool(toolName: string, servers: Record<string, ServerConfig>): string[] {
    this.ensureLoaded();
    const hits: string[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
      if (this.get(name, cfg).some((t) => t.name === toolName)) hits.push(name);
    }
    return hits;
  }

  /** Remember a server's tools. Returns true when the stored index changed. */
  record(name: string, cfg: ServerConfig, tools: Array<{ name: string; description?: string }>): boolean {
    this.ensureLoaded();
    const entry: Entry = {
      sig: serverSignature(cfg),
      tools: tools.slice(0, MAX_TOOLS_PER_SERVER).map((t) => ({
        name: t.name,
        description: (t.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
      })),
    };
    if (JSON.stringify(this.data[name]) === JSON.stringify(entry)) return false;
    this.data[name] = entry;
    this.save();
    return true;
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
      renameSync(tmp, this.path);
      this.mtime = fileMtimeMs(this.path);
    } catch (err) {
      console.error(`${LOG_PREFIX} could not write tool index: ${(err as Error).message}`);
    }
  }
}
