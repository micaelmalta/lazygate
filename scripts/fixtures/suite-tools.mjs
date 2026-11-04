// Tool definitions of the benchmark suite fixture server (kept apart so importing them does not start the server).
import { REGIONS } from "./suite-data.mjs";

export const TOOLS = [
  {
    name: "get_order_status",
    description: "Get the current status, carrier and history of one order by its id.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Order id, e.g. ORD-0042" } }, required: ["id"] },
  },
  {
    name: "list_tickets",
    description: "List ticket ids, statuses, assignees and points (no body). Optional status filter.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "closed", "blocked"] } } },
  },
  {
    name: "get_ticket",
    description: "Fetch one ticket's full record, including its long discussion body.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_region_metric",
    description: "Request volume, error count and p95 latency for one region.",
    inputSchema: { type: "object", properties: { region: { type: "string", enum: REGIONS } }, required: ["region"] },
  },
  {
    name: "query_events",
    description: "Return recent service events (id, ts, service, level, latency_ms, message, trace, tags).",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
  },
  {
    name: "fetch_doc",
    description: "Fetch a documentation page as HTML.",
    inputSchema: { type: "object", properties: { page: { type: "string" } }, required: ["page"] },
  },
];
