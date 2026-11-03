import { isUsageEvent, summarizeUsage, type AuditedEvent } from "../gateway/audit.js";

describe("usage summary", () => {
  it("ignores UI admin and security noise", () => {
    expect(isUsageEvent({ user: "a", session: "ui", tool: "token.create", action: "token.create" })).toBe(false);
    expect(isUsageEvent({ user: "-", session: "mcp", tool: "auth.failed", action: "auth.failed" })).toBe(false);
    expect(isUsageEvent({ user: "a", session: "abc-123", tool: "call_tool", server: "jira" })).toBe(true);
  });

  it("aggregates calls and token estimates", () => {
    const events: AuditedEvent[] = [
      {
        ts: "2026-11-03T12:00:02.000Z",
        user: "alice",
        session: "s1",
        tool: "call_tool",
        server: "jira",
        target: "search",
        ok: true,
        originalTokens: 100,
        optimizedTokens: 40,
        savedTokens: 60,
      },
      {
        ts: "2026-11-03T12:00:01.000Z",
        user: "bob",
        session: "s2",
        tool: "discover_tools",
        ok: true,
        originalTokens: 20,
        optimizedTokens: 20,
        savedTokens: 0,
      },
      {
        ts: "2026-11-03T12:00:00.000Z",
        user: "alice",
        session: "s1",
        tool: "call_tool",
        server: "jira",
        target: "get",
        ok: false,
        originalTokens: 10,
        optimizedTokens: 10,
        savedTokens: 0,
      },
      {
        ts: "2026-11-03T11:59:00.000Z",
        user: "root",
        session: "ui",
        tool: "secret.set",
        action: "secret.set",
        ok: true,
      },
    ];
    const s = summarizeUsage(events, 5);
    expect(s.calls).toBe(3);
    expect(s.ok).toBe(2);
    expect(s.error).toBe(1);
    expect(s.originalTokens).toBe(130);
    expect(s.optimizedTokens).toBe(70);
    expect(s.savedTokens).toBe(60);
    expect(s.reductionPercent).toBe(46);
    expect(s.byServer[0]).toMatchObject({ key: "jira", calls: 2, savedTokens: 60 });
    expect(s.byTool.map((t) => t.key)).toEqual(["jira/search", "discover_tools", "jira/get"]);
    expect(s.byUser[0].key).toBe("alice");
    expect(s.from).toBe("2026-11-03T12:00:00.000Z");
    expect(s.to).toBe("2026-11-03T12:00:02.000Z");
  });
});
