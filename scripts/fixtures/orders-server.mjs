// Stdio MCP server for the benchmark --tasks fixtures: an order system.
// list_orders returns a short row per order; get_order returns the full record with ~90 line items.
import { serveFixture, textResult, errorResult } from "./fixture-mcp.mjs";
import { ORDERS } from "./task-data.mjs";

const tools = [
  {
    name: "list_orders",
    description: "List orders (id, customer, status, totalCents) without line items. Optional customer and status filters.",
    inputSchema: {
      type: "object",
      properties: {
        customer: { type: "string" },
        status: { type: "string", enum: ["paid", "refunded", "pending"] },
      },
    },
  },
  {
    name: "get_order",
    description: "Fetch one order's full record: line items, lineCount and refundCents.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

serveFixture({
  name: "orders",
  tools,
  run(name, args) {
    if (name === "list_orders") {
      const rows = ORDERS.filter((o) => (!args.customer || o.customer === args.customer) && (!args.status || o.status === args.status));
      return textResult(rows.map((o) => ({ id: o.id, customer: o.customer, status: o.status, totalCents: o.totalCents })));
    }
    if (name === "get_order") {
      const o = ORDERS.find((x) => x.id === args.id);
      if (!o) return errorResult(`no order ${args.id}`);
      return textResult({ ...o, lineCount: o.lines.length });
    }
    return errorResult(`unknown tool ${name}`);
  },
});
