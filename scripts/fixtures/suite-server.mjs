// Stdio MCP server behind the benchmark suite (`lazygate benchmark --suite`).
// Five workloads, deterministic data (see suite-data.mjs):
//   get_order_status       single known tool (small result)
//   list_tickets/get_ticket dependent chain (large per-item bodies)
//   get_region_metric      independent parallel calls (fixed latency each)
//   query_events           large JSON aggregation
//   fetch_doc              HTML documentation page
import { createInterface } from "readline";
import {
  DOC_HTML,
  EVENTS,
  REGIONS,
  REGION_DELAY_MS,
  TICKETS,
  orderRecord,
  regionMetric,
} from "./suite-data.mjs";
import { TOOLS } from "./suite-tools.mjs";

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const fail = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

async function run(name, args) {
  switch (name) {
    case "get_order_status":
      return text(orderRecord(args.id));
    case "list_tickets": {
      const rows = args.status ? TICKETS.filter((t) => t.status === args.status) : TICKETS;
      return text(rows.map(({ id, status, assignee, points }) => ({ id, status, assignee, points })));
    }
    case "get_ticket": {
      const ticket = TICKETS.find((t) => t.id === args.id);
      return ticket ? text(ticket) : fail(`no ticket ${args.id}`);
    }
    case "get_region_metric":
      if (!REGIONS.includes(args.region)) return fail(`unknown region ${args.region}`);
      await new Promise((resolve) => setTimeout(resolve, REGION_DELAY_MS));
      return text(regionMetric(args.region));
    case "query_events":
      return text(EVENTS.slice(0, args.limit ?? EVENTS.length));
    case "fetch_doc":
      return text(DOC_HTML);
    default:
      return fail(`unknown tool ${name}`);
  }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "lazygate-suite", version: "1" },
      },
    });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: await run(message.params?.name, message.params?.arguments ?? {}) });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown request" } });
  }
});
