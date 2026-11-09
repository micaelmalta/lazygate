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

// ── refund-evaluation orders (JSON aggregation + cross-server policy) ───────
// Separate from ORDERS so the existing orders task and its published results keep their data.
// Each order carries a category and an age, which the policy uses; refundCents is only returned by
// get_order (list rows omit it), so every candidate needs a detail fetch.
export const EVAL_ORDER_COUNT = 40;
export const EVAL_POLICY_VERSIONS = ["2024-01", "2025-06"];
/** The version an agent is told to apply (the other one is a historical document). */
export const EVAL_CURRENT_POLICY = "2025-06";
export const EVAL_CATEGORIES = ["electronics", "apparel", "grocery", "books"];

export const EVAL_ORDERS = Array.from({ length: EVAL_ORDER_COUNT }, (_, i) => {
  const id = `RFD-${String(i + 1).padStart(3, "0")}`;
  const status = ["refunded", "refunded", "paid", "refunded", "pending"][i % 5];
  const category = EVAL_CATEGORIES[(i * 3) % EVAL_CATEGORIES.length];
  // Ages cycle through the return window boundaries used by the policy (see POLICY_RULES below).
  const ageDays = [3, 14, 29, 31, 45, 60, 90, 7][i % 8];
  const lineCount = 40 + (i % 5) * 10;
  return {
    id,
    customer: i % 2 === 0 ? "acme" : "globex",
    status,
    category,
    ageDays,
    // A refund amount the list never shows; optional on some rows (null means "no refund recorded").
    refundCents: status === "refunded" ? 800 + ((i * 137) % 9) * 125 : null,
    lines: Array.from({ length: lineCount }, (_, n) => ({
      sku: `EV-${i}-${n}`,
      qty: 1 + ((i + n) % 3),
      note: `Packing note ${n} for ${id}; irrelevant to refunds.`,
    })),
  };
});

/**
 * The policy in its effective (current) version. A refund is eligible when the order was refunded,
 * is within the return window for its category, and is not excluded by the policy exceptions.
 */
export const POLICY_RULES = {
  // Days after purchase within which a refund is accepted, per category.
  windowDays: { electronics: 30, apparel: 45, grocery: 7, books: 60 },
  // Categories excluded regardless of age: the 2025-06 exception list. Its length is the policy's
  // exceptionCount, so the page's count and its exclusion rule describe the same set.
  excludedCategories: ["grocery", "electronics", "books"],
};

const within = (o) => o.ageDays <= POLICY_RULES.windowDays[o.category];
const excluded = (o) => POLICY_RULES.excludedCategories.includes(o.category);

export function policyEligible(o) {
  return o.status === "refunded" && within(o) && !excluded(o);
}

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

/**
 * JSON aggregation: how many refunded evaluation orders there are and their total refundCents.
 * Only get_order carries refundCents, so the answer cannot be read from list results.
 */
export function expectedRefundAggregate() {
  const hits = EVAL_ORDERS.filter((o) => o.status === "refunded");
  return [hits.length, hits.reduce((sum, o) => sum + o.refundCents, 0)];
}

/**
 * Cross-server policy evaluation: how many refunded evaluation orders are eligible under the
 * current policy, and their total refundCents. Eligibility depends on the policy document's
 * rules (window and exceptions), so the policy has to be fetched and read.
 */
export function expectedPolicyEligible() {
  const hits = EVAL_ORDERS.filter(policyEligible);
  return [hits.length, hits.reduce((sum, o) => sum + o.refundCents, 0)];
}

/**
 * HTML extraction: the four integers the current policy document states. Each fact is spread over
 * a heading, a table and an exception paragraph; the historical section states outdated values.
 */
export function expectedPolicyFacts() {
  const current = POLICY_FACTS[EVAL_CURRENT_POLICY];
  return [current.returnWindowDays, current.feeBasisPoints, current.minPurchaseCents, current.exceptionCount];
}

/**
 * Policy facts per version. The document for EVAL_CURRENT_POLICY is what an agent must read;
 * the older version is shipped in the same server as a historical reference and carries different
 * numbers, so an agent that reads the wrong section answers wrong.
 */
// Invariant (tested): the current policy's exceptionCount equals its excluded-category count.
export const POLICY_FACTS = {
  "2024-01": { returnWindowDays: 14, feeBasisPoints: 500, minPurchaseCents: 2500, exceptionCount: 2 },
  "2025-06": { returnWindowDays: 30, feeBasisPoints: 250, minPurchaseCents: 1000, exceptionCount: 3 },
};
