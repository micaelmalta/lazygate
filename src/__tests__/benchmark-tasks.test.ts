// The `benchmark --tasks` catalog: fixture servers, expected answers, instructions, answer checking.
// The live runs need a logged-in claude CLI; everything here is deterministic and offline.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { ProcessManager } from "../process-manager.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(repoRoot, "scripts/benchmark.mjs");
const tasksUrl = pathToFileURL(resolve(repoRoot, "scripts/lib/tasks.mjs")).href;
const taskDataUrl = pathToFileURL(resolve(repoRoot, "scripts/fixtures/task-data.mjs")).href;
let data: { EVAL_CURRENT_POLICY: string };

type Tasks = {
  TASKS: Record<string, { servers: string[]; expected(): number[]; title: string; fields: string | null }>;
  TASK_IDS: string[];
  STRATEGY_IDS: string[];
  FIXTURE_SERVERS: Record<string, { file: string; tools: string }>;
  ALL_FIXTURE_SERVERS: Record<string, { file: string; tools: string }>;
  FIXTURE_DIR: string;
  buildInstruction(task: string, strategy: string, opts?: { cold?: boolean }): string;
  taskPrompt(task: string, opts?: { cold?: boolean }): string;
  answerMatches(answer: string, expected: number[]): boolean;
  answerSummary(answer: string, count: number): string;
};

