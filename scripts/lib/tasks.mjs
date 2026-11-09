// Task catalog for `benchmark --tasks`: the fixture servers, the tasks run against them, the
// expected answers, and the instructions each strategy gets. Pure data and string building (no
// process or file side effects beyond reading the fixture datasets), so it can be unit-tested.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(here, "..", "fixtures");

const data = await import(new URL("../fixtures/task-data.mjs", import.meta.url).href);

/** Fixture MCP servers. All of them are in every run's catalog, so a task also has to pick the right one. */
export const FIXTURE_SERVERS = {
  tickets: {
    file: "tickets-server.mjs",
    tools: "list_tickets, get_ticket",
    description: "Support tickets: list and fetch",
    keywords: ["tickets", "support", "ticket", "open"],
  },
  orders: {
    file: "orders-server.mjs",
    tools: "list_orders, get_order",
    description: "Orders and refunds: list and fetch",
    keywords: ["orders", "order", "refunds", "customers"],
  },
  logs: {
    file: "logs-server.mjs",
    tools: "search_logs, get_log_entry",
    description: "Application logs: search and fetch entries",
    keywords: ["logs", "log", "errors", "stack"],
  },
};

/**
 * Servers for the refund-evaluation tasks. Kept out of FIXTURE_SERVERS so the original four tasks keep
 * their catalog (and published results) unchanged; a run loads these only when its task needs them.
 */
export const EVAL_FIXTURE_SERVERS = {
  refunds: {
    file: "refunds-server.mjs",
    tools: "list_refund_orders, get_refund_order",
    description: "Refund-evaluation orders: list and fetch with category, age and refund amount",
    keywords: ["refunds", "refund", "returns", "orders", "customers"],
  },
  docs: {
    file: "docs-server.mjs",
    tools: "list_policies, get_policy",
    description: "Refund policy documentation: versioned policy pages",
    keywords: ["policy", "documentation", "docs", "returns"],
  },
};

/** Every fixture server a task can use, by name. */
export const ALL_FIXTURE_SERVERS = { ...FIXTURE_SERVERS, ...EVAL_FIXTURE_SERVERS };

export const ANSWER_RULE = (format) =>
  `Your entire final message must be exactly: ${format} — integers separated by single spaces, nothing else.`;

/** Strategy ids in the order they run and print. */
export const STRATEGY_IDS = ["direct", "call-tool", "call-tool-optimized", "run-chain"];

/**
 * Each task names the servers it needs, how it is phrased with and without hints, and the exact
 * tool sequence for each strategy. `expected()` is computed from the fixture data.
 */
