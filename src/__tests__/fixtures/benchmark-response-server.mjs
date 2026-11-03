import { createInterface } from "readline";

const tools = [
  {
    name: "search_records",
    description: "Read-only fixture search",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_document",
    description: "Read-only HTML documentation fixture",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_article",
    description: "Read-only HTML article fixture with navigation",
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

const documents = {
  get_document: {
    content: [{
      type: "text",
      text: `<html><head><style>.hidden{display:none}</style><script>var tracker=1;</script></head><body><nav>Documentation navigation</nav><main><h1>Benchmark handbook</h1><p>Install the client from the command line.</p><pre><code>npm install lazygate</code></pre><table><tr><th>Mode</th><th>Purpose</th></tr><tr><td>Project</td><td>Keep selected fields</td></tr></table></main><footer>Documentation footer</footer></body></html>`,
    }],
  },
  get_article: {
    content: [{
      type: "text",
      text: `<html><body><nav>Home · Product · Company · Support</nav><main><h1>Response optimization guide</h1><p>Keep the benchmark safe.</p><p>Use HTML reader mode to retain the main article while removing navigation and footer boilerplate.</p></main><footer>Copyright 2026 Example</footer></body></html>`,
    }],
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
  } else if (message.method === "tools/call") {
    const toolResult = message.params?.name === "search_records"
      ? result
      : documents[message.params?.name];
    if (toolResult) send({ jsonrpc: "2.0", id: message.id, result: toolResult });
    else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown tool" } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown request" } });
  }
});