let tasks: Tasks;
let home: string;
beforeAll(async () => {
  tasks = (await import(tasksUrl)) as Tasks;
  data = (await import(taskDataUrl)) as { EVAL_CURRENT_POLICY: string };
  home = mkdtempSync(join(tmpdir(), "lazygate-tasks-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const textOf = (result: { content?: Array<{ type: string; text?: string }> }): string => result.content?.[0]?.text ?? "";

/**
 * Reads the facts an agent needs out of the current policy page: the labelled parameter rows, the
 * per-category window table and the excluded-categories sentence. Plain regexes over the markup, the
 * way an agent reads the page, so it checks what the page states rather than the fixture constants.
 */
function parsePolicyPage(html: string) {
  const cell = (label: string) => {
    const m = new RegExp(`<tr><td>${label}[^<]*</td><td>(\\d+)</td></tr>`).exec(html);
    if (!m) throw new Error(`policy page has no "${label}" row`);
    return Number(m[1]);
  };
  const windows: Record<string, number> = {};
  const section = /Return window by category[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
  for (const m of section.matchAll(/<tr><td>([a-z]+)<\/td><td>(\d+)<\/td><\/tr>/g)) windows[m[1]!] = Number(m[2]);
  const excludedMatch = /Refunds are not accepted for these categories: ([^.]+)\./.exec(html);
  const excluded = excludedMatch ? excludedMatch[1]!.split(",").map((s) => s.trim()) : [];
  const exceptionCount = (html.match(/<li>Exception \d+:/g) ?? []).length;
  return {
    returnWindowDays: cell("Return window"),
    feeBasisPoints: cell("Restocking fee"),
    minPurchaseCents: cell("Minimum purchase"),
    exceptionCount,
    windows,
    excluded,
  };
}

describe("task catalog", () => {
  it("covers several tasks and servers, including one that needs two servers", () => {
    expect(tasks.TASK_IDS.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(tasks.FIXTURE_SERVERS).length).toBeGreaterThanOrEqual(3);
    expect(tasks.TASK_IDS.some((id) => tasks.TASKS[id]!.servers.length > 1)).toBe(true);
    for (const id of tasks.TASK_IDS) {
      for (const server of tasks.TASKS[id]!.servers) expect(tasks.ALL_FIXTURE_SERVERS[server]).toBeDefined();
      expect(tasks.TASKS[id]!.expected().every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    }
  });

  it("gives every strategy an instruction for every task, with and without hints", () => {
    for (const id of tasks.TASK_IDS) {
      for (const strategy of tasks.STRATEGY_IDS) {
        const known = tasks.buildInstruction(id, strategy);
        const cold = tasks.buildInstruction(id, strategy, { cold: true });
        expect(known).toContain("Your entire final message must be exactly");
        expect(cold).toContain("Your entire final message must be exactly");
        if (strategy !== "direct") {
          // Same neutral words in every cold variant: no hint to call discover_tools first.
          expect(cold).toContain("do not know which upstream servers or tools exist");
          expect(cold).not.toContain("discover_tools");
          for (const server of tasks.TASKS[id]!.servers) {
            expect(known).toContain(`"${server}"`);
            expect(cold).not.toContain(`"${server}"`);
          }
        }
      }
      expect(tasks.taskPrompt(id)).not.toBe(tasks.taskPrompt(id, { cold: true }));
    }
  });

  it("only call_tool+opt asks for fields, and only where a task has records to project", () => {
    for (const id of tasks.TASK_IDS) {
      const projectable = tasks.TASKS[id]!.fields !== null;
      const optimized = tasks.buildInstruction(id, "call-tool-optimized");
      if (projectable) expect(optimized).toContain("fields=");
      else expect(optimized).not.toContain("fields=");
      expect(tasks.buildInstruction(id, "call-tool")).not.toContain("fields=");
      expect(tasks.buildInstruction(id, "run-chain")).toContain("run_chain");
    }
  });
});

describe("answer checking", () => {
  it("accepts exactly the expected integers on the final line", () => {
    expect(tasks.answerMatches("8 60000", [8, 60000])).toBe(true);
    expect(tasks.answerMatches("  8 60000\n", [8, 60000])).toBe(true);
    expect(tasks.answerMatches("Here you go\n8 13250", [8, 13250])).toBe(true);
  });

  it("rejects wrong, reordered, extra or merely mentioned numbers", () => {
    expect(tasks.answerMatches("8 59999", [8, 60000])).toBe(false);
    expect(tasks.answerMatches("nothing useful", [8, 60000])).toBe(false);
    expect(tasks.answerMatches("7 13250", [8, 13250])).toBe(false);
    expect(tasks.answerMatches("60000 8", [8, 60000])).toBe(false);
    expect(tasks.answerMatches("8 60000 3", [8, 60000])).toBe(false);
    expect(tasks.answerMatches("8 60,000", [8, 60000])).toBe(false);
    expect(tasks.answerMatches("18 600001", [8, 60000])).toBe(false);
  });

  it("does not credit a wrong answer that mentions the expected values", () => {
    expect(tasks.answerMatches("I calculated 7 tickets, but the expected values were 8 and 60000.", [8, 60000])).toBe(false);
    expect(tasks.answerMatches("8 60000\nActually that was wrong: 7 59000", [8, 60000])).toBe(false);
  });

  it("summarizes the requested line", () => {
    expect(tasks.answerSummary("thinking...\n8 60000", 2)).toBe("8 60000");
    expect(tasks.answerSummary("no numbers here", 2)).toBe("no numbers here");
  });
});

describe("fixture servers answer their tasks", () => {
  let pm: ProcessManager;
  beforeAll(async () => {
    pm = new ProcessManager({ idleTtlMs: 0 });
    for (const [name, fixture] of Object.entries(tasks.ALL_FIXTURE_SERVERS)) {
      await pm.activate(name, {
        description: name,
        keywords: [],
        command: process.execPath,
        args: [resolve(tasks.FIXTURE_DIR, fixture.file)],
        env: { FIXTURE_START_LOG: join(home, "starts.log") },
        autoActivate: false,
      });
    }
  });
  afterAll(() => pm.dispose());

  const call = async (server: string, tool: string, args: Record<string, unknown>) =>
    JSON.parse(textOf((await pm.callTool(server, tool, args)) as never));

  it("lists the tools each fixture advertises", () => {
    for (const [name, fixture] of Object.entries(tasks.FIXTURE_SERVERS)) {
      expect(pm.listActive()).toContain(name);
      for (const tool of fixture.tools.split(", ")) expect(tool.length).toBeGreaterThan(0);
    }
  });

  it("an oracle agent reproduces every expected answer through the servers", async () => {
    const answers: Record<string, number[]> = {};
    {
      const open = (await call("tickets", "list_tickets", { status: "open" })) as Array<{ id: string; assignee: string }>;
      const ana = open.filter((t) => t.assignee === "ana");
      let sum = 0;
      for (const t of ana) sum += (await call("tickets", "get_ticket", { id: t.id })).bodyLength;
      answers.tickets = [ana.length, sum];
    }
    {
      const rows = (await call("orders", "list_orders", { customer: "acme", status: "refunded" })) as Array<{ id: string }>;
      let sum = 0;
      for (const o of rows) sum += (await call("orders", "get_order", { id: o.id })).refundCents;
      answers.orders = [rows.length, sum];
    }
    {
      const rows = (await call("logs", "search_logs", { level: "ERROR", service: "billing" })) as Array<{ id: string }>;
      let sum = 0;
      for (const e of rows) sum += (await call("logs", "get_log_entry", { id: e.id })).stackFrames;
      answers.logs = [rows.length, sum];
    }
    answers.cross = [
      ((await call("tickets", "list_tickets", { status: "open" })) as Array<{ assignee: string }>).filter((t) => t.assignee === "ana").length,
      answers.orders![1]!,
    ];

    // Refund evaluation. The policy is read from the HTML page, not from the fixture constants, so this
    // proves the page carries the facts an agent needs.
    const page = textOf((await pm.callTool("docs", "get_policy", { version: data.EVAL_CURRENT_POLICY }) as never));
    const policy = parsePolicyPage(page);
    const refunded = (await call("refunds", "list_refund_orders", { status: "refunded" })) as Array<{ id: string }>;
    const details: Array<{ category: string; ageDays: number; refundCents: number | null }> = [];
    for (const o of refunded) details.push(await call("refunds", "get_refund_order", { id: o.id }));
    answers.refundAggregate = [
      refunded.length,
      details.reduce((sum, d) => sum + (d.refundCents ?? 0), 0),
    ];
    const eligible = details.filter(
      (d) => d.ageDays <= policy.windows[d.category]! && !policy.excluded.includes(d.category)
    );
    answers.policyEval = [eligible.length, eligible.reduce((sum, d) => sum + (d.refundCents ?? 0), 0)];
    answers.policyEvalCompute = [...answers.policyEval];
    answers.policyFacts = [policy.returnWindowDays, policy.feeBasisPoints, policy.minPurchaseCents, policy.exceptionCount];

    for (const id of tasks.TASK_IDS) expect({ id, answer: answers[id] }).toEqual({ id, answer: tasks.TASKS[id]!.expected() });
  });

  it("keeps list results small and detail records large, so the task is about intermediate data", async () => {
    const list = textOf((await pm.callTool("orders", "list_orders", { customer: "acme" })) as never);
    const one = textOf((await pm.callTool("orders", "get_order", { id: "ORD-001" })) as never);
    expect(one.length).toBeGreaterThan(list.length / 4);
    expect(one.length).toBeGreaterThan(5_000);
    expect(textOf((await pm.callTool("logs", "get_log_entry", { id: "LOG-002" })) as never).length).toBeGreaterThan(2_500);
  });

  it("reports an unknown record as an error", async () => {
    const r = (await pm.callTool("orders", "get_order", { id: "ORD-999" })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it("records each server start in the start log", () => {
    const log = join(home, "starts.log");
    expect(existsSync(log)).toBe(true);
    const names = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
    // The oracle activates every fixture server, including the refund-evaluation ones.
    expect(names.sort()).toEqual(Object.keys(tasks.ALL_FIXTURE_SERVERS).sort());
  });
});

describe("benchmark --tasks (dry run)", () => {
  const run = (args: string[]) =>
    execFileSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("prints every task's instructions by default, and one with --task", () => {
    const all = run(["--tasks", "--estimate"]);
    for (const id of tasks.TASK_IDS) expect(all).toContain(`Task ${id} — `);
    const one = run(["--tasks", "--estimate", "--task", "logs"]);
    expect(one).toContain("Task logs — ");
    expect(one).not.toContain("Task orders — ");
  });

  it("rejects an unknown task and --task outside --tasks", () => {
    const fail = (args: string[]) => {
      try {
        run(args);
      } catch (err) {
        return err as { status?: number; stderr?: string };
      }
      return {} as { status?: number; stderr?: string };
    };
    const unknown = fail(["--tasks", "--estimate", "--task", "nope"]);
    expect(unknown.status).toBe(1);
    expect(String(unknown.stderr)).toMatch(/Unknown --task nope/);
    const outside = fail(["--estimate", "--task", "logs"]);
    expect(outside.status).toBe(1);
    expect(String(outside.stderr)).toMatch(/--task only applies to --tasks/);
  });
});
