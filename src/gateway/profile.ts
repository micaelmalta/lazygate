// src/gateway/profile.ts
// Per-user install lists for the gateway marketplace (opt-in from the shared catalog).

import { resolve } from "path";
import { fileMtimeMs, readPrivateJson, writePrivateJson } from "./private-file.js";

export interface UserProfile {
  servers: string[];
  skills: string[];
}

type StoreFile = Record<string, UserProfile>;

function normalizeList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const n = x.trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function empty(): UserProfile {
  return { servers: [], skills: [] };
}

export class UserProfileStore {
  private readonly path: string;
  private data: StoreFile;
  private mtime = -1;

  constructor(gatewayDir: string) {
    this.path = resolve(gatewayDir, "profiles.json");
    this.data = {};
    this.load();
  }

  /** Re-read when the file changed (another process / admin wrote profiles.json). */
  private load(): StoreFile {
    const m = fileMtimeMs(this.path);
    if (m !== this.mtime) {
      this.data = readPrivateJson<StoreFile>(this.path, {}, "profiles");
      for (const [user, p] of Object.entries(this.data)) {
        this.data[user] = {
          servers: normalizeList(p?.servers),
          skills: normalizeList(p?.skills),
        };
      }
      this.mtime = m;
    }
    return this.data;
  }

  private save(): void {
    writePrivateJson(this.path, this.data);
    this.mtime = fileMtimeMs(this.path);
  }

  private ensure(userId: string): UserProfile {
    const data = this.load();
    if (!data[userId]) data[userId] = empty();
    return data[userId];
  }

  get(userId: string): UserProfile {
    const p = this.load()[userId];
    return p ? { servers: [...p.servers], skills: [...p.skills] } : empty();
  }

  isServerInstalled(userId: string, name: string): boolean {
    return (this.load()[userId]?.servers ?? []).includes(name);
  }

  isSkillInstalled(userId: string, name: string): boolean {
    return (this.load()[userId]?.skills ?? []).includes(name);
  }

  installServer(userId: string, name: string): boolean {
    const p = this.ensure(userId);
    if (p.servers.includes(name)) return false;
    p.servers.push(name);
    p.servers.sort();
    this.save();
    return true;
  }

  uninstallServer(userId: string, name: string): boolean {
    const p = this.load()[userId];
    if (!p) return false;
    const next = p.servers.filter((s) => s !== name);
    if (next.length === p.servers.length) return false;
    p.servers = next;
    this.save();
    return true;
  }

  installSkill(userId: string, name: string): boolean {
    const p = this.ensure(userId);
    if (p.skills.includes(name)) return false;
    p.skills.push(name);
    p.skills.sort();
    this.save();
    return true;
  }

  uninstallSkill(userId: string, name: string): boolean {
    const p = this.load()[userId];
    if (!p) return false;
    const next = p.skills.filter((s) => s !== name);
    if (next.length === p.skills.length) return false;
    p.skills = next;
    this.save();
    return true;
  }

  /** Drop a server from every user's install list (admin deleted the catalog entry). */
  removeServerEverywhere(name: string): void {
    const data = this.load();
    let changed = false;
    for (const p of Object.values(data)) {
      const next = p.servers.filter((s) => s !== name);
      if (next.length !== p.servers.length) {
        p.servers = next;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Drop a skill from every user's install list. */
  removeSkillEverywhere(name: string): void {
    const data = this.load();
    let changed = false;
    for (const p of Object.values(data)) {
      const next = p.skills.filter((s) => s !== name);
      if (next.length !== p.skills.length) {
        p.skills = next;
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
