// Smoke test for `benchmark --tasks --cold-discovery`. The live run needs a logged-in claude CLI and
// is not executed here; --estimate prints the instructions each strategy would get, which is enough
// to check that cold mode stops naming the server and tools for the lazygate strategies.

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(repoRoot, "scripts/benchmark.mjs");

describe("benchmark --tasks --cold-discovery (dry run)", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(resolve(tmpdir(), "lazygate-cold-tasks-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const run = (args: string[]) =>
    execFileSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("gives the lazygate strategies neutral instructions that name neither the server nor the tools", () => {
    const cold = run(["--tasks", "--cold-discovery", "--estimate"]);
    expect(cold).toContain("--cold-discovery");
    const lazygateSections = cold.split("[").filter((section) => /^(call_tool|call_tool\+opt|run_chain)\]/.test(section));
    // Three lazygate strategies per task (tickets, orders, logs, cross).
    expect(lazygateSections).toHaveLength(3 * 4);
    for (const section of lazygateSections) {
      expect(section).toContain("do not know which upstream servers or tools exist");
      expect(section).not.toMatch(/"(tickets|orders|logs)"|list_tickets|get_ticket|list_orders|get_order|search_logs|get_log_entry/);
    }

    const known = run(["--tasks", "--estimate"]);
    expect(known).toContain('Upstream server: "tickets"');
    expect(known).not.toContain("--cold-discovery");
  });

  it("rejects --cold-discovery outside --tasks", () => {
    let failure: { status?: number; stderr?: string } = {};
    try {
      run(["--cold-discovery", "--estimate"]);
    } catch (err) {
      failure = err as { status?: number; stderr?: string };
    }
    expect(failure.status).toBe(1);
    expect(String(failure.stderr)).toMatch(/--cold-discovery only applies to --tasks/);
  });
});
