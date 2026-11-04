// src/__tests__/tool-chain-stubs.test.ts
// JSON Schema -> compact TypeScript stubs, and MCP result -> script value conversion.

import { describe, it, expect } from "@jest/globals";
import { schemaToType, toolSignature, serverStubs, compactSignature, STUB_HEADER } from "../tool-chain/stubs.js";
import { toScriptResult, toScriptValue } from "../tool-chain/results.js";

describe("schemaToType", () => {
  it("maps primitives", () => {
    expect(schemaToType({ type: "string" })).toBe("string");
    expect(schemaToType({ type: "integer" })).toBe("number");
    expect(schemaToType({ type: "number" })).toBe("number");
    expect(schemaToType({ type: "boolean" })).toBe("boolean");
    expect(schemaToType({ type: "null" })).toBe("null");
  });

  it("turns enums into string-literal unions", () => {
    expect(schemaToType({ enum: ["open", "closed"] })).toBe('"open" | "closed"');
    expect(schemaToType({ type: "string", enum: ["a", 1] })).toBe('"a" | 1');
  });

  it("handles const and anyOf/oneOf unions", () => {
    expect(schemaToType({ const: "x" })).toBe('"x"');
    expect(schemaToType({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
    expect(schemaToType({ oneOf: [{ type: "string" }, { type: "string" }] })).toBe("string");
  });

  it("types arrays by item type and parenthesizes unions", () => {
    expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(schemaToType({ type: "array", items: { enum: ["a", "b"] } })).toBe('("a" | "b")[]');
    expect(schemaToType({ type: "array" })).toBe("unknown[]");
  });

  it("expands nested objects with optional fields and quoted keys", () => {
    const schema = {
      type: "object",
      properties: {
        jql: { type: "string" },
        maxResults: { type: "integer" },
        "x-label": { type: "string" },
        filter: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
      },
      required: ["jql", "filter"],
    };
    expect(schemaToType(schema)).toBe(
      '{ jql: string; maxResults?: number; "x-label"?: string; filter: { status: string } }'
    );
  });

  it("stops expanding objects past the depth limit", () => {
    const deep = {
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } },
      },
    };
    expect(schemaToType(deep)).toContain("Record<string, unknown>");
  });

  it("falls back to Record for free-form objects and unknown for missing schemas", () => {
    expect(schemaToType({ type: "object" })).toBe("Record<string, unknown>");
    expect(schemaToType({ type: "object", additionalProperties: { type: "number" } })).toBe("Record<string, number>");
    expect(schemaToType(undefined)).toBe("unknown");
    expect(schemaToType({})).toBe("unknown");
  });
});

describe("toolSignature", () => {
  it("renders a signature with the first sentence as a comment", () => {
    const sig = toolSignature({
      name: "search",
      description: "Search issues by JQL. Returns up to maxResults items.",
      inputSchema: {
        type: "object",
        properties: { jql: { type: "string" }, maxResults: { type: "integer" } },
        required: ["jql"],
      },
    });
    expect(sig).toBe(
      "search(args: { jql: string; maxResults?: number }): Promise<unknown> // Search issues by JQL."
    );
  });

  it("marks each field optional when none is required", () => {
    const sig = toolSignature({
      name: "list",
      description: "List things.",
      inputSchema: { type: "object", properties: { page: { type: "integer" } } },
    });
    expect(sig).toBe("list(args: { page?: number }): Promise<unknown> // List things.");
  });

  it("uses a Record argument type when the tool has no properties", () => {
    const sig = toolSignature({ name: "ping", description: "", inputSchema: { type: "object" } });
    expect(sig).toBe("ping(args: Record<string, unknown>): Promise<unknown>");
  });

  it("quotes tool names that are not identifiers", () => {
    const sig = toolSignature({ name: "get-issue", description: "", inputSchema: {} });
    expect(sig.startsWith('"get-issue"(')).toBe(true);
  });
});

describe("serverStubs", () => {
  it("returns null when there are no tool-chain tools", () => {
    expect(serverStubs("jira", [])).toBeNull();
  });

  it("wraps signatures in a header and a server block", () => {
    const out = serverStubs("jira", [
      { name: "search", description: "Find issues.", inputSchema: {} },
    ]);
    expect(out).not.toBeNull();
    expect(out!.startsWith(STUB_HEADER)).toBe(true);
    expect(out).toContain("// servers.jira");
    expect(out).toContain("jira: {\n  search(args: Record<string, unknown>): Promise<unknown> // Find issues.\n}");
  });
});

describe("toScriptValue", () => {
  it("prefers structuredContent", () => {
    expect(toScriptValue({ content: [{ type: "text", text: "ignored" }], structuredContent: { ok: 1 } })).toEqual({ ok: 1 });
  });

  it("parses a single JSON text block", () => {
    expect(toScriptValue({ content: [{ type: "text", text: '{"a":[1,2]}' }] })).toEqual({ a: [1, 2] });
  });

  it("keeps non-JSON text as a string", () => {
    expect(toScriptValue({ content: [{ type: "text", text: "plain words" }] })).toBe("plain words");
    expect(toScriptValue({ content: [{ type: "text", text: "{not json" }] })).toBe("{not json");
  });

  it("returns an array for several text blocks, parsing each", () => {
    expect(
      toScriptValue({
        content: [
          { type: "text", text: "[1]" },
          { type: "text", text: "two" },
        ],
      })
    ).toEqual([[1], "two"]);
  });

  it("passes non-text blocks through and returns null for empty content", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    expect(toScriptValue({ content: [image] })).toEqual(image);
    expect(toScriptValue({ content: [] })).toBeNull();
  });
});

describe("toScriptResult", () => {
  it("returns the value for a successful result", () => {
    expect(toScriptResult({ content: [{ type: "text", text: '{"n":2}' }] })).toEqual({ value: { n: 2 } });
  });

  it("turns isError into an error value with the upstream text", () => {
    const r = toScriptResult({ isError: true, content: [{ type: "text", text: "rate limited" }] });
    expect(r).toEqual({ value: { error: "rate limited" }, failed: true });
  });

  it("uses a fallback message when an error result has no text", () => {
    const r = toScriptResult({ isError: true, content: [] });
    expect(r).toEqual({ value: { error: "tool returned an error with no text" }, failed: true });
  });
});

describe("compactSignature", () => {
  it("shows the argument shape without a description and bounds its length", () => {
    expect(
      compactSignature({
        name: "get_order",
        inputSchema: { type: "object", properties: { id: { type: "string" }, verbose: { type: "boolean" } }, required: ["id"] },
      })
    ).toBe("get_order(args: { id: string; verbose?: boolean })");
    expect(compactSignature({ name: "ping", inputSchema: { type: "object" } })).toBe("ping(args: {})");
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field_${i}`, { type: "string" }])) };
    const long = compactSignature({ name: "wide", inputSchema: wide }, 120);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });
});
