// Stdio MCP server for the benchmark --tasks fixtures: an application log store.
// search_logs returns a short row per entry; get_log_entry returns the full record with its stack trace.
import { serveFixture, textResult, errorResult } from "./fixture-mcp.mjs";
import { LOG_ENTRIES } from "./task-data.mjs";

const tools = [
  {
    name: "search_logs",
    description: "Search log entries (id, level, service, ts) without stack traces. Optional level and service filters.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["INFO", "WARN", "ERROR"] },
        service: { type: "string" },
      },
    },
  },
  {
    name: "get_log_entry",
    description: "Fetch one log entry's full record: stack trace and stackFrames (the number of frames).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

serveFixture({
  name: "logs",
  tools,
  run(name, args) {
    if (name === "search_logs") {
      const rows = LOG_ENTRIES.filter((e) => (!args.level || e.level === args.level) && (!args.service || e.service === args.service));
      return textResult(rows.map((e) => ({ id: e.id, level: e.level, service: e.service, ts: e.ts })));
    }
    if (name === "get_log_entry") {
      const e = LOG_ENTRIES.find((x) => x.id === args.id);
      if (!e) return errorResult(`no log entry ${args.id}`);
      return textResult(e);
    }
    return errorResult(`unknown tool ${name}`);
  },
});
