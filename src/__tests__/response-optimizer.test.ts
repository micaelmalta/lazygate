import { describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateTokens,
  optimizeToolResult,
  parseResponseOptimizationConfig,
  type OptimizationContext,
  type OptimizableToolResult,
  type Tokenizer,
} from "../response-optimizer.js";
import { loadRegistry } from "../registry.js";

const context: OptimizationContext = { serverName: "github", toolName: "search_issues", source: "call_tool" };

describe("response optimizer JSON modes", () => {
  it("prunes only configured empty values and preserves false and zero", async () => {
    const original = {
      structuredContent: {
        issue: { id: 0, closed: false, description: null, empty: {}, labels: [] },
      },
      content: [],
    };

    const optimized = await optimizeToolResult(
      original,
      { mode: "prune", removeNulls: true, removeEmptyObjects: true, removeEmptyArrays: true },
      context
    );

    expect(optimized.result.structuredContent).toEqual({ issue: { id: 0, closed: false } });
    expect(optimized.metrics).toMatchObject({ mode: "prune", changed: true, complete: false });
  });

  it("projects nested fields through arrays without including unrelated values", async () => {
    const optimized = await optimizeToolResult(
      {
        structuredContent: {
          issues: [
            { id: 1, title: "One", assignee: { login: "ada", email: "private@example.test" } },
            { id: 2, title: "Two", assignee: null },
          ],
        },
        content: [],
      },
      { mode: "project", fields: ["issues.id", "issues.title", "issues.assignee.login"] },
      context
    );

    expect(optimized.result.structuredContent).toEqual({
      issues: [
        { id: 1, title: "One", assignee: { login: "ada" } },
        { id: 2, title: "Two" },
      ],
    });
    expect(optimized.metrics.complete).toBe(false);
  });

  it("evaluates JSONPath as a data query and returns selected values", async () => {
    const optimized = await optimizeToolResult(
      { structuredContent: { issues: [{ title: "One" }, { title: "Two" }] }, content: [] },
      { mode: "jsonpath", jsonPath: "$.issues[*].title" },
      context
    );

    expect(optimized.result.structuredContent).toEqual(["One", "Two"]);
    expect(optimized.metrics.complete).toBe(false);
  });

  it("supports a simple standard JSONPath filter without accepting JavaScript code", async () => {
    const input = { issues: [{ title: "One", state: "open" }, { title: "Two", state: "closed" }] };
    const filtered = await optimizeToolResult(
      { structuredContent: input, content: [] },
      { mode: "jsonpath", jsonPath: '$.issues[?(@.state == "open")].title' },
      context
    );
    expect(filtered.result.structuredContent).toEqual(["One"]);

    const original = { structuredContent: input, content: [] };
    const rejected = await optimizeToolResult(
      original,
      { mode: "jsonpath", jsonPath: '$.issues[?(@.title.constructor.constructor("return process")())]' },
      context
    );
    expect(rejected.result).toBe(original);
    expect(rejected.metrics.failure).toMatch(/prototype access/);

    const regexRejected = await optimizeToolResult(
      original,
      { mode: "jsonpath", jsonPath: "$.issues[?(@.title =~ /One/)]" },
      context
    );
    expect(regexRejected.result).toBe(original);
    expect(regexRejected.metrics.failure).toMatch(/regex/i);
  });

  it("projects JSON text blocks while keeping them as text content", async () => {
    const optimized = await optimizeToolResult(
      { content: [{ type: "text", text: '{"issues":[{"id":1,"title":"One","private":"x"}]}' }] },
      { mode: "project", fields: ["issues.id", "issues.title"] },
      context
    );

    expect((optimized.result.content[0] as { text: string }).text).toBe('{"issues":[{"id":1,"title":"One"}]}');
  });

  it("returns a schema, total count, and bounded samples for arrays", async () => {
    const optimized = await optimizeToolResult(
      {
        structuredContent: [
          { id: 1, title: "One", open: true },
          { id: 2, title: "Two", open: false },
          { id: 3, title: "Three", open: true },
        ],
        content: [],
      },
      { mode: "schema", sampleSize: 1 },
      context
    );

    expect(optimized.result.structuredContent).toEqual({
      _optimization: { mode: "schema", complete: false },
      _count: 3,
      _schema: { id: "number", title: "string", open: "boolean" },
      _sample: [{ id: 1, title: "One", open: true }],
    });
    expect(optimized.metrics.complete).toBe(false);
  });

  it("leaves successful content untouched when the mode is off", async () => {
    const original = { structuredContent: { answer: 42 }, content: [{ type: "text", text: "ok" }] };
    const optimized = await optimizeToolResult(original, { mode: "off" }, context);
    expect(optimized.result).toBe(original);
    expect(optimized.metrics.changed).toBe(false);
  });

  it("does not rewrite tool errors", async () => {
    const original = { isError: true, content: [{ type: "text", text: "permission denied" }] };
    const optimized = await optimizeToolResult(original, { mode: "project", fields: ["secret"] }, context);
    expect(optimized.result).toBe(original);
  });

  it("returns an explicit bounded error when an upstream error exceeds a hard output limit", async () => {
    const optimized = await optimizeToolResult(
      { isError: true, content: [{ type: "text", text: "permission denied ".repeat(100) }] },
      { mode: "project", fields: ["id"], maxOutputBytes: 256 },
      context
    );

    expect(optimized.result.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(optimized.result), "utf8")).toBeLessThanOrEqual(256);
    expect((optimized.result.content[0] as { text: string }).text).toMatch(/output .*limit|output is incomplete/i);
  });

  it("does not return an oversized structured payload when a hard output limit cannot be met", async () => {
    const original = {
      content: [{ type: "text", text: "x".repeat(4_000) }],
      structuredContent: { records: Array.from({ length: 100 }, (_, id) => ({ id, value: "x".repeat(100) })) },
    };
    const optimized = await optimizeToolResult(original, { mode: "off", maxTokens: 8 }, context);
    expect(optimized.result.isError).toBe(true);
    expect(optimized.result.structuredContent).toBeUndefined();
    expect((optimized.result.content[0] as { text: string }).text).toMatch(/output budget/i);
    expect(optimized.metrics.complete).toBe(false);
  });

  it("enforces the configured serialized output byte cap", async () => {
    const optimized = await optimizeToolResult(
      { content: [{ type: "text", text: "x".repeat(4_000) }] },
      { mode: "off", maxOutputBytes: 256 },
      context
    );
    expect(optimized.result.isError).toBe(true);
    expect((optimized.result.content[0] as { text: string }).text).toMatch(/output/i);
  });

  it("includes optional metrics metadata in the configured output budget", async () => {
    const optimized = await optimizeToolResult(
      { content: [{ type: "text", text: "x".repeat(40) }], structuredContent: { id: 1 } },
      { mode: "off", maxOutputBytes: 256, includeMetadata: true },
      context
    );

    expect(Buffer.byteLength(JSON.stringify(optimized.result), "utf8")).toBeLessThanOrEqual(256);
  });
});