export const TASKS = {
  tickets: {
    title: "ana's open tickets: count and total bodyLength",
    servers: ["tickets"],
    format: "<count> <sum>",
    prompt:
      "Using the tickets server, count the open tickets assigned to ana and sum each ticket's " +
      "bodyLength field (from get_ticket). Answer with exactly two numbers: the count, then the sum.",
    coldPrompt:
      "Count the open support tickets assigned to ana and sum each ticket's bodyLength field " +
      "(the per-ticket record has it). Answer with exactly two numbers: the count, then the sum.",
    expected: data.expectedTickets,
    bulk: "There are several matching tickets; get_ticket bodies are large — still fetch each one.",
    coldBulk:
      "Ticket bodies are large — still fetch each ticket you need, and add the numeric bodyLength fields (do NOT count characters in body).",
    fields: '["id","bodyLength"]',
    direct: [
      'list_tickets with status "open" — the list includes assignee.',
      'For each open ticket whose assignee is "ana", call get_ticket once.',
      "Add the numeric bodyLength fields from those results (do NOT count characters in body).",
    ],
    call: (call) => [
      `${call("tickets", "list_tickets", '{status:"open"}')} — list includes assignee.`,
      `For each open ticket whose assignee is "ana", ${call("tickets", "get_ticket", "{id}")} once.`,
      "Add the numeric bodyLength fields from those results (do NOT count characters in body).",
    ],
    callFields: (call, fields) => [
      `${call("tickets", "list_tickets", '{status:"open"}')} — list includes assignee.`,
      `For each open ticket whose assignee is "ana", ${call("tickets", "get_ticket", "{id}", fields)} once.`,
      "Add the numeric bodyLength fields from those results (do NOT count characters in body).",
    ],
    chain:
      'await servers.tickets.list_tickets({status:"open"}), filter assignee==="ana", ' +
      'await servers.tickets.get_ticket({id}) for each (use Promise.all if you want), ' +
      "sum bodyLength (or body.length), return {count, total}.",
  },
  orders: {
    title: "acme's refunded orders: count and total refundCents",
    servers: ["orders"],
    format: "<count> <sum>",
    prompt:
      "Using the orders server, count acme's refunded orders and sum each order's refundCents " +
      "field (from get_order). Answer with exactly two numbers: the count, then the sum.",
    coldPrompt:
      "Count the refunded orders for the customer acme and sum each order's refundCents field " +
      "(the per-order record has it). Answer with exactly two numbers: the count, then the sum.",
    expected: data.expectedOrders,
    bulk: "There are several matching orders; get_order records carry ~90 line items each — still fetch each one.",
    coldBulk:
      "Order records are large — still fetch each order you need, and add the numeric refundCents fields (do NOT estimate them).",
    fields: '["id","refundCents"]',
    direct: [
      'list_orders with customer "acme" and status "refunded".',
      "Call get_order once for each order in that list.",
      "Add the numeric refundCents fields from those results.",
    ],
    call: (call) => [
      `${call("orders", "list_orders", '{customer:"acme",status:"refunded"}')}.`,
      `For each order in the list, ${call("orders", "get_order", "{id}")} once.`,
      "Add the numeric refundCents fields from those results.",
    ],
    callFields: (call, fields) => [
      `${call("orders", "list_orders", '{customer:"acme",status:"refunded"}')}.`,
      `For each order in the list, ${call("orders", "get_order", "{id}", fields)} once.`,
      "Add the numeric refundCents fields from those results.",
    ],
    chain:
      'await servers.orders.list_orders({customer:"acme",status:"refunded"}), ' +
      "await servers.orders.get_order({id}) for each (use Promise.all if you want), " +
      "sum refundCents, return {count, total}.",
  },
  logs: {
    title: "billing ERROR logs: count and total stackFrames",
    servers: ["logs"],
    format: "<count> <sum>",
    prompt:
      "Using the logs server, count the ERROR log entries from the billing service and sum each " +
      "entry's stackFrames field (from get_log_entry). Answer with exactly two numbers: the count, then the sum.",
    coldPrompt:
      "Count the ERROR-level application log entries from the billing service and sum each entry's " +
      "stackFrames field (the per-entry record has it). Answer with exactly two numbers: the count, then the sum.",
    expected: data.expectedLogs,
    bulk: "There are several matching entries; get_log_entry records carry full stack traces — still fetch each one.",
    coldBulk:
      "Log entries carry long stack traces — still fetch each entry you need, and add the numeric stackFrames fields (do NOT count lines).",
    fields: '["id","stackFrames"]',
    direct: [
      'search_logs with level "ERROR" and service "billing".',
      "Call get_log_entry once for each entry in that list.",
      "Add the numeric stackFrames fields from those results (do NOT count stack lines).",
    ],
    call: (call) => [
      `${call("logs", "search_logs", '{level:"ERROR",service:"billing"}')}.`,
      `For each entry in the list, ${call("logs", "get_log_entry", "{id}")} once.`,
      "Add the numeric stackFrames fields from those results (do NOT count stack lines).",
    ],
    callFields: (call, fields) => [
      `${call("logs", "search_logs", '{level:"ERROR",service:"billing"}')}.`,
      `For each entry in the list, ${call("logs", "get_log_entry", "{id}", fields)} once.`,
      "Add the numeric stackFrames fields from those results (do NOT count stack lines).",
    ],
    chain:
      'await servers.logs.search_logs({level:"ERROR",service:"billing"}), ' +
      "await servers.logs.get_log_entry({id}) for each (use Promise.all if you want), " +
      "sum stackFrames, return {count, total}.",
  },
  cross: {
    title: "two servers: ana's open ticket count and acme's total refundCents",
    servers: ["tickets", "orders"],
    format: "<tickets> <refund>",
    prompt:
      "Using the tickets and orders servers, answer two things: (1) how many open tickets are assigned to ana, " +
      "and (2) the sum of refundCents (from get_order) over acme's refunded orders. " +
      "Answer with exactly two numbers: the ticket count, then the refund sum.",
    coldPrompt:
      "Answer two things: (1) how many open support tickets are assigned to ana, and (2) the sum of the " +
      "refundCents field over the refunded orders of the customer acme (the per-order record has it). " +
      "Answer with exactly two numbers: the ticket count, then the refund sum.",
    expected: data.expectedCross,
    bulk: "Order records carry ~90 line items each — still fetch each acme refunded order.",
    coldBulk:
      "Order records are large — still fetch each order you need, and add the numeric refundCents fields (do NOT estimate them).",
    fields: '["id","refundCents"]',
    direct: [
      'list_tickets with status "open" — count the ones whose assignee is "ana" (no get_ticket needed).',
      'list_orders with customer "acme" and status "refunded", then get_order once for each order in that list.',
      "Add the numeric refundCents fields from the get_order results.",
    ],
    call: (call) => [
      `${call("tickets", "list_tickets", '{status:"open"}')} — count assignee "ana" (no get_ticket needed).`,
      `${call("orders", "list_orders", '{customer:"acme",status:"refunded"}')}, then ${call("orders", "get_order", "{id}")} once for each order.`,
      "Add the numeric refundCents fields from the get_order results.",
    ],
    callFields: (call, fields) => [
      `${call("tickets", "list_tickets", '{status:"open"}')} — count assignee "ana" (no get_ticket needed).`,
      `${call("orders", "list_orders", '{customer:"acme",status:"refunded"}')}, then ${call("orders", "get_order", "{id}", fields)} once for each order.`,
      "Add the numeric refundCents fields from the get_order results.",
    ],
    chain:
      'await servers.tickets.list_tickets({status:"open"}) and count assignee==="ana"; ' +
      'await servers.orders.list_orders({customer:"acme",status:"refunded"}), then ' +
      "await servers.orders.get_order({id}) for each (use Promise.all if you want), " +
      "sum refundCents; return {tickets, refund}.",
  },
  // ── refund-evaluation workloads (from 1.md) ──────────────────────────────────────────────
  // Aggregation: every refunded order's refundCents, read only from get_refund_order. Chaining should dominate.
  refundAggregate: {
    title: "refunded evaluation orders: count and total refundCents",
    servers: ["refunds"],
    format: "<count> <sum>",
    prompt:
      "Using the refunds server, count the refunded orders and sum each order's refundCents field " +
      "(from get_refund_order; list rows do not carry it). Answer with exactly two numbers: the count, then the sum.",
    coldPrompt:
      "Count the refunded orders and sum each order's refundCents field (the per-order record has it; " +
      "the list does not). Answer with exactly two numbers: the count, then the sum.",
    expected: data.expectedRefundAggregate,
    bulk: "There are several refunded orders; get_refund_order records carry many line items — still fetch each one.",
    coldBulk:
      "Order records are large — still fetch each order you need, and add the numeric refundCents fields (do NOT estimate them; null means no refund).",
    fields: '["id","refundCents"]',
    direct: [
      'list_refund_orders with status "refunded".',
      "Call get_refund_order once for each order in that list.",
      "Add the numeric refundCents fields from those results (skip null).",
    ],
    call: (call) => [
      `${call("refunds", "list_refund_orders", '{status:"refunded"}')}.`,
      `For each order in the list, ${call("refunds", "get_refund_order", "{id}")} once.`,
      "Add the numeric refundCents fields from those results (skip null).",
    ],
    callFields: (call, fields) => [
      `${call("refunds", "list_refund_orders", '{status:"refunded"}')}.`,
      `For each order in the list, ${call("refunds", "get_refund_order", "{id}", fields)} once.`,
      "Add the numeric refundCents fields from those results (skip null).",
    ],
    chain:
      'await servers.refunds.list_refund_orders({status:"refunded"}), ' +
      "await servers.refunds.get_refund_order({id}) for each (use Promise.all if you want), " +
      "sum refundCents (skip null), return {count, total}.",
  },
  // Policy evaluation: eligibility needs the policy document's window and exceptions. The chain returns
  // the compact order facts plus the policy HTML as ONE string, so html_markdown can convert the policy.
  policyEval: {
    title: "refunds eligible under the current policy: count and total refundCents",
    servers: ["refunds", "docs"],
    format: "<eligibleCount> <eligibleRefundCents>",
    prompt:
      "Using the refunds and docs servers: fetch the current refund policy (get_policy for version " +
      `"${data.EVAL_CURRENT_POLICY}"), read its return window and exceptions, then count the refunded orders that ` +
      "are eligible under that policy and sum their refundCents (from get_refund_order). An order is eligible when it is " +
      "within the return window for its category and not excluded by the policy's exceptions. " +
      "Answer with exactly two numbers: the eligible count, then the eligible refund sum.",
    coldPrompt:
      `Count the refunded orders that are eligible under the current refund policy (version ${data.EVAL_CURRENT_POLICY}) ` +
      "and sum their refundCents (the per-order record has it and the category and age). Answer with exactly two numbers: " +
      "the eligible count, then the eligible refund sum.",
    expected: data.expectedPolicyEligible,
    bulk: "Several refunded orders need checking; get_refund_order records carry line items — still fetch each refunded order.",
    coldBulk:
      "Order records are large — still fetch each order you need. Apply the policy in the docs server to each order.",
    fields: '["id","refundCents","category","ageDays"]',
    direct: [
      'list_refund_orders with status "refunded".',
      `get_policy with version "${data.EVAL_CURRENT_POLICY}" (docs server) and read its return window and exceptions.`,
      "For each refunded order, call get_refund_order once and check it against the policy.",
      "Add the refundCents of the eligible orders.",
    ],
    call: (call) => [
      `${call("refunds", "list_refund_orders", '{status:"refunded"}')}.`,
      `${call("docs", "get_policy", `{version:"${data.EVAL_CURRENT_POLICY}"}`)} and read its window and exceptions.`,
      `For each refunded order, ${call("refunds", "get_refund_order", "{id}")} once and check it against the policy.`,
      "Add the refundCents of the eligible orders.",
    ],
    callFields: (call, fields) => [
      `${call("refunds", "list_refund_orders", '{status:"refunded"}')}.`,
      `${call("docs", "get_policy", `{version:"${data.EVAL_CURRENT_POLICY}"}`)} and read its window and exceptions.`,
      `For each refunded order, ${call("refunds", "get_refund_order", "{id}", fields)} once and check it against the policy.`,
      "Add the refundCents of the eligible orders.",
    ],
    chain:
      'await servers.refunds.list_refund_orders({status:"refunded"}), ' +
      "await servers.refunds.get_refund_order({id}) for each (use Promise.all if you want); " +
      `await servers.docs.get_policy({version:"${data.EVAL_CURRENT_POLICY}"}) (its text is one HTML string); ` +
      "keep the order facts you need (id, category, ageDays, refundCents) and return " +
      "{facts, policyHtml} as ONE final string: the policy HTML plus the JSON facts, so the policy reaches you in full.",
  },
  // HTML extraction: four integers spread over headings, a table and an exception paragraph of the current
  // policy page. The historical section carries outdated numbers, so reading the wrong version is wrong.
  policyFacts: {
    title: "current refund policy: return window, fee, minimum purchase and exception count",
    servers: ["docs"],
    format: "<windowDays> <feeBasisPoints> <minPurchaseCents> <exceptions>",
    prompt:
      `Using the docs server, fetch the refund policy for version "${data.EVAL_CURRENT_POLICY}" (get_policy) and report four ` +
      "values from that version only: the return window in days, the restocking fee in basis points, the minimum purchase " +
      "in cents, and the number of exception categories. Answer with exactly four numbers in that order.",
    coldPrompt:
      `From the current refund policy page (version ${data.EVAL_CURRENT_POLICY}), report the return window in days, the ` +
      "restocking fee in basis points, the minimum purchase in cents, and the number of exception categories. " +
      "Answer with exactly four numbers in that order.",
    expected: data.expectedPolicyFacts,
    bulk: "The policy page is long and has sections for other versions; read only the current version's values.",
    coldBulk: "The policy page is long; read only the values for the current version.",
    // get_policy returns HTML, not records, so there is no field to project; the call_tool+opt run gets no fields.
    fields: null,
    direct: [
      `get_policy with version "${data.EVAL_CURRENT_POLICY}" (docs server).`,
      "Read the return window, restocking fee, minimum purchase and exception count for that version only.",
    ],
    call: (call) => [
      `${call("docs", "get_policy", `{version:"${data.EVAL_CURRENT_POLICY}"}`)}.`,
      "Read the return window, restocking fee, minimum purchase and exception count for that version only.",
    ],
    callFields: (call) => [
      `${call("docs", "get_policy", `{version:"${data.EVAL_CURRENT_POLICY}"}`)}.`,
      "Read the return window, restocking fee, minimum purchase and exception count for that version only.",
    ],
    runChainPreamble: "The policy page is one long HTML document; the script returns it, you read the values from it.\n",
    chain:
      `await servers.docs.get_policy({version:"${data.EVAL_CURRENT_POLICY}"}) and return its HTML text as the final string ` +
      "(one string, unmodified); you read the four values from it.",
  },
  // Negative control: the script does the full evaluation itself and returns two numbers. Optimization
  // should add essentially nothing here, because no evidence reaches the model.
  policyEvalCompute: {
    title: "refunds eligible under the current policy (script computes the answer)",
    servers: ["refunds", "docs"],
    format: "<eligibleCount> <eligibleRefundCents>",
    prompt:
      "Using the refunds and docs servers, count the refunded orders that are eligible under the current refund " +
      `policy (get_policy version "${data.EVAL_CURRENT_POLICY}") and sum their refundCents. ` +
      "Answer with exactly two numbers: the eligible count, then the eligible refund sum.",
    coldPrompt:
      `Count the refunded orders eligible under the current refund policy (version ${data.EVAL_CURRENT_POLICY}) ` +
      "and sum their refundCents. Answer with exactly two numbers: the eligible count, then the eligible refund sum.",
    expected: data.expectedPolicyEligible,
    bulk: "Several refunded orders need checking; the calculation happens in the script, so keep the records there.",
    coldBulk: "Order records are large — still fetch each order you need. Do the calculation yourself and report only the two numbers.",
    fields: '["id","refundCents"]',
    direct: [
      `get_policy with version "${data.EVAL_CURRENT_POLICY}" (docs server), then list_refund_orders with status "refunded".`,
      "For each refunded order, call get_refund_order once and check it against the policy.",
      "Add the refundCents of the eligible orders.",
    ],
    call: (call) => [
      `${call("docs", "get_policy", `{version:"${data.EVAL_CURRENT_POLICY}"}`)} and read its window and exceptions.`,
      `${call("refunds", "list_refund_orders", '{status:"refunded"}')}.`,
      `For each refunded order, ${call("refunds", "get_refund_order", "{id}")} once and check it against the policy.`,
      "Add the refundCents of the eligible orders.",
    ],
    callFields: (call, fields) => [
      `${call("docs", "get_policy", `{version:"${data.EVAL_CURRENT_POLICY}"}`)} and read its window and exceptions.`,
      `${call("refunds", "list_refund_orders", '{status:"refunded"}')}.`,
      `For each refunded order, ${call("refunds", "get_refund_order", "{id}", fields)} once and check it against the policy.`,
      "Add the refundCents of the eligible orders.",
    ],
    chain:
      `await servers.docs.get_policy({version:"${data.EVAL_CURRENT_POLICY}"}) and read its window and exceptions; ` +
      'await servers.refunds.list_refund_orders({status:"refunded"}), then await servers.refunds.get_refund_order({id}) for each; ' +
      "apply the policy in the script and return {count, total} (the eligible count and refund sum).",
  },
};

