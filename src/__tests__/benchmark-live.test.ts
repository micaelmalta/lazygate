import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("live response benchmark", () => {
  it("measures an MCP response against off and projection policies and checks preserved values", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "lazygate-live-bench-test-"));
    try {
      const serverPath = resolve(repoRoot, "src/__tests__/fixtures/benchmark-response-server.mjs");
      const configPath = resolve(tempDir, "servers.json");
      const casesPath = resolve(tempDir, "cases.json");
      writeFileSync(configPath, JSON.stringify({
        servers: {
          fixture: { command: process.execPath, args: [serverPath] },
        },
      }));
      writeFileSync(casesPath, JSON.stringify({
        cases: [{
          name: "fixture-search",
          server: "fixture",
          tool: "search_records",
          args: {},
          readOnly: true,
          preservePaths: ["$.structuredContent.items[*].id", "$.structuredContent.items[*].title"],
          policies: [
            { name: "off", mode: "off" },
            { name: "projection", mode: "project", fields: ["items.id", "items.title"] },
          ],
        }],
      }));

      const stdout = execFileSync(process.execPath, [
        resolve(repoRoot, "scripts/benchmark.mjs"),
        "--responses-live",
        "--cases",
        casesPath,
        "--iterations",
        "2",
        "--config",
        configPath,
      ], { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
      const output = JSON.parse(stdout);
      expect(output.method).toMatch(/live MCP calls/);
      expect(output.measurements).toHaveLength(2);

      const off = output.measurements.find((measurement: { policy: string }) => measurement.policy === "off");
      const projection = output.measurements.find((measurement: { policy: string }) => measurement.policy === "projection");
      expect(off.sampleCount).toBe(2);
      expect(projection.sampleCount).toBe(2);
      expect(projection.optimizedTokens.median).toBeLessThan(off.optimizedTokens.median);
      expect(projection.correctness).toEqual({ passed: 2, checked: 2 });
      expect(projection.upstreamLatencyMs).toHaveProperty("p95");
      expect(projection.optimizationLatencyMs).toHaveProperty("stdDev");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