describe("response optimizer HTML modes", () => {
  const htmlResult = (html: string): OptimizableToolResult => ({ content: [{ type: "text", text: html }] });

  it("converts semantic HTML to Markdown and removes active or non-content markup", async () => {
    const optimized = await optimizeToolResult(
      htmlResult(`<!doctype html><html><head><style>.x{}</style><script>alert(1)</script></head><body>
        <main><h1>Authentication</h1><p>Use <strong>an API key</strong>.</p>
        <p><a href="https://example.test/docs">Read the guide</a></p>
        <pre><code>Authorization: Bearer KEY</code></pre>
        <ul><li>One</li><li>Two</li></ul>
        <table><tr><th>Name</th><th>State</th></tr><tr><td>Build</td><td>Open</td></tr></table></main>
        <!-- tracker --></body></html>`),
      { mode: "html_markdown" },
      context
    );
    const markdown = (optimized.result.content[0] as { text: string }).text;
    expect(markdown).toContain("# Authentication");
    expect(markdown).toContain("**an API key**");
    expect(markdown).toContain("[Read the guide](https://example.test/docs)");
    expect(markdown).toContain("Authorization: Bearer KEY");
    expect(markdown).toContain("| Name | State |");
    expect(markdown).not.toMatch(/alert\(1\)|\.x\{\}|tracker/);
  });

  it("removes navigation and footer content only in reader mode", async () => {
    const source = htmlResult(
      "<html><body><nav>Site links</nav><main><h1>Article</h1><p>Useful body.</p></main><footer>Copyright</footer></body></html>"
    );
    const ordinary = await optimizeToolResult(source, { mode: "html_markdown" }, context);
    const reader = await optimizeToolResult(source, { mode: "html_reader" }, context);
    expect((ordinary.result.content[0] as { text: string }).text).toContain("Site links");
    expect((reader.result.content[0] as { text: string }).text).toContain("Useful body.");
    expect((reader.result.content[0] as { text: string }).text).not.toMatch(/Site links|Copyright/);
  });

  it("leaves non-HTML text unchanged even when a tool has an HTML policy", async () => {
    const original = { content: [{ type: "text", text: "  Plain text response.  " }] };
    const optimized = await optimizeToolResult(original, { mode: "html_reader" }, context);

    expect(optimized.result.content).toEqual(original.content);
    expect(optimized.metrics).toMatchObject({ changed: false, complete: true });
  });

  it("converts text embedded in MCP resource content while preserving its protocol fields", async () => {
    const original: OptimizableToolResult = {
      content: [
        { type: "resource", resource: { uri: "https://example.test/doc", mimeType: "text/html", text: "<main><h1>Guide</h1><p>Body</p></main>" } },
      ],
      _meta: { trace: "kept" },
    };
    const optimized = await optimizeToolResult(original, { mode: "html_markdown" }, context);
    const block = optimized.result.content[0] as { resource: { uri: string; mimeType: string; text: string } };
    expect(block.resource).toMatchObject({ uri: "https://example.test/doc", mimeType: "text/html" });
    expect(block.resource.text).toContain("# Guide");
    expect(optimized.result._meta).toMatchObject({ trace: "kept" });
  });
});