export const TASK_IDS = Object.keys(TASKS);

export const STRATEGY_LABELS = {
  direct: "direct",
  "call-tool": "call_tool",
  "call-tool-optimized": "call_tool+opt",
  "run-chain": "run_chain",
};

const quote = (s) => `"${s}"`;
const serverList = (task) => task.servers.map(quote).join(", ");
const toolList = (task) => task.servers.map((s) => `${s}: ${ALL_FIXTURE_SERVERS[s].tools}`).join("; ");
const numbered = (steps) => steps.map((s, i) => `${i + 1}) ${s}`).join("\n");
const callWith = (name) => (server, tool, args, fields) =>
  `call_tool(server=${quote(server)}, tool=${quote(tool)}, args=${args}${fields ? `, fields=${fields}` : ""})`;

/** Response optimization config for the call_tool+opt strategy; null for the others. */
export function strategyResponseOptimization(strategyId) {
  return strategyId === "call-tool-optimized" ? { enabled: true, defaultMode: "adaptive", maxOutputTokens: 4000 } : null;
}

/**
 * Response optimization for an experiment variant. `policy` is the variant's explicit responseOptimization
 * (null means off). Explicit policies are used as written: no default cap is added, because 1.md requires
 * the primary comparison to avoid truncation.
 */
export function variantResponseOptimization(policy) {
  return policy ? { ...policy } : null;
}

