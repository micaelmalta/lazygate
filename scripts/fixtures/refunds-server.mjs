// Stdio MCP server for the benchmark --tasks fixtures: refund evaluation orders.
// list_orders returns short rows (no refund amount, no category or age); get_order returns the full
// record with the refundCents, the category and the age the policy needs, plus line items.
import { serveFixture, textResult, errorResult } from "./fixture-mcp.mjs";
import { EVAL_ORDERS } from "./task-data.mjs";

const tools = [
  {
    name: "list_refund_orders",
    description: "List refund-evaluation orders (id, customer, status). Optional customer and status filters.",
    inputSchema: {
      type: "object",
      properties: {
        customer: { type: "string" },
        status: { type: "string", enum: ["paid", "refunded", "pending"] },
      },
    },
  },
  {
    name: "get_refund_order",
    description: "Fetch one order's full record: category, ageDays, refundCents (null when no refund is recorded) and line items.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

serveFixture({
  name: "refunds",
  tools,
  run(name, args) {
    if (name === "list_refund_orders") {
      const rows = EVAL_ORDERS.filter(
        (o) => (!args.customer || o.customer === args.customer) && (!args.status || o.status === args.status)
      );
      return textResult(rows.map((o) => ({ id: o.id, customer: o.customer, status: o.status })));
    }
    if (name === "get_refund_order") {
      const o = EVAL_ORDERS.find((x) => x.id === args.id);
      if (!o) return errorResult(`no order ${args.id}`);
      return textResult({ ...o, lineCount: o.lines.length });
    }
    return errorResult(`unknown tool ${name}`);
  },
});
