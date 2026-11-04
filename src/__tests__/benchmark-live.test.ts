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
          args: { intermittentDepth: true },
          readOnly: true,
          preservePaths: ["$.structuredContent.items[*].id", "$.structuredContent.items[*].title"],
          policies: [
            { name: "off", mode: "off" },
            { name: "projection", mode: "project", fields: ["items.id", "items.title"] },
            {
              name: "adaptive",
              mode: "adaptive",
              candidates: [{ mode: "project", fields: ["items.id", "items.title"] }],
              minInputTokens: 1,
              minSavingsPercent: 10,
            },
            {
              name: "flaky-projection",
              mode: "project",
              fields: ["items.id", "items.title"],
              maxNestingDepth: 3,
            },
            { name: "no-savings", mode: "html_reader" },
          ],
        }],
      }));

      const stdout = execFileSync(process.execPath, [
        resolve(repoRoot, "scripts/benchmark.mjs"),
        "--responses-live",
        "--cases",
        casesPath,
        "--iterations",
        "3",
        "--config",
        configPath,
      ], { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
      const output = JSON.parse(stdout);
      expect(output.method).toMatch(/live MCP calls/);
      expect(output.measurements).toHaveLength(5);

      const off = output.measurements.find((measurement: { policy: string }) => measurement.policy === "off");
      const projection = output.measurements.find((measurement: { policy: string }) => measurement.policy === "projection");
      expect(off.sampleCount).toBe(3);
      expect(projection.sampleCount).toBe(3);
      expect(projection.optimizedTokens.median).toBeLessThan(off.optimizedTokens.median);
      expect(projection.correctness).toEqual({ passed: 3, checked: 3 });
      expect(projection.upstreamLatencyMs).toHaveProperty("p95");
      expect(projection.optimizationLatencyMs).toHaveProperty("stdDev");
      const flaky = output.measurements.find((measurement: { policy: string }) => measurement.policy === "flaky-projection");
      expect(flaky).toMatchObject({ optimizationFallbacks: 1, optimizationFallbackRate: expect.any(Number) });
      expect(output.recommendations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          case: "fixture-search",
          policy: "projection",
          mode: "project",
          decision: "recommend",
          reason: "correctness_passed_savings_positive_overhead_within_budget",
          sampleCount: 3,
        }),
        expect.objectContaining({
          case: "fixture-search",
          policy: "adaptive",
          mode: "adaptive",
          candidateModes: ["project"],
          selectedModes: ["project"],
          decision: "recommend",
          reason: "correctness_passed_savings_positive_overhead_within_budget",
          sampleCount: 3,
        }),
        expect.objectContaining({
          case: "fixture-search",
          policy: "no-savings",
          decision: "keep_off",
          reason: "no_token_savings",
        }),
        expect.objectContaining({
          case: "fixture-search",
          policy: "flaky-projection",
          decision: "keep_off",
          reason: "optimization_fallback",
          sampleCount: 3,
          optimizationFallbacks: 1,
          medianSavedTokens: expect.any(Number),
        }),
      ]));
      expect(output.recommendations.find((recommendation: { policy: string }) => recommendation.policy === "flaky-projection").medianSavedTokens).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not recommend a policy when the live sample count is too small", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "lazygate-live-bench-small-sample-test-"));
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
          preservePaths: ["$.structuredContent.items[*].id"],
          policies: [
            { name: "off", mode: "off" },
            { name: "projection", mode: "project", fields: ["items.id"] },
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
      expect(output.recommendations).toEqual([
        expect.objectContaining({
          policy: "projection",
          decision: "insufficient_evidence",
          reason: "too_few_samples",
          sampleCount: 2,
          requiredSampleCount: 3,
        }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("measures automatic adaptive policies with a built-in tokenizer", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "lazygate-live-bench-tokenizer-test-"));
    try {
      const serverPath = resolve(repoRoot, "src/__tests__/fixtures/benchmark-response-server.mjs");
      const configPath = resolve(tempDir, "servers.json");
      const casesPath = resolve(tempDir, "cases.json");
      writeFileSync(configPath, JSON.stringify({
        servers: { fixture: { command: process.execPath, args: [serverPath] } },
      }));
      writeFileSync(casesPath, JSON.stringify({
        cases: [{
          name: "fixture-search",
          server: "fixture",
          tool: "search_records",
          readOnly: true,
          preservePaths: ["$.structuredContent.items[*].id"],
          policies: [
            { name: "off", mode: "off" },
            { name: "auto", mode: "adaptive", minInputTokens: 1 },
          ],
        }],
      }));

      const stdout = execFileSync(process.execPath, [
        resolve(repoRoot, "scripts/benchmark.mjs"),
        "--responses-live",
        "--cases",
        casesPath,
        "--iterations",
        "1",
        "--tokenizer",
        "o200k_base",
        "--config",
        configPath,
      ], { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
      const output = JSON.parse(stdout);
      expect(output.tokenizer).toBe("o200k_base");
      const auto = output.measurements.find((m: { policy: string }) => m.policy === "auto");
      expect(auto.tokenEstimate).toMatch(/o200k_base/);
      expect(output.recommendations).toEqual([
        expect.objectContaining({ policy: "auto", candidateModes: "automatic", reason: "too_few_samples" }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects adaptive benchmark policies with an empty candidate list", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "lazygate-live-bench-invalid-adaptive-test-"));
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
          readOnly: true,
          preservePaths: ["$.structuredContent.items[*].id"],
          policies: [
            { name: "off", mode: "off" },
            { name: "adaptive", mode: "adaptive", candidates: [] },
          ],
        }],
      }));

      let failure: any;
      try {
        execFileSync(process.execPath, [
          resolve(repoRoot, "scripts/benchmark.mjs"),
          "--responses-live",
          "--cases",
          casesPath,
          "--config",
          configPath,
        ], { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
      } catch (error) {
        failure = error;
      }
      expect(failure?.status).toBe(1);
      expect(String(failure?.stderr)).toMatch(/adaptive policy.*one to four candidates/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
