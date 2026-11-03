# Live response benchmark results

## Local fixture run — 2026-11-03

This run used the checked-in deterministic MCP fixture, Node v24.12.0, and 30 iterations per case.
Each upstream response was shared across the `off` and optimized policies. The JSON artifact contains
the full measurements and run metadata: [live-fixture-2026-11-03.json](live-fixture-2026-11-03.json).

| Workload | Policy | Estimated tokens | Reduction | Transform median / p95 | Tool + transform median / p95 | Preservation |
|---|---|---:|---:|---:|---:|---:|
| Large JSON projection | off | 2,107 | 0% | 0.016 / 0.027 ms | 0.198 / 0.374 ms | 30/30 |
| Large JSON projection | project record fields | 147 | 93% | 0.055 / 0.215 ms | 0.246 / 0.467 ms | 30/30 |
| HTML documentation | off | 114 | 0% | 0.008 / 0.015 ms | 0.383 / 1.014 ms | 30/30 |
| HTML documentation | Markdown | 66 | 42.1% | 0.870 / 2.015 ms | 1.244 / 2.839 ms | 30/30 |
| HTML reader mode | off | 84 | 0% | 0.005 / 0.011 ms | 0.142 / 0.309 ms | 30/30 |
| HTML reader mode | reader | 99 | **−17.9%** | 0.174 / 0.393 ms | 0.312 / 1.154 ms | 30/30 |

Token counts are estimates from serialized JSON characters divided by four. Preservation checks passed
for every sample. Reader mode expanded the small fixture response, so these results show that an
optimization policy should be evaluated on representative response sizes. The fixture run validates
the live MCP and measurement path; it does not represent external service latency or model task
success.

Reproduce it from the repository root:

```bash
npm run build
node dist/index.js benchmark \
  --responses-live \
  --cases src/__tests__/fixtures/live-benchmark-cases.json \
  --config src/__tests__/fixtures/live-benchmark-servers.json \
  --iterations 30
```
