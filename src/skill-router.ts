// src/skill-router.ts
// Scores and loads relevant skills based on a query.
// Also lists/reads bundled skill files for remote clients (skill:// URIs).

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { parseSkillsConfig, reportConfigErrors } from "./config.js";
import { scoreEntry } from "./scoring.js";
import { LOG_PREFIX } from "./version.js";

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Soft cap on skill bodies returned by load_skill (UTF-8 bytes). */
export const DEFAULT_SKILL_BODY_MAX_BYTES = 24_000;

/** Soft cap on a single skill file returned by read_skill_file / resources/read. */
export const DEFAULT_SKILL_FILE_MAX_BYTES = 512_000;

/** Max files listed under one skill directory. */
export const MAX_SKILL_FILES = 200;

/** Skip these directory names when walking a skill tree. */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

export interface SkillConfig {
  description: string;
  keywords: string[];
  path: string;
  migratedFrom?: string;
  plugin?: string;
  /** Soft-disable: hidden from non-admins; load_skill refuses for everyone. */
  disabled?: boolean;
  /** Gateway mode: only users in one of these groups can see or install (omit = everyone). */
  groups?: string[];
}

export interface SkillRouterResult {
  name: string;
  score: number;
  reason: string[];
  descriptionMatches: string[];
}

export interface LoadSkillOptions {
  /** Max UTF-8 bytes of body to return. Default {@link DEFAULT_SKILL_BODY_MAX_BYTES}; `0` = unlimited. */
  maxBytes?: number;
}

export interface SkillFileContents {
  /** Relative path within the skill directory (posix-style). */
  path: string;
  /** Absolute path on disk (for local diagnostics only). */
  absolutePath: string;
  mimeType: string;
  /** UTF-8 text when the file looks like text; otherwise undefined. */
  text?: string;
  /** Raw bytes when not returned as text. */
  blob?: Buffer;
  size: number;
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Cap a skill body and append a "read more" pointer when truncated.
 * `maxBytes` limits the body only (the pointer is extra).
 */
export function capSkillBody(body: string, maxBytes: number, readMorePath: string): string {
  if (maxBytes <= 0) return body;
  const total = Buffer.byteLength(body, "utf8");
  if (total <= maxBytes) return body;
  const shown = truncateUtf8(body, maxBytes);
  const shownBytes = Buffer.byteLength(shown, "utf8");
  return (
    `${shown}\n\n… [truncated — showing first ${shownBytes} of ${total} bytes. ` +
    `Read more: ${readMorePath} (via read_skill_file or resources/read)]`
  );
}

/** Directory that contains the skill's files (parent of SKILL.md / path). */
export function skillRootDir(cfg: SkillConfig): string {
  return dirname(cfg.path);
}

/** `skill://<name>/<relPath>` — relPath uses `/` separators. */
export function formatSkillUri(skillName: string, relPath: string): string {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return clean ? `skill://${skillName}/${clean}` : `skill://${skillName}/`;
}

/**
 * Parse a `skill://name/path` URI. Returns null when the scheme or shape is wrong.
 * Relative path may be empty (skill root).
 */
export function parseSkillUri(uri: string): { name: string; relPath: string } | null {
  const m = /^skill:\/\/([^/?#]+)(?:\/(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  const name = decodeURIComponent(m[1]!);
  const raw = m[2] ?? "";
  const relPath = raw
    .split("/")
    .filter((p) => p.length > 0)
    .map((p) => decodeURIComponent(p))
    .join("/");
  return { name, relPath };
}

function looksLikeText(buf: Buffer, ext: string): boolean {
  const textExts = new Set([
    ".md",
    ".txt",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".css",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".py",
    ".sh",
    ".bash",
    ".zsh",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".swift",
    ".sql",
    ".csv",
    ".tsv",
    ".env",
    ".gitignore",
    ".dockerfile",
  ]);
  if (textExts.has(ext.toLowerCase())) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return false;
  // Mostly printable / whitespace
  let weird = 0;
  for (const b of sample) {
    if (b < 9 || (b > 13 && b < 32) || b === 127) weird++;
  }
  return weird / Math.max(sample.length, 1) < 0.05;
}

function mimeFor(relPath: string, isText: boolean): string {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/plain";
  if (lower.endsWith(".py") || lower.endsWith(".sh")) return "text/plain";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return isText ? "text/plain" : "application/octet-stream";
}

/** Resolve `relPath` under the skill root; throws if it escapes. */
export function resolveSkillFilePath(root: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((p) => p === ".." || p === "")) {
    throw new Error(`Invalid skill file path: "${relPath}"`);
  }
  const abs = resolve(root, ...normalized.split("/"));
  const rootAbs = resolve(root);
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    throw new Error(`Skill file path escapes skill directory: "${relPath}"`);
  }
  return abs;
}

function walkSkillFiles(root: string, dir: string, out: string[], depth: number): void {
  if (out.length >= MAX_SKILL_FILES || depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= MAX_SKILL_FILES) return;
    if (ent.name.startsWith(".")) continue;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walkSkillFiles(root, join(dir, ent.name), out, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    const abs = join(dir, ent.name);
    const rel = relative(root, abs).split(sep).join("/");
    out.push(rel);
  }
}

export class SkillRouter {
  private skills: Record<string, SkillConfig>;
  private readonly configPath?: string;
  /** Last applied (or failed-with-keep) mtime; skip re-read when unchanged. */
  private configMtime = -1;

