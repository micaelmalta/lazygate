// src/env-file.ts
// Load a dotenv file into the environment at startup.

import { readFileSync } from "fs";
import { parseEnv } from "util";

/**
 * Copy variables from a dotenv file into `env`. Variables already set (even to "") win over the
 * file. A missing file is not an error. Returns the names that were set.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] !== undefined || value === undefined) continue;
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
