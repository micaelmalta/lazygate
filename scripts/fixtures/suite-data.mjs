// Deterministic datasets and expected answers for the benchmark suite (`lazygate benchmark --suite`).
// Shared by the fixture MCP server and the runner, so a task's correct answer is computed once,
// independently of any strategy.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── single lookup ────────────────────────────────────────────────────────────
export const ORDER_STATUSES = ["processing", "shipped", "delivered", "returned"];
export function orderRecord(id) {
  const n = Number(String(id).replace(/\D/g, "")) || 0;
  return {
    id,
    status: ORDER_STATUSES[n % ORDER_STATUSES.length],
    carrier: "Acme Freight",
    eta: "2026-11-09",
    history: [
      { at: "2026-11-01T09:00:00Z", event: "created" },
      { at: "2026-11-02T14:30:00Z", event: "packed" },
    ],
  };
}

// ── dependent chain ──────────────────────────────────────────────────────────
export const TICKET_COUNT = 40;
export const TICKETS = Array.from({ length: TICKET_COUNT }, (_, i) => ({
  id: `TKT-${String(i + 1).padStart(3, "0")}`,
  status: i % 4 === 1 ? "closed" : i % 4 === 2 ? "blocked" : "open",
  assignee: ["ana", "ben", "cy"][i % 3],
  points: (i % 5) + 1,
  title: `Ticket ${i + 1}`,
  body: `Detailed description and discussion for ticket ${i + 1}. `.repeat(70),
}));

// ── parallel independent calls ───────────────────────────────────────────────
export const REGIONS = ["us-east", "us-west", "eu-west", "eu-central", "ap-south", "ap-east", "sa-east", "af-south"];
export const REGION_DELAY_MS = 40;
export function regionMetric(region) {
  const index = REGIONS.indexOf(region);
  return { region, requests: 10_000 + index * 1_375, errors: index * 3, p95Ms: 120 + index * 7 };
}

// ── large JSON aggregation ───────────────────────────────────────────────────
export const EVENT_COUNT = 1_000;
export const EVENTS = (() => {
  const random = mulberry32(7);
  const services = ["api", "billing", "search"];
  return Array.from({ length: EVENT_COUNT }, (_, id) => {
    const roll = random();
    const level = roll < 0.1 ? "error" : roll < 0.3 ? "warn" : "info";
    return {
      id,
      ts: `2026-11-03T${String(Math.floor(id / 60) % 24).padStart(2, "0")}:${String(id % 60).padStart(2, "0")}:00Z`,
      service: services[id % services.length],
      level,
      latency_ms: Math.floor(random() * 2000) + 5,
      message: `request ${id} handled by worker-${id % 17} with status ${level === "error" ? 500 : 200}`,
      trace: { id: `tr-${id.toString(16).padStart(6, "0")}`, spans: 3 + (id % 5), sampled: id % 7 === 0 },
      tags: ["prod", `shard-${id % 8}`],
    };
  });
})();

// ── HTML documentation ───────────────────────────────────────────────────────
export const DOC_KEY = "request_timeout";
export const DOC_DEFAULT = "30s";
export const DOC_HTML = (() => {
  const nav = Array.from({ length: 120 }, (_, i) => `<li><a href="/docs/section-${i}">Navigation section ${i}</a></li>`).join("");
  const rows = Array.from({ length: 36 }, (_, i) => {
    const key = i === 11 ? DOC_KEY : `option_${i}`;
    const value = i === 11 ? DOC_DEFAULT : `${i * 5}`;
    return `<tr><td><code>${key}</code></td><td>${value}</td><td>Controls the ${key.replace("_", " ")} behaviour of the client. ${"See the guide for details. ".repeat(3)}</td></tr>`;
  }).join("");
  return (
    `<!doctype html><html><head><title>Client configuration</title><style>${".hidden{display:none}.nav a{color:#06c}".repeat(120)}</style>` +
    `<script>${"window.__tracker=window.__tracker||[];".repeat(150)}</script></head><body>` +
    `<nav class="nav"><ul>${nav}</ul></nav><main><h1>Client configuration</h1>` +
    `<p>${"Configuration is read from the environment and a config file. ".repeat(20)}</p>` +
    `<table><thead><tr><th>Option</th><th>Default</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></main>` +
    `<footer>${"Footer links and legal notices. ".repeat(40)}</footer></body></html>`
  );
})();

// ── expected answers ─────────────────────────────────────────────────────────
const ana = TICKETS.filter((t) => t.status === "open" && t.assignee === "ana");
const errors = EVENTS.filter((e) => e.level === "error");

export const EXPECTED = {
  single_lookup: { orderId: "ORD-0042", status: orderRecord("ORD-0042").status },
  dependent_chain: { count: ana.length, points: ana.reduce((sum, t) => sum + t.points, 0) },
  parallel_calls: { requests: REGIONS.reduce((sum, r) => sum + regionMetric(r).requests, 0) },
  large_json: {
    errors: errors.length,
    maxErrorLatency: errors.reduce((max, e) => Math.max(max, e.latency_ms), 0),
  },
  html_docs: { value: DOC_DEFAULT },
};