describe("response optimization budgeting and metadata", () => {
  it("marks truncated output incomplete in response metadata", async () => {
    const optimized = await optimizeToolResult(
      { content: [{ type: "text", text: "<main><p>Alpha beta gamma delta epsilon zeta eta theta.</p><p>second paragraph</p></main>" }] } as OptimizableToolResult,
      { mode: "html_markdown", maxTokens: 5 },
      context
    );
    expect(optimized.metrics.complete).toBe(false);
    expect(optimized.result._meta).toMatchObject({
      lazygate: { responseOptimization: { complete: false, mode: "html_markdown" } },
    });
    expect((optimized.result.content[0] as { text: string }).text).toContain("incomplete");
  });

  it("reports per-tool metrics and exposes metadata when a pruning pass loses empty values", async () => {
    const onMetrics = jest.fn();
    const optimized = await optimizeToolResult(
      { structuredContent: { value: null }, content: [] } as OptimizableToolResult,
      { mode: "prune", removeNulls: true },
      context,
      onMetrics
    );
    expect(onMetrics).toHaveBeenCalledWith(context, expect.objectContaining({ changed: true, complete: false }));
    expect(optimized.result._meta).toMatchObject({ lazygate: { responseOptimization: { complete: false } } });
  });

  it("passes malformed JSON text through when a JSON mode is selected", async () => {
    const original = { content: [{ type: "text", text: "not JSON at all" }] };
    const optimized = await optimizeToolResult(original, { mode: "project", fields: ["id"] }, context);
    expect(optimized.result.content[0]).toEqual(original.content[0]);
    expect(optimized.metrics.changed).toBe(false);
  });

  it("falls back to the original result when the configured input byte cap is exceeded", async () => {
    const original = { content: [{ type: "text", text: "<main><p>Too large</p></main>" }] };
    const optimized = await optimizeToolResult(
      original,
      { mode: "html_markdown", maxInputBytes: 12 },
      context
    );
    expect(optimized.result).toBe(original);
    expect(optimized.metrics.failure).toMatch(/maxInputBytes/);
  });
});

