// Deterministic datasets behind the benchmark --tasks fixture servers. The servers and the
// benchmark's expected answers both read from here, so a task's correct answer is computed, not typed.

// ── tickets ────────────────────────────────────────────────────────────────
export const TICKET_COUNT = 48;
/** ~30 chars × repeats ≈ body size; 8 hits × ~7.5 KiB ≈ 60 KiB of intermediate text. */
export const BODY_REPEATS = 250;

export const TICKETS = Array.from({ length: TICKET_COUNT }, (_, i) => {
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

// ── orders ─────────────────────────────────────────────────────────────────
export const ORDER_COUNT = 48;
export const LINES_PER_ORDER = 90;

export const ORDERS = Array.from({ length: ORDER_COUNT }, (_, i) => {
  const id = `ORD-${String(i + 1).padStart(3, "0")}`;
  const status = ["refunded", "paid", "refunded", "pending"][i % 4];
  return {
    id,
    customer: ["acme", "globex", "initech"][i % 3],
    status,
    totalCents: 10_000 + i * 175,
    // Only get_order returns these: the lines are the bulk, refundCents the number a task needs.
    lines: Array.from({ length: LINES_PER_ORDER }, (_, n) => ({
      sku: `SKU-${i}-${n}`,
      qty: 1 + ((i + n) % 4),
      note: `Warehouse pick instruction for line ${n} of ${id}.`,
    })),
    refundCents: status === "refunded" ? 1_000 + (i % 7) * 250 : 0,
  };
});

// ── logs ───────────────────────────────────────────────────────────────────
export const LOG_COUNT = 60;

export const LOG_ENTRIES = Array.from({ length: LOG_COUNT }, (_, i) => {
  const id = `LOG-${String(i + 1).padStart(3, "0")}`;
  const frames = 60 + (i % 9) * 10;
  return {
    id,
    level: ["INFO", "ERROR", "WARN", "ERROR"][i % 4],
    service: ["billing", "search", "auth"][i % 3],
    ts: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    stack: Array.from({ length: frames }, (_, n) => `    at handler${n} (/srv/app/${id}.js:${n + 1}:${(n * 7) % 40})`).join("\n"),
    stackFrames: frames,
  };
});

// ── expected answers ───────────────────────────────────────────────────────
export function expectedTickets() {
  const hits = TICKETS.filter((t) => t.status === "open" && t.assignee === "ana");
  return [hits.length, hits.reduce((sum, t) => sum + t.body.length, 0)];
}

export function expectedOrders() {
  const hits = ORDERS.filter((o) => o.customer === "acme" && o.status === "refunded");
  return [hits.length, hits.reduce((sum, o) => sum + o.refundCents, 0)];
}

export function expectedLogs() {
  const hits = LOG_ENTRIES.filter((e) => e.service === "billing" && e.level === "ERROR");
  return [hits.length, hits.reduce((sum, e) => sum + e.stackFrames, 0)];
}

export function expectedCross() {
  return [expectedTickets()[0], expectedOrders()[1]];
}
