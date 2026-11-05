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
const toolList = (task) => task.servers.map((s) => `${s}: ${FIXTURE_SERVERS[s].tools}`).join("; ");
const numbered = (steps) => steps.map((s, i) => `${i + 1}) ${s}`).join("\n");
const callWith = (name) => (server, tool, args, fields) =>
  `call_tool(server=${quote(server)}, tool=${quote(tool)}, args=${args}${fields ? `, fields=${fields}` : ""})`;

/** Response optimization config for the call_tool+opt strategy; null for the others. */
export function strategyResponseOptimization(strategyId) {
  return strategyId === "call-tool-optimized" ? { enabled: true, defaultMode: "adaptive", maxOutputTokens: 4000 } : null;
}

/** The system-prompt addendum the model gets for one task and strategy. */
export function buildInstruction(taskId, strategyId, { cold = false, manifest = false } = {}) {
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

  if (manifest && strategyId !== "direct") {
    // The tool signatures reach the model through the broker's MCP instructions, not this text.
    const listed =
      "You have the lazygate MCP server. Its instructions list the tools of some upstream servers with their call signatures; " +
      "use those directly and call discover_tools only for something that is not listed.\n";
    if (strategyId === "call-tool") return `${listed}Use call_tool only (never run_chain).\n${task.coldBulk}\n${rule}`;
    if (strategyId === "call-tool-optimized") {
      return (
        `${listed}Use call_tool only (never run_chain).\n` +
        `${task.coldBulk} Ask call_tool for only the fields you need: pass fields=[...] (for example ${task.fields}).\n${rule}`
      );
    }
    return (
      `${listed}Write ONE run_chain script that fetches, filters and totals, calling servers.<server>.<tool>(args) per the listed signatures; ` +
      `the records are large, so keep them inside the script (never use call_tool).\n${rule}`
    );
  }

  const discover =
    "You have the lazygate MCP server and do not know which upstream servers or tools exist.\n" +
    "Start with discover_tools to find the right server" + (plural ? "s" : "") + ", learn the tool names and argument shapes from its answer (use describe_tool only if you need more), then ";

  if (strategyId === "call-tool") {
    if (cold) return `${discover}use call_tool only (never run_chain).\n${task.coldBulk}\n${rule}`;
    return (
      `You have the lazygate MCP server. ${upstream}\n${task.bulk}\n` +
      `Required sequence (use call_tool only; never run_chain):\n${numbered(task.call(callWith()))}\n${rule}`
    );
  }

  if (strategyId === "call-tool-optimized") {
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
        "Start with discover_tools to find the right server" + (plural ? "s" : "") + "; a clear match lists call signatures, and inside run_chain you call servers.<server>.<tool>(args). " +
        "Use describe_tool with that server and NO tool argument only if you need the tool-chain stubs.\n" +
        "Then write ONE run_chain script that fetches, filters and totals; the records are large, so keep them inside the script (never use call_tool).\n" +
        rule
      );
    }
    const stubs = task.servers
      .map((s) => `describe_tool with server=${quote(s)} and NO tool argument (stubs)`)
      .join("; ");
    return (
      `You have the lazygate MCP server. Upstream server${plural ? "s" : ""}: ${names} (toolChain on).\n` +
      "There are several matching records with large bodies; keep all of that inside the script.\n" +
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
