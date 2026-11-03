import { createInterface } from "readline";

const tools = [
  {
    name: "search_records",
    description: "Read-only fixture search",
    inputSchema: { type: "object", properties: {} },
  },
];

const result = {
  content: [],
  structuredContent: {
    items: Array.from({ length: 12 }, (_, id) => ({
      id,
      title: `Record ${id}`,
      body: "Long fixture detail that is not part of the requested projection. ".repeat(10),
    })),
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id == null) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "benchmark-response-fixture", version: "1" },
      },
    });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  } else if (message.method === "tools/call" && message.params?.name === "search_records") {
    send({ jsonrpc: "2.0", id: message.id, result });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown request" } });
  }
});