describe("adaptive response optimization", () => {
  it("selects the candidate with the greatest savings and reports the selected mode", async () => {
    const original = {
      content: [],
      structuredContent: {
        issues: [
          { id: 1, title: "A", state: "open", description: "x".repeat(80) },
          { id: 2, title: "B", state: "closed", description: "y".repeat(80) },
        ],
      },
    };
    const optimized = await optimizeToolResult(
      original,
      {
        mode: "adaptive",
        minInputTokens: 1,
        minSavingsPercent: 10,
        candidates: [
          { mode: "prune", removeNulls: true },
          { mode: "project", fields: ["issues.id", "issues.title"] },
        ],
      },
      context
    );

    expect(optimized.metrics).toMatchObject({ mode: "adaptive", selectedMode: "project", changed: true });
    expect(optimized.result.structuredContent).toEqual({ issues: [{ id: 1, title: "A" }, { id: 2, title: "B" }] });
    expect(optimized.result._meta).toMatchObject({
      lazygate: { responseOptimization: { mode: "adaptive", selectedMode: "project" } },
    });
  });

  it("returns the original result when no candidate meets the minimum savings threshold", async () => {
    const original = { content: [], structuredContent: { id: 1, title: "short" } };
    const optimized = await optimizeToolResult(
      original,
      {
        mode: "adaptive",
        minInputTokens: 1,
        minSavingsPercent: 90,
        candidates: [{ mode: "project", fields: ["id", "title"] }],
      },
      context
    );

    expect(optimized.result).toBe(original);
    expect(optimized.metrics).toMatchObject({ mode: "adaptive", selectedMode: "off", changed: false, complete: true });
  });

  it("requires candidate policies for adaptive tool configuration and rejects adaptive as the global default", () => {
    const missingCandidates = parseResponseOptimizationConfig({
      responseOptimization: {
        enabled: true,
        defaultMode: "off",
        tools: { "github.search_issues": { mode: "adaptive" } },
      },
    });
    expect(missingCandidates.errors.join(" ")).toMatch(/adaptive mode requires at least one candidate/);

    const globalAdaptive = parseResponseOptimizationConfig({
      responseOptimization: { enabled: true, defaultMode: "adaptive" },
    });
    expect(globalAdaptive.errors.join(" ")).toMatch(/defaultMode.*adaptive/);
    expect(globalAdaptive.config.enabled).toBe(false);

    const valid = parseResponseOptimizationConfig({
      responseOptimization: {
        enabled: true,
        defaultMode: "off",
        tools: {
          "github.search_issues": {
            mode: "adaptive",
            candidates: [{ mode: "project", fields: ["issues.id", "issues.title"] }],
            minInputTokens: 200,
            minSavingsPercent: 15,
          },
        },
      },
    });
    expect(valid.errors).toEqual([]);
    expect(valid.config.tools["github.search_issues"]).toMatchObject({
      mode: "adaptive",
      candidates: [{ mode: "project", fields: ["issues.id", "issues.title"] }],
      minInputTokens: 200,
      minSavingsPercent: 15,
    });
  });

  it("skips adaptive candidates below the configured minimum input size", async () => {
    const original = { content: [{ type: "text", text: "<main><p>A short page</p></main>" }] };
    const optimized = await optimizeToolResult(
      original,
      {
        mode: "adaptive",
        minInputTokens: 10_000,
        candidates: [{ mode: "html_reader" }],
      },
      context
    );

    expect(optimized.result).toBe(original);
    expect(optimized.metrics).toMatchObject({ mode: "adaptive", selectedMode: "off", changed: false });
  });
});