/** Which runnable strategy id an experiment `execution` maps onto. */
const EXECUTION_STRATEGY = { direct: "direct", call_tool: "call-tool", run_chain: "run-chain" };

/**
 * Validate an experiment definition (1.md) and expand it into runnable variants. Throws with a clear
 * message on anything the harness cannot run faithfully, so a bad experiment never runs silently.
 */
export function parseExperiment(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") throw new Error("experiment: expected a JSON object");
  const variants = raw.variants;
  if (!variants || typeof variants !== "object") errors.push("experiment: missing variants");
  const taskIds = Array.isArray(raw.tasks) ? raw.tasks : [];
  for (const id of taskIds) if (!TASKS[id]) errors.push(`experiment: unknown task ${id}`);
  if (taskIds.length === 0) errors.push("experiment: tasks must be a non-empty list");
  if (raw.index !== undefined && raw.index !== "fresh" && raw.index !== "warm") errors.push(`experiment: index must be "fresh" or "warm"`);

  const expanded = [];
  for (const [id, v] of Object.entries(variants ?? {})) {
    if (!EXECUTION_STRATEGY[v.execution]) {
      errors.push(`variant ${id}: execution must be one of ${Object.keys(EXECUTION_STRATEGY).join(", ")}`);
      continue;
    }
    // Projection (G) is task-level: call_tool with fields. It is only meaningful with call_tool.
    if (v.projection && v.execution !== "call_tool") errors.push(`variant ${id}: projection needs execution call_tool`);
    if (v.execution === "direct" && (v.manifest || v.responseOptimization)) {
      errors.push(`variant ${id}: direct MCP has no manifest or response optimization`);
    }
    if (v.responseOptimization && v.responseOptimization.enabled === false) {
      errors.push(`variant ${id}: responseOptimization.enabled is false; use null to turn optimization off`);
    }
    expanded.push({
      id,
      label: v.label ?? id,
      strategy: EXECUTION_STRATEGY[v.execution],
      manifest: Boolean(v.manifest),
      projection: Boolean(v.projection),
      responseOptimization: variantResponseOptimization(v.responseOptimization ?? null),
    });
  }
  if (expanded.length === 0) errors.push("experiment: no variants");
  if (errors.length) throw new Error(errors.join("; "));
  return { name: raw.name ?? "experiment", tasks: taskIds, index: raw.index ?? "fresh", variants: expanded };
}

