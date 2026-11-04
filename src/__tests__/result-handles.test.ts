import { describe, expect, it } from "@jest/globals";
import { ResultHandleStore, selectResultFields } from "../result-handles.js";

describe("result handles", () => {
  it("selects requested fields through nested arrays", () => {
    const source = {
      issues: [
        { id: 1, title: "First", privateNote: "do not return" },
        { id: 2, title: "Second", privateNote: "also omit" },
      ],
      cursor: "next-page",
    };

    expect(selectResultFields(source, ["issues.id", "issues.title"])).toEqual({
      issues: [{ id: 1, title: "First" }, { id: 2, title: "Second" }],
    });
  });

  it("rejects prototype access and malformed paths", () => {
    const source = { safe: { value: 1 } };
    expect(() => selectResultFields(source, ["safe.__proto__.value"])).toThrow(/unsafe field path/);
    expect(() => selectResultFields(source, ["safe..value"])).toThrow(/invalid field path/);
  });

  it("expires stored results and keeps handles private to one store", () => {
    let now = 1000;
    const first = new ResultHandleStore({ ttlMs: 50, now: () => now });
    const other = new ResultHandleStore({ ttlMs: 50, now: () => now });
    const stored = first.create({ issues: [{ id: 1, title: "A" }] });
    expect(stored).not.toBeNull();
    expect(first.get(stored!.handle)).toEqual({ issues: [{ id: 1, title: "A" }] });
    expect(other.get(stored!.handle)).toBeUndefined();

    now += 51;
    expect(first.get(stored!.handle)).toBeUndefined();
  });

  it("evicts oldest entries to respect count and byte limits and rejects oversized entries", () => {
    const store = new ResultHandleStore({ maxEntries: 2, maxBytes: 64, maxEntryBytes: 40 });
    const first = store.create({ value: "a" });
    const second = store.create({ value: "b" });
    const third = store.create({ value: "c" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(store.get(first!.handle)).toBeUndefined();
    expect(store.get(second!.handle)).toEqual({ value: "b" });
    expect(store.get(third!.handle)).toEqual({ value: "c" });
    expect(store.create({ value: "x".repeat(100) })).toBeNull();
  });
});