  constructor(skills: Record<string, SkillConfig>, configPath?: string) {
    this.skills = skills;
    this.configPath = configPath;
    if (configPath) this.configMtime = fileMtimeMs(configPath);
  }

  /** Re-read skills.json when its mtime changes (session-sync rewrites it at session start). */
  reloadFromDisk(): boolean {
    if (!this.configPath) return false;
    const mtime = fileMtimeMs(this.configPath);
    if (mtime === this.configMtime) return false;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf-8"));
      const { entries, errors } = parseSkillsConfig(raw, this.configPath);
      reportConfigErrors(errors);
      this.skills = entries;
      this.configMtime = mtime;
      return true;
    } catch (err) {
      this.configMtime = mtime;
      console.error(
        `${LOG_PREFIX} Could not reload ${this.configPath}: ${(err as Error).message} — keeping previous skills`
      );
      return false;
    }
  }

  rank(query: string): SkillRouterResult[] {
    const results: SkillRouterResult[] = [];

    for (const [name, config] of Object.entries(this.skills)) {
      const s = scoreEntry(query, config);
      if (s.score > 0) {
        results.push({
          name,
          score: s.score,
          reason: s.keywords,
          descriptionMatches: s.descriptionWords,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  load(skillName: string, opts: LoadSkillOptions = {}): string {
    const skill = this.skills[skillName];
    if (!skill) {
      throw new Error(
        `Unknown skill: "${skillName}". Available: ${Object.keys(this.skills).join(", ")}`
      );
    }

    // Prefer INSTRUCTIONS.md (body split from SKILL.md) if present
    const instructionsPath = skill.path.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
    const loadPath = existsSync(instructionsPath) ? instructionsPath : skill.path;

    if (!existsSync(loadPath)) {
      throw new Error(`Skill file not found: ${loadPath}`);
    }

    const body = readFileSync(loadPath, "utf-8");
    const maxBytes = opts.maxBytes ?? DEFAULT_SKILL_BODY_MAX_BYTES;
    const root = skillRootDir(skill);
    const rel = relative(root, loadPath).split(sep).join("/") || "SKILL.md";
    return capSkillBody(body, maxBytes, formatSkillUri(skillName, rel));
  }

  /**
   * Relative paths of files under the skill directory (posix separators), sorted.
   * Empty when the skill directory is missing.
   */
  listFiles(skillName: string): string[] {
    const skill = this.skills[skillName];
    if (!skill) {
      throw new Error(
        `Unknown skill: "${skillName}". Available: ${Object.keys(this.skills).join(", ")}`
      );
    }
    const root = skillRootDir(skill);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    walkSkillFiles(root, root, out, 0);
    return out.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Read one file under a skill. `relPath` is relative to the skill directory.
   * Throws on unknown skill, path escape, or missing file.
   */
  readFile(skillName: string, relPath: string, opts: { maxBytes?: number } = {}): SkillFileContents {
    const skill = this.skills[skillName];
    if (!skill) {
      throw new Error(
        `Unknown skill: "${skillName}". Available: ${Object.keys(this.skills).join(", ")}`
      );
    }
    const root = skillRootDir(skill);
    const abs = resolveSkillFilePath(root, relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`Skill file not found: ${formatSkillUri(skillName, relPath)}`);
    }
    const buf = readFileSync(abs);
    const maxBytes = opts.maxBytes ?? DEFAULT_SKILL_FILE_MAX_BYTES;
    if (maxBytes > 0 && buf.length > maxBytes) {
      throw new Error(
        `Skill file too large (${buf.length} bytes; max ${maxBytes}): ${formatSkillUri(skillName, relPath)}`
      );
    }
    const posix = relative(root, abs).split(sep).join("/");
    const ext = posix.includes(".") ? `.${posix.split(".").pop()}` : "";
    const isText = looksLikeText(buf, ext);
    return {
      path: posix,
      absolutePath: abs,
      mimeType: mimeFor(posix, isText),
      text: isText ? buf.toString("utf-8") : undefined,
      blob: isText ? undefined : buf,
      size: buf.length,
    };
  }

  getConfig(name: string): SkillConfig | undefined {
    return this.skills[name];
  }

  listAll(): string[] {
    return Object.keys(this.skills);
  }
}