describe("tokenizer-aware response measurement", () => {
  const serializedLengthTokenizer: Tokenizer = {
    name: "test_serialized_length",
    countTokens: (serializedValue) => serializedValue.length,
  };

  it("uses an injected tokenizer for measurements and response metadata", async () => {
    const original = { content: [], structuredContent: { id: 1, title: "A title", detail: "omit me" } };
    const optimized = await optimizeToolResult(
      original,
      { mode: "project", fields: ["id", "title"], includeMetadata: true },
      context,
      undefined,
      serializedLengthTokenizer
    );

    expect(estimateTokens(original, serializedLengthTokenizer)).toBe(JSON.stringify(original).length);
    expect(optimized.metrics).toMatchObject({
      tokenizer: "test_serialized_length",
      originalTokens: JSON.stringify(original).length,
    });
    expect(optimized.result._meta).toMatchObject({
      lazygate: { responseOptimization: { tokenizer: "test_serialized_length" } },
    });
  });

  it("uses the injected tokenizer for adaptive candidate selection and output budgets", async () => {
    const bodyAwareTokenizer: Tokenizer = {
      name: "test_body_aware",
      countTokens: (serializedValue) => serializedValue.includes("detail") ? 10_000 : serializedValue.length,
    };
    const original = { content: [], structuredContent: { id: 1, detail: "x".repeat(500) } };
    const adaptive = await optimizeToolResult(
      original,
      {
        mode: "adaptive",
        minInputTokens: 1,
        minSavingsPercent: 10,
        candidates: [{ mode: "project", fields: ["id"] }],
      },
      context,
      undefined,
      bodyAwareTokenizer
    );
    expect(adaptive.metrics).toMatchObject({
      tokenizer: "test_body_aware",
      originalTokens: 10_000,
      selectedMode: "project",
    });

    const budgeted = await optimizeToolResult(
      { content: [{ type: "text", text: "x".repeat(200) }] },
      { mode: "off", maxTokens: 40 },
      context,
      undefined,
      serializedLengthTokenizer
    );
    expect(budgeted.metrics.tokenizer).toBe("test_serialized_length");
    expect(budgeted.metrics.originalTokens).toBeGreaterThan(40);
    expect(budgeted.result.isError).toBe(true);
  });

  it("uses the injected tokenizer when truncating structured content to a token budget", async () => {
    const xCountingTokenizer: Tokenizer = {
      name: "test_x_counter",
      countTokens: (serializedValue) => serializedValue.match(/x{5}/g)?.length ?? 0,
    };
    const original = {
      content: [],
      structuredContent: ["x".repeat(80), "x".repeat(80)],
    };
    const optimized = await optimizeToolResult(
      original,
      { mode: "off", maxTokens: 20 },
      context,
      undefined,
      xCountingTokenizer
    );

    expect(optimized.result.isError).not.toBe(true);
    expect(optimized.result.structuredContent).toEqual(["x".repeat(80)]);
    expect(optimized.metrics.optimizedTokens).toBeLessThanOrEqual(20);
    expect(optimized.metrics.complete).toBe(false);
  });

  it("uses the injected tokenizer when truncating text content to a token budget", async () => {
    const xCountingTokenizer: Tokenizer = {
      name: "test_x_counter",
      countTokens: (serializedValue) => serializedValue.match(/x{5}/g)?.length ?? 0,
    };
    const optimized = await optimizeToolResult(
      { content: [{ type: "text", text: "x".repeat(200) }] },
      { mode: "off", maxTokens: 25 },
      context,
      undefined,
      xCountingTokenizer
    );

    expect(optimized.result.isError).not.toBe(true);
    expect(optimized.result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[Output incomplete: truncated to configured budget.]"),
    });
    expect((optimized.result.content[0] as { text: string }).text.length).toBeGreaterThan(100);
    expect(optimized.metrics.optimizedTokens).toBeLessThanOrEqual(25);
    expect(optimized.metrics.complete).toBe(false);
  });

  it("falls back to the documented estimate when a custom tokenizer returns an invalid count", async () => {
    const invalidTokenizer: Tokenizer = { name: "test_invalid", countTokens: () => Number.NaN };
    const original = { content: [{ type: "text", text: "some response text" }] };
    const optimized = await optimizeToolResult(original, { mode: "off" }, context, undefined, invalidTokenizer);

    expect(optimized.metrics.tokenizer).toBe("test_invalid_fallback_chars_per_4");
    expect(optimized.metrics.originalTokens).toBe(estimateTokens(original));
  });
});

describe("response optimization configuration", () => {
  it("uses tool-specific settings before the global mode and honors the opt-in switch", async () => {
    const { parseResponseOptimizationConfig, resolveOptimizationPolicy } = await import("../response-optimizer.js");
    const parsed = parseResponseOptimizationConfig({
      responseOptimization: {
        enabled: true,
        defaultMode: "prune",
        maxOutputTokens: 800,
          maxOutputBytes: 4096,
        tools: { "github.search_issues": { mode: "project", fields: ["id", "title"] } },
      },
    });
    expect(parsed.config.enabled).toBe(true);
    expect(resolveOptimizationPolicy(parsed.config, context)).toMatchObject({
      mode: "project",
      fields: ["id", "title"],
      maxTokens: 800,
      maxOutputBytes: 4096,
    });
    expect(resolveOptimizationPolicy({ ...parsed.config, enabled: false }, context).mode).toBe("off");
  });

  it("uses the documented responseOptimization defaults when the section is absent", async () => {
    expect(parseResponseOptimizationConfig({}).config).toMatchObject({ enabled: false, defaultMode: "off" });
  });

  it("rejects incomplete per-tool projections in configuration", () => {
    const invalid = parseResponseOptimizationConfig({
      responseOptimization: {
        enabled: true,
        defaultMode: "off",
        tools: { "github.search": { mode: "project" } },
      },
    });
    expect(invalid.errors.join(" ")).toMatch(/project mode requires at least one field/);
    expect(invalid.config.enabled).toBe(false);
  });

  it("refreshes response policies when the shared servers.json file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazygate-response-config-"));
    const path = join(dir, "servers.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ servers: {}, responseOptimization: { enabled: true, defaultMode: "prune" } })
      );
      const router = loadRegistry(["--config", path], dir).router;
      expect(router.getResponseOptimization().defaultMode).toBe("prune");

      writeFileSync(
        path,
        JSON.stringify({ servers: {}, responseOptimization: { enabled: true, defaultMode: "html_markdown" } })
      );
      const later = new Date(Date.now() + 2_000);
      utimesSync(path, later, later);
      expect(router.reloadServersFromDisk()).toBe(true);
      expect(router.getResponseOptimization().defaultMode).toBe("html_markdown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
