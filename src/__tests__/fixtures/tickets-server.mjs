// Minimal stdio MCP server for the benchmark --tasks fixture and tool-chain tests.
// Tools: list_tickets (ids + status + assignee, no body), get_ticket (full record with a long body).
// Deterministic data, so a task's expected answer can be checked.
//
// Sized for a visible run_chain vs call_tool gap: enough open+ana tickets that call_tool
// finishes (assignee is on the list), but bodies large enough that shipping every get_ticket
// result through the model dominates the fixed Claude/lazygate prefix.
import { createInterface } from "readline";

const TICKET_COUNT = 48;
/** ~30 chars × repeats ≈ body size; 8 hits × ~7.5 KiB ≈ 60 KiB of intermediate text. */
const BODY_REPEATS = 250;

const TICKETS = Array.from({ length: TICKET_COUNT }, (_, i) => {
  const id = `TKT-${String(i + 1).padStart(3, "0")}`;
  const status = i % 4 === 0 ? "open" : i % 4 === 1 ? "closed" : i % 4 === 2 ? "blocked" : "open";
  return {
    id,
    status,
    title: `Ticket ${i + 1}`,
    body: `Long description for ${id}. `.repeat(BODY_REPEATS),
    assignee: ["ana", "ben", "cy"][i % 3],
  };
});

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

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

function run(name, args) {
  if (name === "list_tickets") {
    const rows = args.status ? TICKETS.filter((t) => t.status === args.status) : TICKETS;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(rows.map((t) => ({ id: t.id, status: t.status, assignee: t.assignee }))),
        },
      ],
    };
  }
  if (name === "get_ticket") {
    const t = TICKETS.find((x) => x.id === args.id);
    if (!t) return { isError: true, content: [{ type: "text", text: `no ticket ${args.id}` }] };
    // bodyLength is explicit so call_tool does not depend on the model counting characters
    // (LLMs are unreliable at that). The long `body` still inflates intermediate context.
    return {
      content: [{ type: "text", text: JSON.stringify({ ...t, bodyLength: t.body.length }) }],
    };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "tickets-server", version: "1" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: run(msg.params?.name, msg.params?.arguments ?? {}) });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
  }
});
