// Tiny stdio MCP server loop shared by the benchmark task fixtures (tickets, orders, logs).
// When FIXTURE_START_LOG is set, each start appends "<server> <epoch ms>" to that file, so a benchmark
// can count how many servers a strategy actually launched.
import { appendFileSync } from "fs";
import { createInterface } from "readline";

/**
 * @param {{ name: string, tools: object[], run: (tool: string, args: object) => object }} spec
 */
export function serveFixture({ name, tools, run }) {
  if (process.env.FIXTURE_START_LOG) {
    try {
      appendFileSync(process.env.FIXTURE_START_LOG, `${name} ${Date.now()}\n`);
    } catch {
      /* the log is best effort */
    }
  }
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
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
          serverInfo: { name: `${name}-server`, version: "1" },
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
}

export const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
export const errorResult = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
