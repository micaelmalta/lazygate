import {
  isUsageEvent,
  recommendOptimizationPolicies,
  summarizeUsage,
  type AuditedEvent,
} from "../gateway/audit.js";

const calls = (count: number, row: Partial<AuditedEvent>): AuditedEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    ts: `2026-11-03T12:00:${String(i).padStart(2, "0")}.000Z`,
    user: "alice",
    session: "s1",
    tool: "call_tool",
    ok: true,
    ms: 100,
    ...row,
  }));

describe("usage-based optimization recommendations", () => {
  it("suggests adaptive for large unoptimized responses once there is enough evidence", () => {
    const recs = recommendOptimizationPolicies([
      ...calls(5, { server: "jira", target: "search", originalTokens: 6000 }),
      ...calls(4, { server: "jira", target: "get", originalTokens: 9000 }),
      ...calls(6, { server: "notes", target: "read", originalTokens: 300 }),
    ]);
    expect(recs).toEqual([
      expect.objectContaining({
        tool: "jira.search",
        action: "enable_adaptive",
        reason: "large_unoptimized_responses",
        suggestedPolicy: { mode: "adaptive" },
        calls: 5,
      }),
    ]);
  });

  it("flags frequent fallbacks, high overhead, and policies that save nothing", () => {
    const recs = recommendOptimizationPolicies([
      ...calls(4, { server: "a", target: "flaky", optimizationMode: "schema", optimizationFallback: true, originalTokens: 100, savedTokens: 0 }),
      ...calls(2, { server: "a", target: "flaky", optimizationMode: "schema", originalTokens: 100, savedTokens: 80 }),
      ...calls(5, { server: "a", target: "slow", optimizationMode: "prune", optimizationDurationMs: 90, ms: 100, originalTokens: 100, savedTokens: 50 }),
      ...calls(5, { server: "a", target: "useless", optimizationMode: "prune", optimizationDurationMs: 1, originalTokens: 1000, savedTokens: 10 }),
    ]);
    const byTool = Object.fromEntries(recs.map((r) => [r.tool, r]));
    expect(byTool["a.flaky"]).toMatchObject({ action: "review_policy", reason: "frequent_fallbacks" });
    expect(byTool["a.slow"]).toMatchObject({ action: "review_policy", reason: "overhead_high" });
    expect(byTool["a.useless"]).toMatchObject({ action: "disable", reason: "no_savings", suggestedPolicy: { mode: "off" } });
  });

  it("pins a stable adaptive choice, drops adaptive that never selects, and notices agent field requests", () => {
    const recs = recommendOptimizationPolicies([
      ...calls(5, { server: "b", target: "stable", optimizationMode: "adaptive", optimizationSelectedMode: "prune", originalTokens: 500, savedTokens: 100 }),
      ...calls(5, { server: "b", target: "idle", optimizationMode: "adaptive", optimizationSelectedMode: "off", originalTokens: 500, savedTokens: 0 }),
      ...calls(6, { server: "b", target: "fields", optimizationMode: "project", optimizationIntent: "fields", originalTokens: 4000, savedTokens: 3000 }),
      ...calls(5, { server: "b", target: "failed", ok: false, originalTokens: 9000 }),
    ]);
    const byTool = Object.fromEntries(recs.map((r) => [r.tool, r]));
    expect(byTool["b.stable"]).toMatchObject({
      action: "pin_mode",
      suggestedPolicy: expect.objectContaining({ mode: "prune", removeNulls: true }),
    });
    expect(byTool["b.idle"]).toMatchObject({ action: "disable", reason: "adaptive_never_selected" });
    expect(byTool["b.fields"]).toMatchObject({ action: "add_projection", reason: "agents_request_fields" });
    expect(byTool["b.failed"]).toBeUndefined();
  });

  it("is included in the usage summary", () => {
    const s = summarizeUsage(calls(5, { server: "jira", target: "search", originalTokens: 6000 }));
    expect(s.recommendations).toHaveLength(1);
  });

  it("flags tools whose reduced responses are usually read back with get_result", () => {
    const reduced = (target: string, selected: string) =>
      calls(6, {
        server: "c", target, optimizationMode: "adaptive", optimizationSelectedMode: selected,
        originalTokens: 9000, savedTokens: 8000, optimizationComplete: false, resultHandleOffered: true,
      });
    const reads = (source: string, count: number) =>
      calls(count, { tool: "get_result", server: "c", resultHandleSource: source, originalTokens: 2000 });
    const events = [
      ...reduced("summarized", "schema"),
      ...reads("c.summarized", 4),
      ...reduced("trimmed", "prune"),
      ...reads("c.trimmed", 2),
      ...reduced("fine", "prune"),
      ...reads("c.fine", 1),
    ];
    const byTool = Object.fromEntries(recommendOptimizationPolicies(events).map((r) => [r.tool, r]));
    expect(byTool["c.summarized"]).toMatchObject({
      action: "review_policy",
      reason: "frequent_result_reads",
      calls: 6,
      suggestedPolicy: { mode: "adaptive", allowSummary: false },
    });
    expect(byTool["c.trimmed"]).toMatchObject({ reason: "frequent_result_reads" });
    expect(byTool["c.trimmed"]!.suggestedPolicy).toBeUndefined();
    expect(byTool["c.fine"]?.reason).not.toBe("frequent_result_reads");

    const summary = summarizeUsage(events);
    expect(summary).toMatchObject({ resultHandleOffers: 18, resultHandleReads: 7, resultHandleReadRate: 39 });
  });
});

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

  it("aggregates optimization overhead, fallback, and incomplete rates without counting legacy rows", () => {
    const events: AuditedEvent[] = [
      {
        ts: "2026-11-03T12:00:02.000Z",
        user: "alice",
        session: "s1",
        tool: "call_tool",
        server: "jira",
        target: "search",
        ok: true,
        optimizationMode: "adaptive",
        optimizationSelectedMode: "project",
        optimizationDurationMs: 8,
        optimizationFallback: false,
        optimizationComplete: false,
      },
      {
        ts: "2026-11-03T12:00:01.000Z",
        user: "alice",
        session: "s1",
        tool: "call_tool",
        server: "jira",
        target: "get",
        ok: true,
        optimizationMode: "adaptive",
        optimizationSelectedMode: "off",
        optimizationDurationMs: 12,
        optimizationFallback: true,
        optimizationComplete: true,
      },
      {
        ts: "2026-11-03T12:00:00.000Z",
        user: "alice",
        session: "s1",
        tool: "list_active_servers",
        ok: true,
      },
    ];

    const s = summarizeUsage(events);
    expect(s.optimizationCalls).toBe(2);
    expect(s.optimizationFallbacks).toBe(1);
    expect(s.optimizationFallbackRate).toBe(50);
    expect(s.optimizationIncompleteCalls).toBe(1);
    expect(s.optimizationIncompleteRate).toBe(50);
    expect(s.optimizationDurationMs).toBe(20);
    expect(s.averageOptimizationDurationMs).toBe(10);
    expect(s.optimizationSelectedModes).toEqual({ project: 1, off: 1 });
    expect(s.byServer[0]).toMatchObject({
      optimizationCalls: 2,
      optimizationFallbacks: 1,
      optimizationFallbackRate: 50,
      optimizationIncompleteCalls: 1,
      optimizationIncompleteRate: 50,
      optimizationDurationMs: 20,
      averageOptimizationDurationMs: 10,
      optimizationSelectedModes: { project: 1, off: 1 },
    });
  });
});