/** The system-prompt addendum the model gets for one task and strategy. */
export function buildInstruction(taskId, strategyId, { cold = false } = {}) {
  const task = TASKS[taskId];
  const rule = ANSWER_RULE(task.format);
  const names = serverList(task);
  const plural = task.servers.length > 1;
  const upstream = `Upstream server${plural ? "s" : ""}: ${names}. Tools — ${toolList(task)}.`;

  if (strategyId === "direct") {
    if (cold) {
      return (
        "You have many MCP servers loaded directly (no lazygate). Pick the one" +
        `${plural ? "s" : ""} that serve${plural ? "" : "s"} the task and use ${plural ? "their" : "its"} tools.\n` +
        `${task.coldBulk}\n${rule}`
      );
    }
    return (
      `You have many MCP servers loaded directly (no lazygate), including ${names}.\n` +
      `IGNORE every server except ${names}. Tools — ${toolList(task)}.\n${task.bulk}\n` +
      `Required sequence:\n${numbered(task.direct)}\n${rule}`
    );
  }

  // Neutral on purpose: it does not tell the model to call discover_tools first, so a manifest in the
  // MCP instructions (or cached signatures) is measured on its own, with the same words in every
  // cold variant.
  const discover =
    "You have the lazygate MCP server and do not know which upstream servers or tools exist.\n" +
    `Work out which server${plural ? "s" : ""} and tools you need and how to call them through lazygate, then `;

  if (strategyId === "call-tool") {
    if (cold) return `${discover}use call_tool only (never run_chain).\n${task.coldBulk}\n${rule}`;
    return (
      `You have the lazygate MCP server. ${upstream}\n${task.bulk}\n` +
      `Required sequence (use call_tool only; never run_chain):\n${numbered(task.call(callWith()))}\n${rule}`
    );
  }

  if (strategyId === "call-tool-optimized") {
    // Tasks whose upstream returns text (HTML) have no records to project: pass no fields, so the
    // strategy is measured without projection credit it did not earn.
    if (!task.fields) {
      if (cold) return `${discover}use call_tool only (never run_chain).\n${task.coldBulk}\n${rule}`;
      return (
        `You have the lazygate MCP server. ${upstream}\n${task.bulk}\n` +
        `Required sequence (use call_tool only; never run_chain):\n${numbered(task.callFields(callWith()))}\n${rule}`
      );
    }
    if (cold) {
      return (
        `${discover}use call_tool only (never run_chain).\n` +
        `${task.coldBulk} Ask call_tool for only the fields you need: pass fields=[...] (for example ${task.fields}).\n${rule}`
      );
    }
    return (
      `You have the lazygate MCP server. ${upstream}\n` +
      `${task.bulk.replace(/ — still fetch each one\.$/, ".")} Ask call_tool for only the fields you need.\n` +
      `Required sequence (use call_tool only; never run_chain):\n${numbered(task.callFields(callWith(), task.fields))}\n${rule}`
    );
  }

  if (strategyId === "run-chain") {
    if (cold) {
      return (
        "You have the lazygate MCP server and do not know which upstream servers or tools exist.\n" +
        `Work out which server${plural ? "s" : ""} and tools you need and how to call them through lazygate. ` +
        "Inside run_chain you call servers.<server>.<tool>(args); describe_tool with a server and NO tool argument returns its tool-chain stubs.\n" +
        "Then write ONE run_chain script that fetches, filters and totals; the records are large, so keep them inside the script (never use call_tool).\n" +
        rule
      );
    }
    const stubs = task.servers
      .map((s) => `describe_tool with server=${quote(s)} and NO tool argument (stubs)`)
      .join("; ");
    return (
      `You have the lazygate MCP server. Upstream server${plural ? "s" : ""}: ${names} (toolChain on).\n` +
      (task.runChainPreamble ?? "There are several matching records with large bodies; keep all of that inside the script.\n") +
      "Do exactly this, then stop (no retries unless a tool returns an error):\n" +
      `1) ${stubs}.\n` +
      `2) ONE run_chain call. Inside the script: ${task.chain} Do not use call_tool.\n${rule}`
    );
  }
  throw new Error(`unknown strategy ${strategyId}`);
}

/** The prompt text for a task. */
export function taskPrompt(taskId, { cold = false } = {}) {
  const task = TASKS[taskId];
  return cold ? task.coldPrompt : task.prompt;
}

/**
 * True only when the answer's final non-empty line is exactly the expected integers, in order,
 * separated by single spaces (what the task instructions ask for). Numbers elsewhere in the
 * response, a different order, extra numbers and thousands separators are all wrong: the model
 * was told to reply with nothing else, so lenient matching could score a wrong answer correct.
 */
export function answerMatches(answer, expected) {
  const lines = String(answer).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last === expected.join(" ");
}

/** The line the model was asked for, or the start of its first line when it gave prose. */
export function answerSummary(answer, count) {
  const lines = String(answer).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exact = new RegExp(`^(\\d[\\d,]*)(\\s+\\d[\\d,]*){${Math.max(0, count - 1)}}$`);
  return lines.findLast((l) => exact.test(l)) ?? (lines[0] ?? "").slice(0, 60);
}
