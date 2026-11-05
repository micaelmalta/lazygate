// Minimal stdio MCP server for the benchmark --tasks fixture and tool-chain tests.
// Tools: list_tickets (ids + status + assignee, no body), get_ticket (full record with a long body).
// Deterministic data (task-data.mjs), so a task's expected answer can be checked.
//
// Sized for a visible run_chain vs call_tool gap: enough open+ana tickets that call_tool
// finishes (assignee is on the list), but bodies large enough that shipping every get_ticket
// result through the model dominates the fixed Claude/lazygate prefix.
import { serveFixture, textResult, errorResult } from "./fixture-mcp.mjs";
import { TICKETS } from "./task-data.mjs";

const tools = [
  {
    name: "list_tickets",
    description: "List ticket ids, statuses, and assignees (no body). Optional status filter.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["open", "closed", "blocked"] } },
    },
  },
  {
    name: "get_ticket",
    description: "Fetch one ticket's full record, including the body and bodyLength.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

serveFixture({
  name: "tickets",
  tools,
  run(name, args) {
    if (name === "list_tickets") {
      const rows = args.status ? TICKETS.filter((t) => t.status === args.status) : TICKETS;
      return textResult(rows.map((t) => ({ id: t.id, status: t.status, assignee: t.assignee })));
    }
    if (name === "get_ticket") {
      const t = TICKETS.find((x) => x.id === args.id);
      if (!t) return errorResult(`no ticket ${args.id}`);
      // bodyLength is explicit so call_tool does not depend on the model counting characters
      // (LLMs are unreliable at that). The long `body` still inflates intermediate context.
      return textResult({ ...t, bodyLength: t.body.length });
    }
    return errorResult(`unknown tool ${name}`);
  },
});
