// Deterministic checks for the combined experiment (1.md): the refund-evaluation fixtures, the policy
// page, the experiment definition, and the response-optimization fact-preservation gate. Everything
// here is offline; the live model runs are not part of the test suite.

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { ProcessManager } from "../process-manager.js";
import {
  optimizeToolResult,
  parseResponseOptimizationConfig,
  resolveOptimizationPolicy,
} from "../response-optimizer.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = resolve(repoRoot, "scripts/fixtures");
const experimentPath = resolve(fixtureDir, "combined-experiment.json");

type TaskData = {
  EVAL_ORDERS: Array<{ id: string; status: string; category: string; ageDays: number; refundCents: number | null; lines: unknown[] }>;
  EVAL_CURRENT_POLICY: string;
  EVAL_POLICY_VERSIONS: string[];
  POLICY_FACTS: Record<string, { returnWindowDays: number; feeBasisPoints: number; minPurchaseCents: number; exceptionCount: number }>;
  POLICY_RULES: { windowDays: Record<string, number>; excludedCategories: string[] };
  expectedRefundAggregate(): number[];
  expectedPolicyEligible(): number[];
  expectedPolicyFacts(): number[];
  policyEligible(o: unknown): boolean;
};

type Experiment = {
  name: string;
  tasks: string[];
  index: string;
  variants: Record<string, { execution: string; manifest: boolean; responseOptimization: unknown; projection?: boolean }>;
};

let data: TaskData;
let tasks: { TASK_IDS: string[]; TASKS: Record<string, { fields: string | null; expected(): number[] }>; ALL_FIXTURE_SERVERS: Record<string, { file: string }> };
beforeAll(async () => {
  data = (await import(pathToFileURL(resolve(fixtureDir, "task-data.mjs")).href)) as TaskData;
  tasks = (await import(pathToFileURL(resolve(repoRoot, "scripts/lib/tasks.mjs")).href)) as typeof tasks;
});

describe("refund-evaluation fixtures", () => {
  it("has refunded orders whose refund amount only the detail record carries", () => {
    const refunded = data.EVAL_ORDERS.filter((o) => o.status === "refunded");
    expect(refunded.length).toBeGreaterThan(0);
    // Some refunded orders have a null refundCents: a null must be skipped, not summed as zero by accident.
    expect(data.EVAL_ORDERS.some((o) => o.status !== "refunded" && o.refundCents === null)).toBe(true);
  });

  it("makes eligibility depend on the policy: the rule excludes some refunded orders", () => {
    const refunded = data.EVAL_ORDERS.filter((o) => o.status === "refunded");
    const eligible = refunded.filter(data.policyEligible);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.length).toBeLessThan(refunded.length);
  });

  it("computes the expected answers from the records, not constants", () => {
    const agg = data.expectedRefundAggregate();
    const eligible = data.expectedPolicyEligible();
    expect(agg[0]).toBe(data.EVAL_ORDERS.filter((o) => o.status === "refunded").length);
    expect(eligible[0]).toBeLessThanOrEqual(agg[0]!);
    expect(eligible[1]).toBeLessThanOrEqual(agg[1]!);
  });

  it("keeps the expected answers stable across runs (reproducible seed)", () => {
    expect(data.expectedRefundAggregate()).toEqual([24, 30950]);
    // Reference for the current policy with three excluded categories (grocery, electronics, books).
    expect(data.expectedPolicyEligible()).toEqual([6, 8425]);
    expect(data.expectedPolicyFacts()).toEqual([30, 250, 1000, 3]);
  });
});

describe("historical policy trap", () => {
  it("gives the historical version different facts from the current one", () => {
    const current = data.POLICY_FACTS[data.EVAL_CURRENT_POLICY]!;
    const historical = data.POLICY_FACTS["2024-01"]!;
    for (const key of ["returnWindowDays", "feeBasisPoints", "minPurchaseCents", "exceptionCount"] as const) {
      expect(historical[key]).not.toBe(current[key]);
    }
  });

  it("keeps the current policy's exception count equal to its excluded-category list", () => {
    // The page states "N exception categories" and names the excluded ones; both must describe the same set.
    const f = data.POLICY_FACTS[data.EVAL_CURRENT_POLICY]!;
    expect(f.exceptionCount).toBe(data.POLICY_RULES.excludedCategories.length);
  });

  it("lists every policy version the docs server serves", () => {
    expect(data.EVAL_POLICY_VERSIONS).toContain(data.EVAL_CURRENT_POLICY);
    for (const v of data.EVAL_POLICY_VERSIONS) expect(data.POLICY_FACTS[v]).toBeDefined();
  });
});

