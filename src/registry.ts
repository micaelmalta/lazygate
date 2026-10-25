// src/registry.ts
// Loads the server and skill registries (shared by stdio mode and the HTTP gateway).

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { ToolRouter, type ServerConfig } from "./router.js";
import { SkillRouter } from "./skill-router.js";
import { ToolIndex } from "./tool-index.js";
import { parseServersConfig, parseSkillsConfig, reportConfigErrors } from "./config.js";
import { configDir } from "./paths.js";
import { LOG_PREFIX } from "./version.js";

export interface Registry {
  router: ToolRouter;
  skillRouter: SkillRouter;
  toolIndex: ToolIndex;
  serverConfigs: Record<string, ServerConfig>;
  /** Absolute path used for servers.json reads/writes (may not exist yet). */
  configPath: string;
  /** Absolute path used for skills.json reads/writes (may not exist yet). */
  skillsConfigPath: string;
  /** Config directory (e.g. ~/.config/lazygate) — managed-skills live under here. */
  configDir: string;
}

/**
 * Resolution: --<flag> <path> → <dir>/<file>.
 * Returns the path even when the file is missing so the UI can create it.
 * The bundled config/ directory only holds *examples* and is never loaded implicitly.
 */
function resolveWritableConfigPath(argv: string[], flag: string, file: string, dir: string): string {
  const flagIdx = argv.indexOf(flag);
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    return resolve(argv[flagIdx + 1]);
  }
  return resolve(dir, file);
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}

export function loadRegistry(argv: string[], dir: string = configDir()): Registry {
  const configPath = resolveWritableConfigPath(argv, "--config", "servers.json", dir);
  let serverConfigs: Record<string, ServerConfig> = {};
  if (existsSync(configPath)) {
    const { entries, errors } = parseServersConfig(loadJson(configPath), configPath);
    serverConfigs = entries;
    reportConfigErrors(errors);
    console.error(`${LOG_PREFIX} Config: ${configPath} (${Object.keys(entries).length} servers)`);
  } else {
    console.error(
      `${LOG_PREFIX} No servers.json found at ${configPath}. ` +
        `Create it (see config/servers.json in the repo for an example) or pass --config <path>. ` +
        `Starting with an empty registry.`
    );
  }

  const toolIndex = new ToolIndex(resolve(dir, "tool-index.json"));
  const router = new ToolRouter(serverConfigs, configPath, toolIndex);

  const skillsConfigPath = resolveWritableConfigPath(argv, "--skills", "skills.json", dir);
  let skillEntries: Record<string, import("./skill-router.js").SkillConfig> = {};
  if (existsSync(skillsConfigPath)) {
    try {
      const { entries, errors } = parseSkillsConfig(loadJson(skillsConfigPath), skillsConfigPath);
      reportConfigErrors(errors);
      skillEntries = entries;
      console.error(`${LOG_PREFIX} Skills config: ${skillsConfigPath} (${Object.keys(entries).length} skills)`);
    } catch (err) {
      // A half-written skills.json must not stop startup; it is re-read lazily.
      console.error(`${LOG_PREFIX} ${(err as Error).message} — will retry on first use`);
    }
  }

  const skillRouter = new SkillRouter(skillEntries, skillsConfigPath);

  return { router, skillRouter, toolIndex, serverConfigs, configPath, skillsConfigPath, configDir: dir };
}
