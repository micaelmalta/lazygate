#!/usr/bin/env node
// Verifies what `npm publish` would ship: the files the CLI needs are present, and nothing that
// should stay private or is only useful in the repo (sources, tests, env files, assessments) leaks.
// Run after a build: `npm run pack:check`.

import { execFileSync } from "child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const raw = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const [pack] = JSON.parse(raw);
const files = pack.files.map((f) => f.path);

const required = [
  "package.json",
  "README.md",
  "dist/index.js",
  "dist/broker.js",
  "dist/discovery.js",
  "dist/discovery-eval.js",
  "scripts/benchmark.mjs",
  "scripts/migrate.mjs",
  "scripts/revert-migration.mjs",
  "scripts/session-sync.mjs",
  "scripts/lib/shared.mjs",
  "scripts/lib/suite.mjs",
  "scripts/fixtures/suite-server.mjs",
  "scripts/fixtures/suite-data.mjs",
  "scripts/fixtures/suite-tools.mjs",
  "scripts/fixtures/discovery-eval.json",
  "scripts/fixtures/discovery-heldout.json",
  "config/servers.json",
  "config/skills.json",
];
const forbidden = [
  /(^|\/)__tests__\//,
  /^src\//,
  /(^|\/)\.env/,
  /^ASSESSMENT/,
  /^FEEDBACK/,
  /^CLAUDE\.md$/,
  /^benchmark-results\//,
  /\.bak-/,
  /\.tgz$/,
];

const problems = [];
for (const path of required) if (!files.includes(path)) problems.push(`missing from the package: ${path}`);
for (const path of files) {
  if (forbidden.some((pattern) => pattern.test(path))) problems.push(`should not be published: ${path}`);
}
const mb = pack.unpackedSize / 1024 / 1024;
if (mb > 5) problems.push(`unpacked size ${mb.toFixed(1)} MB is unexpectedly large`);

if (problems.length) {
  console.error(`✗ ${pack.name}@${pack.version} package check failed:`);
  for (const line of problems) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`✓ ${pack.name}@${pack.version}: ${files.length} files, ${(pack.size / 1024).toFixed(0)} kB packed, ${mb.toFixed(1)} MB unpacked`);
