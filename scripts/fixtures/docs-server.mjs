// Stdio MCP server for the benchmark --tasks fixtures: a versioned refund-policy document.
// get_policy returns the raw HTML page (navigation, tables, code and a historical section), the way a
// documentation server would. The facts come from POLICY_FACTS, so the expected answers and the HTML
// cannot drift apart.
import { serveFixture, textResult, errorResult } from "./fixture-mcp.mjs";
import { EVAL_POLICY_VERSIONS, EVAL_CURRENT_POLICY, POLICY_FACTS, POLICY_RULES } from "./task-data.mjs";

const tools = [
  {
    name: "list_policies",
    description: "List the versions of the refund policy document.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_policy",
    description: "Fetch one version of the refund policy as an HTML page.",
    inputSchema: {
      type: "object",
      properties: { version: { type: "string", enum: EVAL_POLICY_VERSIONS } },
      required: ["version"],
    },
  },
];

const nav = `<nav class="site-nav"><ul><li><a href="/">Home</a></li><li><a href="/policies">Policies</a></li>` +
  `<li><a href="/help">Help centre</a></li><li><a href="/contact">Contact</a></li></ul></nav>`;

const footer = `<footer><p>Copyright 2025 Example Retail. All rights reserved. <a href="/legal">Legal</a></p></footer>`;

/** Per-category return windows: the rule a refund's age is checked against. Built from POLICY_RULES. */
function categoryWindowsSection() {
  const rows = Object.entries(POLICY_RULES.windowDays)
    .map(([category, days]) => `<tr><td>${category}</td><td>${days}</td></tr>`)
    .join("\n");
  return `<h2>Category return windows</h2>
<p>A refund is accepted only if the order is within the window for its product category <strong>and</strong> its category is not excluded (see Excluded categories below). An order is eligible when both conditions hold.</p>
<table>
<caption>Return window by category</caption>
<tr><th>Category</th><th>Window (days)</th></tr>
${rows}
</table>`;
}

/** Categories excluded from refunds regardless of age. Built from POLICY_RULES. */
function excludedCategoriesSection() {
  return `<h2>Excluded categories</h2>
<p>Refunds are not accepted for these categories: ${POLICY_RULES.excludedCategories.join(", ")}. An order in an excluded category is refused regardless of its age, even when it is inside the category window.</p>`;
}

/** One version of the policy page. The current version's facts are in the structured sections. */
function policyPage(version) {
  const f = POLICY_FACTS[version];
  const historical = version !== EVAL_CURRENT_POLICY;
  const banner = historical
    ? `<div class="notice">Historical version. Superseded by ${EVAL_CURRENT_POLICY}. Do not apply to new returns.</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Refund policy ${version}</title>
<style>body{font-family:sans-serif} table{border-collapse:collapse} td,th{border:1px solid #ccc;padding:4px}</style></head>
<body>
${nav}
<main>
<article class="policy" data-version="${version}">
<h1>Refund policy (version ${version})</h1>
${banner}
<p>This page describes how refunds are accepted for online orders. Read the sections below in full.</p>

<h2>Return window</h2>
<p>Refund requests must be submitted within <strong>${f.returnWindowDays} days</strong> of the order date, unless the product category sets a different window.</p>

<h2>Restocking fee</h2>
<p>Accepted refunds are charged a restocking fee of <code>feeBasisPoints</code> basis points on the refunded amount.</p>

<table>
<caption>Policy parameters</caption>
<tr><th>Parameter</th><th>Value</th></tr>
<tr><td>Return window (days)</td><td>${f.returnWindowDays}</td></tr>
<tr><td>Restocking fee (basis points)</td><td>${f.feeBasisPoints}</td></tr>
<tr><td>Minimum purchase (cents)</td><td>${f.minPurchaseCents}</td></tr>
</table>

<h2>Minimum purchase</h2>
<p>Only purchases of at least <em>${f.minPurchaseCents}</em> cents are refundable under this policy.</p>

${historical ? "" : categoryWindowsSection()}

<h2>Exceptions</h2>
<p>The following exceptions apply regardless of the return window. There are ${f.exceptionCount} exception categories in this version${historical ? "" : ", listed under Excluded categories below"}.</p>
<ol>
${Array.from({ length: f.exceptionCount }, (_, i) => `<li>Exception ${i + 1}: items that are perishable or made to order are not refundable.</li>`).join("\n")}
</ol>
${historical ? "" : excludedCategoriesSection()}

<pre><code>{ "policy": "${version}", "source": "refund-policy" }</code></pre>

${historical ? "" : `<section class="archive"><h2>Previous versions</h2><p>See the 2024-01 page for the earlier return window.</p></section>`}
</article>
</main>
${footer}
</body>
</html>
`;
}

serveFixture({
  name: "docs",
  tools,
  run(name, args) {
    if (name === "list_policies") {
      return textResult(EVAL_POLICY_VERSIONS.map((version) => ({ version, current: version === EVAL_CURRENT_POLICY })));
    }
    if (name === "get_policy") {
      if (!EVAL_POLICY_VERSIONS.includes(args.version)) return errorResult(`no policy version ${args.version}`);
      // Raw HTML, not JSON: the page is the value, so html_markdown can convert it as a string.
      return { content: [{ type: "text", text: policyPage(args.version) }] };
    }
    return errorResult(`unknown tool ${name}`);
  },
});
