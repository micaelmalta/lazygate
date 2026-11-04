import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const suiteUrl = pathToFileURL(resolve(repoRoot, "scripts/lib/suite.mjs")).href;

type Suite = {
  baselineOf(report: any): any;
  compareToBaseline(report: any, baseline: any, opts?: { tolerance?: number }): string[];
  toMarkdown(report: any): string;
  percentile(values: number[], p: number): number;
  distribution(values: number[]): { p50: number; p95: number | null; min: number; max: number; mean: number; mad: number; samples: number };
  WORKLOAD_IDS: string[];
  STRATEGIES: string[];
};

describe("benchmark suite", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), "lazygate-suite-test-"));
  });
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  function run(extra: string[]): { stdout: string; status: number; stderr: string } {
    try {
      const stdout = execFileSync(
        process.execPath,
        [resolve(repoRoot, "scripts/benchmark.mjs"), "--suite", "--out-dir", tempDir, "--tokenizer", "chars_per_4", ...extra],
        { cwd: repoRoot, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }
      );
      return { stdout, status: 0, stderr: "" };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
    }
  }

  it("runs every workload through every strategy, answers correctly, and writes JSON and Markdown", () => {
    const { stdout, status, stderr } = run(["--json", "--catalog-sizes", "20,100", "--rounds", "1", "--no-lookup-comparison"]);
    expect({ status, stderr: stderr.split("\n").filter((l) => l.startsWith("✗")) }).toEqual({ status: 0, stderr: [] });
    const report = JSON.parse(stdout);

    expect(report.schemaVersion).toBe(2);
    expect(report.results).toHaveLength(5 * 6 * 2);
    // The only wrong answer is the capped direct client losing the tail of a huge result.
    const wrong = report.results
      .filter((r: { correct: boolean }) => !r.correct)
      .map((r: any) => `${r.workload}/${r.strategy}@${r.catalogTools}`);
    expect(wrong).toEqual(["large_json/direct_capped@20", "large_json/direct_capped@100"]);

    const pick = (workload: string, strategy: string, size: number) =>
      report.results.find((r: any) => r.workload === workload && r.strategy === strategy && r.catalogTools === size);

    // Direct MCP pays for the whole catalog on every turn; lazygate does not.
    expect(pick("single_lookup", "direct", 100).tokens.schema).toBeGreaterThan(5 * pick("single_lookup", "call_tool", 100).tokens.schema);
    expect(pick("single_lookup", "call_tool", 100).tokens.schema).toBe(pick("single_lookup", "call_tool", 20).tokens.schema);
    // Chaining collapses the dependent workload into one script turn; the dumb path needs two call turns.
    expect(pick("dependent_chain", "run_chain", 100).turns).toBeLessThan(pick("dependent_chain", "call_tool", 100).turns);
    expect(pick("dependent_chain", "run_chain", 100).tokens.input).toBeLessThan(pick("dependent_chain", "call_tool", 100).tokens.input);
    // Compression pays on the large payload and keeps the answer.
    expect(pick("large_json", "call_tool_opt", 100).tokens.responses).toBeLessThan(pick("large_json", "call_tool", 100).tokens.responses / 3);
    expect(pick("html_docs", "call_tool_opt", 100).tokens.responses).toBeLessThan(pick("html_docs", "call_tool", 100).tokens.responses);
    // Every lazygate run found the server through discover_tools.
    expect(pick("single_lookup", "call_tool", 100).discoveryRank).toBeGreaterThanOrEqual(1);
    // Latency distributions are recorded; a single round is far too few for a p95.
    expect(pick("parallel_calls", "call_tool", 20).latencyMs).toEqual(
      expect.objectContaining({ samples: 1, p50: expect.any(Number), p95: null, max: expect.any(Number), mad: 0 })
    );
    expect(pick("parallel_calls", "call_tool", 20).modeledMs).toBeGreaterThan(pick("parallel_calls", "call_tool", 20).latencyMs.p50);

    // call_tool_opt never costs meaningfully more than call_tool on tiny results (P2-b).
    for (const workload of ["single_lookup", "parallel_calls"]) {
      expect(pick(workload, "call_tool_opt", 100).tokens.input).toBeLessThanOrEqual(pick(workload, "call_tool", 100).tokens.input + 16);
    }

    // pinned: no lookup turns for the pinned tools, but a bigger schema than the bare meta-tools.
    expect(pick("single_lookup", "pinned", 100).turns).toBe(2);
    expect(pick("single_lookup", "pinned", 100).tokens.schema).toBeGreaterThan(pick("single_lookup", "call_tool", 100).tokens.schema);
    expect(pick("single_lookup", "pinned", 100).tokens.schema).toBe(pick("single_lookup", "pinned", 20).tokens.schema);
    expect(pick("large_json", "pinned", 100).turns).toBe(pick("large_json", "call_tool", 100).turns); // not pinned: cold lookups

    // Prompt-caching model: the cached prefix makes the schema-heavy strategy cheaper than its raw input.
    for (const r of report.results) {
      if (r.turns > 1) expect(r.tokens.effectiveInput).toBeLessThan(r.tokens.input);
    }
    expect(pick("single_lookup", "direct", 100).tokens.effectiveInput).toBeGreaterThan(pick("single_lookup", "call_tool", 100).tokens.effectiveInput);

    // Output cap: only the capped client loses the large result.
    expect(pick("large_json", "direct", 100).correct).toBe(true);
    expect(pick("large_json", "direct_capped", 100).correct).toBe(false);
    expect(pick("large_json", "direct_capped", 100).tokens.responses).toBeLessThan(26_000);
    expect(pick("single_lookup", "direct_capped", 100).tokens.input).toBe(pick("single_lookup", "direct", 100).tokens.input);

    // Turn-time sweep and the split between measured tool time and assumed model time.
    expect(Object.keys(pick("single_lookup", "call_tool", 100).modeledMsSweep)).toEqual(["500", "1500", "3000"]);
    expect(pick("single_lookup", "call_tool", 100).modelMs).toBeGreaterThan(0);
    expect(pick("single_lookup", "call_tool", 100).expected.turns).toBeGreaterThanOrEqual(pick("single_lookup", "call_tool", 100).turns);
    expect(pick("single_lookup", "direct", 100).expected.turns).toBe(pick("single_lookup", "direct", 100).turns);

    // Discovery: tuned and held-out sets, two rankers, two catalog sizes each.
    expect(report.discovery.map((d: any) => `${d.set}/${d.strategy}`)).toEqual([
      "tuned/lexical", "tuned/bm25", "tuned/lexical", "tuned/bm25",
      "heldout/lexical", "heldout/bm25", "heldout/lexical", "heldout/bm25",
    ]);
    const held = report.discovery.find((d: any) => d.set === "heldout" && d.strategy === "bm25");
    expect(held.queries).toBeGreaterThanOrEqual(35);
    expect(held.recallAt3).toBeGreaterThan(0.6);
    expect(report.truncation.every((t: any) => t.withinBudget)).toBe(true);

    expect(existsSync(resolve(tempDir, "suite.json"))).toBe(true);
    const markdown = readFileSync(resolve(tempDir, "suite.md"), "utf8");
    expect(markdown).toContain("## Catalog of 100 tools");
    expect(markdown).toContain("## Tool discovery");
    expect(markdown).toContain("Optimizer latency");
    expect(markdown).toContain("Turn-time sensitivity");
    expect(markdown).toContain("held-out");
    expect(markdown).toContain("Effective input");
    // Few rounds: the table says "max" rather than calling a p95.
    expect(markdown).not.toMatch(/·\s*p95/);
  }, 120_000);

  it("cuts a turn with merged discovery and another with known tools, and reports them side by side", () => {
    const { stdout, status } = run([
      "--json", "--catalog-sizes", "20,100", "--rounds", "1",
      "--workloads", "single_lookup,dependent_chain", "--strategies", "call_tool,call_tool_opt,run_chain",
    ]);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    const row = (workload: string, strategy: string, lookup: string, size = 100) =>
      report.lookupModes.find((r: any) => r.workload === workload && r.strategy === strategy && r.lookup === lookup && r.catalogTools === size);
    for (const strategy of ["call_tool", "call_tool_opt", "run_chain"]) {
      for (const workload of ["single_lookup", "dependent_chain"]) {
        const [cold, merged, known] = ["cold", "merged", "known"].map((m) => row(workload, strategy, m));
        expect(cold.correct && merged.correct && known.correct).toBe(true);
        expect(merged.turns).toBe(cold.turns - 1);
        expect(known.turns).toBe(merged.turns - 1);
        expect(merged.tokens.input).toBeLessThan(cold.tokens.input);
        expect(known.tokens.input).toBeLessThan(merged.tokens.input);
        expect(merged.modeledMs).toBeLessThan(cold.modeledMs);
      }
    }
    // The main table follows --merged-discovery.
    const mergedRun = JSON.parse(
      run(["--json", "--merged-discovery", "--catalog-sizes", "20", "--rounds", "1", "--workloads", "single_lookup", "--strategies", "call_tool", "--no-lookup-comparison"]).stdout
    );
    expect(mergedRun.config.lookup).toBe("merged");
    expect(mergedRun.results[0].turns).toBe(3);
    expect(mergedRun.results[0].discoveryTurns).toBe(1);
    const markdown = readFileSync(resolve(tempDir, "suite.md"), "utf8");
    expect(markdown).not.toContain("Cold start"); // --no-lookup-comparison
  }, 120_000);

  it("models caching, a direct output cap and real-catalog schema sizes from the command line", () => {
    const base = ["--json", "--catalog-sizes", "100", "--rounds", "1", "--workloads", "single_lookup,large_json", "--no-lookup-comparison"];
    const strategies = ["--strategies", "direct,direct_capped,call_tool"];
    const pick = (report: any, workload: string, strategy: string) =>
      report.results.find((r: any) => r.workload === workload && r.strategy === strategy);
    const plain = JSON.parse(run([...base, ...strategies]).stdout);
    const noCache = JSON.parse(run([...base, ...strategies, "--cache-read-discount", "1", "--cache-write-premium", "1"]).stdout);
    // With no discount and no premium the effective input is exactly the raw input.
    expect(pick(noCache, "single_lookup", "direct").tokens.effectiveInput).toBe(pick(noCache, "single_lookup", "direct").tokens.input);
    expect(pick(plain, "single_lookup", "direct").tokens.effectiveInput).toBeLessThan(pick(plain, "single_lookup", "direct").tokens.input);
    expect(plain.config.cacheReadDiscount).toBe(0.1);

    const uncapped = JSON.parse(run([...base, "--direct-output-cap", "0"]).stdout);
    expect(uncapped.results.map((r: any) => r.strategy)).not.toContain("direct_capped");
    const tightCap = JSON.parse(run([...base, ...strategies, "--direct-output-cap", "2000"]).stdout);
    expect(pick(tightCap, "single_lookup", "direct_capped").correct).toBe(true); // small result: untouched
    expect(pick(tightCap, "large_json", "direct_capped").tokens.responses).toBeLessThan(2_100);

    // Filler schemas sized from a target: the direct catalog grows, the lazygate schema does not.
    const sized = JSON.parse(run([...base, ...strategies, "--schema-tokens-per-tool", "300"]).stdout);
    expect(pick(sized, "single_lookup", "direct").tokens.schema).toBeGreaterThan(2.5 * pick(plain, "single_lookup", "direct").tokens.schema);
    expect(pick(sized, "single_lookup", "call_tool").tokens.schema).toBe(pick(plain, "single_lookup", "call_tool").tokens.schema);
    expect(sized.catalogs[0].averageTokensPerTool).toBeGreaterThan(250);

    // ...or from a tools/list dump of a real catalog.
    const dump = resolve(tempDir, "tools-dump.json");
    writeFileSync(dump, JSON.stringify({
      tools: Array.from({ length: 5 }, (_, i) => ({
        name: `real_tool_${i}`,
        description: "x ".repeat(120),
        inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`p${k}`, { type: "string", description: "y ".repeat(15) }])) },
      })),
    }));
    const fromCatalog = JSON.parse(run([...base, ...strategies, "--catalog-from", dump]).stdout);
    expect(fromCatalog.config.catalogFrom).toMatchObject({ tools: 5 });
    expect(fromCatalog.config.schemaTokensPerTool).toBe(fromCatalog.config.catalogFrom.averageSchemaTokens);
    expect(pick(fromCatalog, "single_lookup", "direct").tokens.schema).toBeGreaterThan(pick(plain, "single_lookup", "direct").tokens.schema);
  }, 120_000);

  it("rejects invalid option values", () => {
    const bad = run(["--cache-read-discount", "2", "--direct-output-cap", "-1", "--schema-tokens-per-tool", "3", "--known-tools", "--merged-discovery"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--cache-read-discount must be between 0 and 1");
    expect(bad.stderr).toContain("--direct-output-cap must be");
    expect(bad.stderr).toContain("--schema-tokens-per-tool must be");
    expect(bad.stderr).toContain("mutually exclusive");
    const missing = run(["--catalog-from", resolve(tempDir, "nope.json"), "--workloads", "single_lookup", "--catalog-sizes", "20", "--rounds", "1"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--catalog-from: file not found");
  });

  it("rejects unknown workloads and bad sizes", () => {
    const bad = run(["--workloads", "nope", "--catalog-sizes", "3"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("unknown workload nope");
    expect(bad.stderr).toContain("--catalog-sizes must be integers");
  });

  describe("baseline comparison", () => {
    const makeReport = (overrides: Partial<{ correct: boolean; turns: number; input: number; recallAt1: number; chars: number }> = {}) => ({
      schemaVersion: 1,
      config: { catalogSizes: [20], tokenizer: "chars_per_4", seed: 1 },
      results: [
        {
          workload: "single_lookup",
          strategy: "call_tool",
          catalogTools: 20,
          correct: overrides.correct ?? true,
          turns: overrides.turns ?? 4,
          tokens: { schema: 100, context: 500, input: overrides.input ?? 1000 },
        },
      ],
      discovery: [{ servers: 41, strategy: "bm25", recallAt1: overrides.recallAt1 ?? 0.9, recallAt3: 0.95, wrongTopRate: 0.08 }],
      truncation: [
        { case: "text", budgetTokens: 500, withinBudget: true, tokenizerCalls: 10, tokenizedChars: overrides.chars ?? 1000 },
      ],
    });

    it("passes an identical report and tolerates small drift", async () => {
      const suite = (await import(suiteUrl)) as Suite;
      const baseline = suite.baselineOf(makeReport());
      expect(suite.compareToBaseline(makeReport(), baseline)).toEqual([]);
      expect(suite.compareToBaseline(makeReport({ input: 1040 }), baseline)).toEqual([]);
    });

    it("flags lost correctness, extra turns, token growth, worse discovery and more tokenizing", async () => {
      const suite = (await import(suiteUrl)) as Suite;
      const baseline = suite.baselineOf(makeReport());
      const problems = suite.compareToBaseline(
        makeReport({ correct: false, turns: 5, input: 1200, recallAt1: 0.8, chars: 2000 }),
        baseline
      );
      expect(problems.join("\n")).toMatch(/no longer answers correctly/);
      expect(problems.join("\n")).toMatch(/turns 4 → 5/);
      expect(problems.join("\n")).toMatch(/input tokens 1000 → 1200/);
      expect(problems.join("\n")).toMatch(/Recall@1/);
      expect(problems.join("\n")).toMatch(/tokenized chars/);
    });

    it("compares the held-out set separately from the tuned set and checks lookup modes", async () => {
      const suite = (await import(suiteUrl)) as Suite;
      const report = (heldoutRecall: number, mergedTurns: number) => ({
        ...makeReport(),
        lookupModes: [
          { workload: "single_lookup", strategy: "call_tool", lookup: "merged", catalogTools: 20, correct: true, turns: mergedTurns, tokens: { input: 900 } },
        ],
        discovery: [
          { set: "tuned", servers: 41, strategy: "bm25", queries: 92, recallAt1: 0.9, recallAt3: 0.95, wrongTopRate: 0.08 },
          { set: "heldout", servers: 38, strategy: "bm25", queries: 40, recallAt1: heldoutRecall, recallAt3: 0.95, wrongTopRate: 0.03 },
        ],
      });
      const baseline = suite.baselineOf(report(0.95, 3));
      expect(baseline.discovery.map((d: any) => d.set)).toEqual(["tuned", "heldout"]);
      expect(suite.compareToBaseline(report(0.95, 3), baseline)).toEqual([]);
      const problems = suite.compareToBaseline(report(0.8, 4), baseline).join("\n");
      expect(problems).toMatch(/discovery\/heldout\/bm25@38 servers: Recall@1 0.95 → 0.8/);
      expect(problems).not.toMatch(/discovery\/tuned/);
      expect(problems).toMatch(/single_lookup\/call_tool\[merged\]@20 \(lookup modes\): turns 3 → 4/);
    });

    it("exits non-zero when a real run regresses against a doctored baseline", () => {
      const first = run(["--json", "--catalog-sizes", "20", "--rounds", "1", "--workloads", "single_lookup", "--strategies", "call_tool"]);
      const report = JSON.parse(first.stdout);
      const baselinePath = resolve(tempDir, "baseline.json");
      const doctored = {
        schemaVersion: 1,
        config: report.config,
        results: report.results.map((r: any) => ({ ...r, tokens: { ...r.tokens, input: Math.floor(r.tokens.input / 2) } })),
        discovery: [],
        truncation: [],
      };
      writeFileSync(baselinePath, JSON.stringify(doctored));
      const second = run(["--catalog-sizes", "20", "--rounds", "1", "--workloads", "single_lookup", "--strategies", "call_tool", "--baseline", baselinePath]);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("regression(s)");
    }, 120_000);
  });

  it("percentiles and distributions are well defined", async () => {
    const suite = (await import(suiteUrl)) as Suite;
    expect(suite.percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(suite.percentile([], 0.95)).toBe(0);
    // Fewer than 20 samples: no p95 (it would just be the maximum); median and MAD describe the spread.
    expect(suite.distribution([1, 2, 3, 4, 100])).toMatchObject({ min: 1, max: 100, p50: 3, p95: null, mean: 22, mad: 1, samples: 5 });
    const many = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(suite.distribution(many)).toMatchObject({ p50: 10, p95: 19, max: 20, samples: 20 });
    expect(suite.WORKLOAD_IDS).toHaveLength(5);
    expect(suite.STRATEGIES).toEqual(["direct", "direct_capped", "call_tool", "call_tool_opt", "run_chain", "pinned"]);
  });
});
