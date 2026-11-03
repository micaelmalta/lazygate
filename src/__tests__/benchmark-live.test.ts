import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("live response benchmark", () => {
  it("runs the repository's JSON and HTML benchmark cases and checks preserved values", () => {
    const fixtureDir = resolve(repoRoot, "src/__tests__/fixtures");
    const casesPath = resolve(fixtureDir, "live-benchmark-cases.json");
    const configPath = resolve(fixtureDir, "live-benchmark-servers.json");
    const cases = JSON.parse(readFileSync(casesPath, "utf8"));
    expect(cases.cases).toHaveLength(3);

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
    expect(output.measurements).toHaveLength(6);

    const projection = output.measurements.find((measurement: { policy: string; case: string }) =>
      measurement.case === "large-json-projection" && measurement.policy === "project-record-fields");
    expect(projection.sampleCount).toBe(2);
    expect(projection.optimizedTokens.median).toBeLessThan(
      output.measurements.find((measurement: { policy: string; case: string }) =>
        measurement.case === "large-json-projection" && measurement.policy === "off").optimizedTokens.median
    );
    expect(projection.correctness).toEqual({ passed: 2, checked: 2 });
    expect(projection.upstreamLatencyMs).toHaveProperty("p95");
    expect(projection.optimizationLatencyMs).toHaveProperty("stdDev");

    const markdown = output.measurements.find((measurement: { policy: string; case: string }) =>
      measurement.case === "html-documentation-markdown" && measurement.policy === "markdown");
    const reader = output.measurements.find((measurement: { policy: string; case: string }) =>
      measurement.case === "html-reader-mode" && measurement.policy === "reader");
    expect(markdown.correctness).toEqual({ passed: 2, checked: 2 });
    expect(reader.correctness).toEqual({ passed: 2, checked: 2 });
    expect(reader.optimizedTokens.median).toBeGreaterThan(reader.originalTokens.median);
    expect(reader.reductionPercent).toBeLessThan(0);
  });
});