describe("docs and refunds fixture servers", () => {
  let pm: ProcessManager;
  beforeAll(async () => {
    pm = new ProcessManager({ idleTtlMs: 0 });
    for (const name of ["docs", "refunds"]) {
      await pm.activate(name, {
        description: name,
        keywords: [],
        command: process.execPath,
        args: [resolve(fixtureDir, tasks.ALL_FIXTURE_SERVERS[name]!.file)],
        env: {},
        autoActivate: false,
      });
    }
  });
  afterAll(() => pm.dispose());

  it("serves the current policy page as raw HTML", async () => {
    const r = (await pm.callTool("docs", "get_policy", { version: data.EVAL_CURRENT_POLICY })) as { content: Array<{ text: string }> };
    const html = r.content[0]!.text;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('data-version="' + data.EVAL_CURRENT_POLICY + '"');
  });

  it("states the current facts in the page, so an agent can read them", async () => {
    const html = ((await pm.callTool("docs", "get_policy", { version: data.EVAL_CURRENT_POLICY })) as { content: Array<{ text: string }> }).content[0]!.text;
    const f = data.POLICY_FACTS[data.EVAL_CURRENT_POLICY]!;
    expect(html).toContain(`<td>${f.returnWindowDays}</td>`);
    expect(html).toContain(`<td>${f.feeBasisPoints}</td>`);
    expect(html).toContain(`<td>${f.minPurchaseCents}</td>`);
    expect(html).toContain(`There are ${f.exceptionCount} exception categories`);
  });

  it("marks the historical page as superseded and does not state its eligibility rules", async () => {
    const old = ((await pm.callTool("docs", "get_policy", { version: "2024-01" })) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(old).toContain("Historical version");
    expect(old).not.toContain("Category return windows");
    expect(old).not.toContain("Excluded categories");
  });

  it("rejects an unknown policy version", async () => {
    const r = (await pm.callTool("docs", "get_policy", { version: "1999-01" })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it("returns refund records that carry the category, age and refund amount", async () => {
    const r = (await pm.callTool("refunds", "get_refund_order", { id: "RFD-001" })) as { content: Array<{ text: string }> };
    const o = JSON.parse(r.content[0]!.text);
    expect(o).toEqual(expect.objectContaining({ id: "RFD-001", category: expect.any(String), ageDays: expect.any(Number) }));
  });
});

describe("fact preservation under html_markdown (1.md gate)", () => {
  it("keeps every fact an agent needs in the converted current policy page", async () => {
    const pm = new ProcessManager({ idleTtlMs: 0 });
    try {
      await pm.activate("docs", {
        description: "docs",
        keywords: [],
        command: process.execPath,
        args: [resolve(fixtureDir, tasks.ALL_FIXTURE_SERVERS["docs"]!.file)],
        env: {},
        autoActivate: false,
      });
      const original = (await pm.callTool("docs", "get_policy", { version: data.EVAL_CURRENT_POLICY })) as {
        content: Array<{ type: string; text: string }>;
      };
      const config = parseResponseOptimizationConfig({
        responseOptimization: {
          enabled: true,
          defaultMode: "off",
          tokenizer: "o200k_base",
          includeMetadata: false,
          tools: { "docs.get_policy": { mode: "html_markdown" } },
        },
      }).config;
      const context = { serverName: "docs", toolName: "get_policy", source: "call_tool" as const };
      const policy = resolveOptimizationPolicy(config, context);
      expect(policy.mode).toBe("html_markdown");
      const converted = await optimizeToolResult(original as never, policy, context);
      const md = JSON.stringify(converted);
      const f = data.POLICY_FACTS[data.EVAL_CURRENT_POLICY]!;
      // Every value the task answers from must survive the conversion.
      expect(md).toContain(`${f.returnWindowDays} days`);
      expect(md).toContain(`${f.feeBasisPoints}`);
      expect(md).toContain(`${f.minPurchaseCents}`);
      expect(md).toContain(`There are ${f.exceptionCount} exception categories`);
      for (const [category, days] of Object.entries(data.POLICY_RULES.windowDays)) {
        expect(md).toContain(category);
        expect(md).toContain(`${days}`);
      }
      for (const excluded of data.POLICY_RULES.excludedCategories) expect(md).toContain(excluded);
    } finally {
      pm.dispose();
    }
  });
});

type Parsed = {
  tasks: string[];
  variants: Array<{ id: string; strategy: string; manifest: boolean; projection: boolean; responseOptimization: unknown }>;
};
type Catalog = {
  TASK_IDS: string[];
  TASKS: Record<string, { fields: string | null; expected(): number[] }>;
  ALL_FIXTURE_SERVERS: Record<string, { file: string }>;
  buildInstruction(task: string, strategy: string, opts?: { cold?: boolean }): string;
  parseExperiment(raw: unknown): Parsed;
};

describe("experiment variant parity (1.md)", () => {
  let catalog: Catalog;
  beforeAll(async () => {
    catalog = (await import(pathToFileURL(resolve(repoRoot, "scripts/lib/tasks.mjs")).href)) as Catalog;
  });

  it("gives D and E the same instruction text: only the optimization differs", () => {
    // The parsed experiment maps D and E onto the same execution strategy. Their model instruction is built
    // from that strategy alone, so it must be identical; a difference would mean the comparison is confounded.
    const parsed = catalog.parseExperiment(JSON.parse(readFileSync(experimentPath, "utf8")));
    const d = parsed.variants.find((v) => v.id === "D")!;
    const e = parsed.variants.find((v) => v.id === "E")!;
    expect(d.strategy).toBe(e.strategy);
    for (const task of parsed.tasks) {
      for (const cold of [false, true]) {
        expect(catalog.buildInstruction(task, d.strategy, { cold })).toBe(catalog.buildInstruction(task, e.strategy, { cold }));
      }
    }
  });

  it("gives B and C the same instruction text: the manifest is the only difference", () => {
    const parsed = catalog.parseExperiment(JSON.parse(readFileSync(experimentPath, "utf8")));
    const b = parsed.variants.find((v) => v.id === "B")!;
    const c = parsed.variants.find((v) => v.id === "C")!;
    expect(b.strategy).toBe(c.strategy);
    expect(c.manifest).toBe(true);
    expect(b.manifest).toBe(false);
  });

  it("never asks a call_tool variant without projection for field-level arguments", () => {
    const parsed = catalog.parseExperiment(JSON.parse(readFileSync(experimentPath, "utf8")));
    for (const v of parsed.variants) {
      if (v.strategy !== "call-tool" || v.projection) continue;
      for (const task of parsed.tasks) expect(catalog.buildInstruction(task, "call-tool")).not.toContain("fields=");
    }
  });
});

describe("startup gates (1.md): manifest and discovery start no upstream servers", () => {
  it("builds the manifest from a warm index without starting any fixture server", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildManifest } = await import("../manifest.js");
    const { ToolIndex } = await import("../tool-index.js");

    const dir = mkdtempSync(join(tmpdir(), "lazygate-startup-gate-"));
    try {
      const startLog = join(dir, "starts.log");
      const cfgFor = (name: string, file: string) => ({
        description: name,
        keywords: [],
        command: process.execPath,
        args: [resolve(fixtureDir, file)],
        env: { FIXTURE_START_LOG: startLog },
        inheritEnv: false,
        toolChain: true,
        manifest: true,
        autoActivate: false,
      });
      const servers: Record<string, ReturnType<typeof cfgFor>> = {
        docs: cfgFor("docs", "docs-server.mjs"),
        refunds: cfgFor("refunds", "refunds-server.mjs"),
      };
      // A warm index: signatures recorded earlier, no process started for this build.
      const index = new ToolIndex(join(dir, "tool-index.json"));
      const tools = {
        docs: [
          { name: "list_policies", description: "List policy versions", signature: "list_policies()" },
          { name: "get_policy", description: "Fetch a policy page", signature: "get_policy({version})" },
        ],
        refunds: [
          { name: "list_refund_orders", description: "List refund orders", signature: "list_refund_orders({status?})" },
          { name: "get_refund_order", description: "Fetch a refund order", signature: "get_refund_order({id})" },
        ],
      };
      for (const [name, cfg] of Object.entries(servers)) index.record(name, cfg as never, tools[name as "docs"] as never);

      const manifest = buildManifest(servers as never, index);
      expect(manifest).toBeDefined();
      // The manifest names the servers and their signatures...
      expect(manifest).toContain("get_policy({version})");
      expect(manifest).toContain("get_refund_order({id})");
      // ...stays within the 1,600-character cap the plan requires...
      expect(manifest!.length).toBeLessThanOrEqual(1600);
      // ...and started no fixture process: the start log is never written.
      expect(existsSync(startLog)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("combined experiment definition", () => {
  const experiment = JSON.parse(readFileSync(experimentPath, "utf8")) as Experiment;

  it("defines the seven variants A–G from 1.md", () => {
    expect(Object.keys(experiment.variants).sort()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("names only tasks that exist in the catalog", () => {
    for (const id of experiment.tasks) expect(tasks.TASK_IDS).toContain(id);
  });

  it("varies only execution, manifest and optimization between variants", () => {
    // A is the direct reference; the lazygate variants use a known execution mode.
    expect(experiment.variants.A!.execution).toBe("direct");
    for (const id of ["B", "C", "D", "E", "F", "G"]) {
      expect(["call_tool", "run_chain"]).toContain(experiment.variants[id]!.execution);
    }
  });

  it("gives chain variants D and E identical execution, so only optimization differs", () => {
    const d = experiment.variants.D!;
    const e = experiment.variants.E!;
    expect(e.execution).toBe(d.execution);
    expect(e.manifest).toBe(d.manifest);
    expect(d.responseOptimization).toBeNull();
    expect(e.responseOptimization).not.toBeNull();
  });

  it("keeps the manifest off for B and on for C through G", () => {
    expect(experiment.variants.B!.manifest).toBe(false);
    for (const id of ["C", "D", "E", "F", "G"]) expect(experiment.variants[id]!.manifest).toBe(true);
  });

  it("uses a valid optimization policy wherever one is set", () => {
    for (const [id, variant] of Object.entries(experiment.variants)) {
      if (!variant.responseOptimization) continue;
      const { errors } = parseResponseOptimizationConfig({ responseOptimization: variant.responseOptimization });
      expect({ id, errors }).toEqual({ id, errors: [] });
    }
  });

  it("defaults automatic transforms off in G, so projection is not credited to compression", () => {
    const g = experiment.variants.G!;
    expect(g.projection).toBe(true);
    expect(g.responseOptimization).toBeNull();
  });
});
