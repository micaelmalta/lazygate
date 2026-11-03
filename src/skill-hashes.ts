// src/skill-hashes.ts
// Content-hash tracking for skill bodies (M12). The first hash seen for a skill is the baseline;
// a later body that hashes differently is flagged as "changed" until an admin acknowledges it.
// State lives next to skills.json handling in the config dir: skills-hashes.json (0600).

import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { LOG_PREFIX } from "./version.js";

export interface SkillHashRecord {
  /** Baseline: SHA-256 (hex) of the body when first seen or last acknowledged. */
  sha256: string;
  firstSeen: string;
}

export interface SkillHashCheck {
  sha256: string;
  /** Body hash differs from the recorded baseline. */
  changed: boolean;
  /** This call recorded the baseline. */
  first: boolean;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class SkillHashStore {
  // Null prototype: a skill named "__proto__" must stay an ordinary key.
  private data: Record<string, SkillHashRecord> = Object.create(null);

  constructor(private readonly path: string | null) {
    this.read();
  }

  private read(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as Record<string, SkillHashRecord>;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) Object.assign(this.data, raw);
    } catch (err) {
      console.error(`${LOG_PREFIX} could not read ${this.path}: ${(err as Error).message}`);
    }
  }

  private write(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
      if (process.platform !== "win32") chmodSync(this.path, 0o600);
    } catch (err) {
      console.error(`${LOG_PREFIX} could not write ${this.path}: ${(err as Error).message}`);
    }
  }

  /** Compare without recording anything. Unknown skills are never "changed". */
  peek(name: string, body: string): SkillHashCheck {
    const sha256 = sha256Hex(body);
    const rec = Object.prototype.hasOwnProperty.call(this.data, name) ? this.data[name] : undefined;
    return { sha256, changed: Boolean(rec && rec.sha256 !== sha256), first: false };
  }

  /** Compare and, when the skill has no baseline yet, record it. */
  observe(name: string, body: string): SkillHashCheck {
    const sha256 = sha256Hex(body);
    const rec = Object.prototype.hasOwnProperty.call(this.data, name) ? this.data[name] : undefined;
    if (!rec) {
      this.data[name] = { sha256, firstSeen: new Date().toISOString() };
      this.write();
      return { sha256, changed: false, first: true };
    }
    return { sha256, changed: rec.sha256 !== sha256, first: false };
  }

  /** Accept the current body as the new baseline (admin review done). */
  acknowledge(name: string, body: string): void {
    this.data[name] = { sha256: sha256Hex(body), firstSeen: new Date().toISOString() };
    this.write();
  }
}
