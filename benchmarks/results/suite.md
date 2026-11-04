# LazyGate benchmark suite

Generated 2026-11-04T20:09:14.114Z on Node v24.12.0 (darwin-arm64, 14 CPUs). Tokenizer `o200k_base`, 15 timed rounds after 1 warm-up, seed 1; lazygate lookup mode `cold`.

Scripted oracle agent against real MCP traffic: it always issues a correct call or script, so these numbers show what each strategy costs and whether the answer survives, not how a model behaves. Turn counts and tokens are reproducible (result-handle ids add a few tokens of jitter); tool latency varies by machine. Everything labeled "modeled", "effective" or "exp." is a model with stated assumptions (see Method), not a measurement.

## Catalog of 20 tools

Direct MCP carries 1,726 schema tokens per turn (86.3 tokens per tool on average).

| Workload | Strategy | Correct | Turns | Input tokens | vs direct | Effective input | Context tokens | Tool ms p50 [min–max] | Model ms (assumed) | Modeled ms | Exp. turns† | Exp. ms† |
|---|---|:-:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | direct | yes | 2 | 3,676 | — | 2,515 | 1,830 | 48.1 [46.7–76.9] | 3,074 | 3,122 | — | — |
| Single known tool | direct_capped | yes | 2 | 3,676 | 0% | 2,515 (0%) | 1,830 | 47.8 [46.3–102.3] | 3,074 | 3,121 | — | — |
| Single known tool | call_tool | yes | 4 | 5,913 | +61% | 2,824 (+12%) | 1,616 | 48.3 [46.9–85.4] | 6,118 | 6,167 | 4.03 | 6,205 |
| Single known tool | call_tool_opt | yes | 4 | 5,849 | +59% | 2,760 (+10%) | 1,552 | 48 [46.7–53.1] | 6,117 | 6,165 | 4.03 | 6,203 |
| Single known tool | run_chain | yes | 4 | 6,220 | +69% | 3,131 (+24%) | 1,743 | 52.3 [49.5–75.7] | 6,124 | 6,177 | 4.03 | 6,215 |
| Single known tool | pinned | yes | 2 | 3,100 | -16% | 2,126 (-15%) | 1,542 | 47 [46–131.3] | 3,062 | 3,109 | 2 | 3,109 |
| Multi-step dependent chain | direct | yes | 3 | 11,754 | — | 8,986 | 7,676 | 48 [47–81.6] | 4,735 | 4,783 | — | — |
| Multi-step dependent chain | direct_capped | yes | 3 | 11,754 | 0% | 8,986 (0%) | 7,676 | 47.7 [46.8–83.9] | 4,735 | 4,783 | — | — |
| Multi-step dependent chain | call_tool | yes | 5 | 14,546 | +24% | 10,322 (+15%) | 7,756 | 48.6 [47.4–105.1] | 7,791 | 7,840 | 5.03 | 7,879 |
| Multi-step dependent chain | call_tool_opt | yes | 5 | 11,060 | -6% | 6,836 (-24%) | 4,270 | 58.4 [56.3–75.2] | 7,721 | 7,780 | 5.03 | 7,819 |
| Multi-step dependent chain | run_chain | yes | 4 | 6,533 | -44% | 3,444 (-62%) | 1,898 | 54.4 [52.4–94.8] | 6,131 | 6,185 | 4.03 | 6,223 |
| Multi-step dependent chain | pinned | yes | 3 | 10,890 | -7% | 8,568 (-5%) | 7,388 | 47.8 [46.5–83.8] | 4,718 | 4,766 | 3 | 4,766 |
| Parallel independent calls | direct | yes | 2 | 3,952 | — | 2,791 | 2,106 | 89.1 [87.4–108.5] | 3,079 | 3,168 | — | — |
| Parallel independent calls | direct_capped | yes | 2 | 3,952 | 0% | 2,791 (0%) | 2,106 | 88.8 [86.8–137.9] | 3,079 | 3,168 | — | — |
| Parallel independent calls | call_tool | yes | 4 | 6,768 | +71% | 3,679 (+32%) | 2,155 | 89.9 [88.1–120.5] | 6,135 | 6,225 | 4.03 | 6,263 |
| Parallel independent calls | call_tool_opt | yes | 4 | 6,686 | +69% | 3,597 (+29%) | 2,073 | 92.6 [90.8–108.5] | 6,134 | 6,226 | 4.03 | 6,264 |
| Parallel independent calls | run_chain | yes | 4 | 6,691 | +69% | 3,602 (+29%) | 1,940 | 93.6 [90.8–150.4] | 6,134 | 6,227 | 4.03 | 6,265 |
| Parallel independent calls | pinned | yes | 2 | 3,376 | -15% | 2,402 (-14%) | 1,818 | 88.9 [87.5–114.6] | 3,068 | 3,156 | 2 | 3,156 |
| Large JSON aggregation | direct | yes | 2 | 87,010 | — | 85,849 | 85,164 | 50.6 [49.2–85.3] | 4,740 | 4,791 | — | — |
| Large JSON aggregation | direct_capped | **no** (0/15) | 2 | 28,142 | -68% | 26,981 (-69%) | 26,296 | 50.2 [49.5–105.1] | 3,563 | 3,613 | — | — |
| Large JSON aggregation | call_tool | yes | 4 | 89,202 | +3% | 86,113 (+0%) | 84,925 | 53.2 [50.7–77.4] | 7,784 | 7,837 | 4.03 | 7,886 |
| Large JSON aggregation | call_tool_opt | yes | 4 | 17,529 | -80% | 14,440 (-83%) | 13,252 | 91.5 [86.9–136.6] | 6,351 | 6,442 | 4.03 | 6,482 |
| Large JSON aggregation | run_chain | yes | 4 | 6,282 | -93% | 3,193 (-96%) | 1,795 | 57.8 [56.1–83.7] | 6,126 | 6,183 | 4.03 | 6,221 |
| Large JSON aggregation | pinned | yes | 4 | 90,150 | +4% | 86,480 (+1%) | 85,162 | 51.2 [50.2–87] | 7,803 | 7,854 | 4.03 | 7,903 |
| HTML documentation retrieval | direct | yes | 2 | 11,714 | — | 10,553 | 9,868 | 47.8 [46.7–76.8] | 3,234 | 3,282 | — | — |
| HTML documentation retrieval | direct_capped | yes | 2 | 11,714 | 0% | 10,553 (0%) | 9,868 | 50.1 [46.4–90.1] | 3,234 | 3,284 | — | — |
| HTML documentation retrieval | call_tool | yes | 4 | 13,882 | +19% | 10,793 (+2%) | 9,622 | 48 [46.2–79.4] | 6,278 | 6,326 | 4.03 | 6,365 |
| HTML documentation retrieval | call_tool_opt | yes | 4 | 9,609 | -18% | 6,520 (-38%) | 5,349 | 52.2 [50.5–93.5] | 6,192 | 6,244 | 4.03 | 6,283 |
| HTML documentation retrieval | run_chain | yes | 4 | 6,276 | -46% | 3,187 (-70%) | 1,809 | 52 [49.5–69.4] | 6,126 | 6,178 | 4.03 | 6,216 |
| HTML documentation retrieval | pinned | yes | 4 | 14,830 | +27% | 11,160 (+6%) | 9,859 | 47.7 [46.7–58.3] | 6,297 | 6,344 | 4.03 | 6,383 |

† lazygate strategies only: adds the held-out wrong-tool rate × retry turns for runs that used `discover_tools` (a modeled penalty).

- Single known tool: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Multi-step dependent chain: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `pinned`
- Parallel independent calls: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Large JSON aggregation: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `direct`
- HTML documentation retrieval: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `direct`

## Catalog of 100 tools

Direct MCP carries 9,818 schema tokens per turn (98.2 tokens per tool on average).

| Workload | Strategy | Correct | Turns | Input tokens | vs direct | Effective input | Context tokens | Tool ms p50 [min–max] | Model ms (assumed) | Modeled ms | Exp. turns† | Exp. ms† |
|---|---|:-:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | direct | yes | 2 | 19,860 | — | 13,439 | 9,922 | 47.1 [46.8–117.1] | 3,397 | 3,444 | — | — |
| Single known tool | direct_capped | yes | 2 | 19,860 | 0% | 13,439 (0%) | 9,922 | 47.3 [46.6–82.6] | 3,397 | 3,445 | — | — |
| Single known tool | call_tool | yes | 4 | 5,913 | -70% | 2,824 (-79%) | 1,616 | 48.6 [47.6–86.5] | 6,118 | 6,167 | 4.03 | 6,205 |
| Single known tool | call_tool_opt | yes | 4 | 5,849 | -71% | 2,760 (-79%) | 1,552 | 49.1 [47.9–81] | 6,117 | 6,166 | 4.03 | 6,204 |
| Single known tool | run_chain | yes | 4 | 6,220 | -69% | 3,131 (-77%) | 1,743 | 51.3 [37.3–74.5] | 6,124 | 6,176 | 4.03 | 6,214 |
| Single known tool | pinned | yes | 2 | 3,100 | -84% | 2,126 (-84%) | 1,542 | 36.5 [33.7–70.4] | 3,062 | 3,099 | 2 | 3,099 |
| Multi-step dependent chain | direct | yes | 3 | 36,030 | — | 20,719 | 15,768 | 51.7 [48.7–124.2] | 5,221 | 5,272 | — | — |
| Multi-step dependent chain | direct_capped | yes | 3 | 36,030 | 0% | 20,719 (0%) | 15,768 | 48.8 [34–80.6] | 5,221 | 5,269 | — | — |
| Multi-step dependent chain | call_tool | yes | 5 | 15,090 | -58% | 10,866 (-48%) | 7,892 | 35.7 [34–45.1] | 7,802 | 7,838 | 5.03 | 7,877 |
| Multi-step dependent chain | call_tool_opt | yes | 5 | 11,612 | -68% | 7,388 (-64%) | 4,414 | 42.7 [41–51.5] | 7,732 | 7,775 | 5.03 | 7,814 |
| Multi-step dependent chain | run_chain | yes | 4 | 6,941 | -81% | 3,852 (-81%) | 2,034 | 39.5 [37.6–95.7] | 6,139 | 6,178 | 4.03 | 6,216 |
| Multi-step dependent chain | pinned | yes | 3 | 10,890 | -70% | 8,568 (-59%) | 7,388 | 38.4 [34.2–227] | 4,718 | 4,756 | 3 | 4,756 |
| Parallel independent calls | direct | yes | 2 | 20,136 | — | 13,715 | 10,198 | 74.8 [72.6–103.5] | 3,403 | 3,478 | — | — |
| Parallel independent calls | direct_capped | yes | 2 | 20,136 | 0% | 13,715 (0%) | 10,198 | 78.5 [73.9–123.1] | 3,403 | 3,481 | — | — |
| Parallel independent calls | call_tool | yes | 4 | 7,026 | -65% | 3,937 (-71%) | 2,241 | 78.5 [74.4–104.7] | 6,141 | 6,219 | 4.03 | 6,257 |
| Parallel independent calls | call_tool_opt | yes | 4 | 6,944 | -66% | 3,855 (-72%) | 2,159 | 77.7 [76.3–83.7] | 6,139 | 6,217 | 4.03 | 6,255 |
| Parallel independent calls | run_chain | yes | 4 | 6,949 | -65% | 3,860 (-72%) | 2,026 | 78.4 [77–103.2] | 6,139 | 6,217 | 4.03 | 6,255 |
| Parallel independent calls | pinned | yes | 2 | 3,376 | -83% | 2,402 (-82%) | 1,818 | 75.2 [73.5–98] | 3,068 | 3,143 | 2 | 3,143 |
| Large JSON aggregation | direct | yes | 2 | 103,194 | — | 96,773 | 93,256 | 37.3 [36.6–65.5] | 5,064 | 5,101 | — | — |
| Large JSON aggregation | direct_capped | **no** (0/15) | 2 | 44,326 | -57% | 37,905 (-61%) | 34,388 | 36.3 [35.1–37.8] | 3,887 | 3,923 | — | — |
| Large JSON aggregation | call_tool | yes | 4 | 89,202 | -14% | 86,113 (-11%) | 84,925 | 37.9 [35.5–65] | 7,784 | 7,822 | 4.03 | 7,871 |
| Large JSON aggregation | call_tool_opt | yes | 4 | 17,531 | -83% | 14,442 (-85%) | 13,254 | 62.6 [61–90.7] | 6,351 | 6,413 | 4.03 | 6,453 |
| Large JSON aggregation | run_chain | yes | 4 | 6,282 | -94% | 3,193 (-97%) | 1,795 | 40.7 [40.2–57.9] | 6,126 | 6,166 | 4.03 | 6,204 |
| Large JSON aggregation | pinned | yes | 4 | 90,150 | -13% | 86,480 (-11%) | 85,162 | 37.5 [36–50] | 7,803 | 7,841 | 4.03 | 7,890 |
| HTML documentation retrieval | direct | yes | 2 | 27,898 | — | 21,477 | 17,960 | 34.1 [33.3–63.6] | 3,558 | 3,592 | — | — |
| HTML documentation retrieval | direct_capped | yes | 2 | 27,898 | 0% | 21,477 (0%) | 17,960 | 33.1 [31.5–35.8] | 3,558 | 3,591 | — | — |
| HTML documentation retrieval | call_tool | yes | 4 | 13,882 | -50% | 10,793 (-50%) | 9,622 | 35 [33.6–64.8] | 6,278 | 6,313 | 4.03 | 6,352 |
| HTML documentation retrieval | call_tool_opt | yes | 4 | 9,609 | -66% | 6,520 (-70%) | 5,349 | 38.4 [36.3–71] | 6,192 | 6,231 | 4.03 | 6,270 |
| HTML documentation retrieval | run_chain | yes | 4 | 6,276 | -78% | 3,187 (-85%) | 1,809 | 37.5 [35.6–65.5] | 6,126 | 6,163 | 4.03 | 6,201 |
| HTML documentation retrieval | pinned | yes | 4 | 14,830 | -47% | 11,160 (-48%) | 9,859 | 36.6 [32.9–71.3] | 6,297 | 6,333 | 4.03 | 6,372 |

† lazygate strategies only: adds the held-out wrong-tool rate × retry turns for runs that used `discover_tools` (a modeled penalty).

- Single known tool: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Multi-step dependent chain: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `pinned`
- Parallel independent calls: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Large JSON aggregation: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `direct`
- HTML documentation retrieval: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `direct_capped`

## Catalog of 250 tools

Direct MCP carries 25,058 schema tokens per turn (100.2 tokens per tool on average).

| Workload | Strategy | Correct | Turns | Input tokens | vs direct | Effective input | Context tokens | Tool ms p50 [min–max] | Model ms (assumed) | Modeled ms | Exp. turns† | Exp. ms† |
|---|---|:-:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | direct | yes | 2 | 50,340 | — | 34,013 | 25,162 | 33.5 [32.4–35.1] | 4,007 | 4,040 | — | — |
| Single known tool | direct_capped | yes | 2 | 50,340 | 0% | 34,013 (0%) | 25,162 | 34.3 [33.1–78.1] | 4,007 | 4,041 | — | — |
| Single known tool | call_tool | yes | 4 | 6,045 | -88% | 2,956 (-91%) | 1,660 | 33.8 [32–57.3] | 6,121 | 6,155 | 4.03 | 6,193 |
| Single known tool | call_tool_opt | yes | 4 | 5,981 | -88% | 2,892 (-91%) | 1,596 | 35.4 [33–48.5] | 6,120 | 6,155 | 4.03 | 6,193 |
| Single known tool | run_chain | yes | 4 | 6,352 | -87% | 3,263 (-90%) | 1,787 | 37 [35.4–42.6] | 6,127 | 6,164 | 4.03 | 6,202 |
| Single known tool | pinned | yes | 2 | 3,100 | -94% | 2,126 (-94%) | 1,542 | 34.3 [32.5–45.8] | 3,062 | 3,096 | 2 | 3,096 |
| Multi-step dependent chain | direct | yes | 3 | 81,750 | — | 42,817 | 31,008 | 33.5 [32.4–60] | 6,135 | 6,169 | — | — |
| Multi-step dependent chain | direct_capped | yes | 3 | 81,750 | 0% | 42,817 (0%) | 31,008 | 34.1 [32.9–55.5] | 6,135 | 6,169 | — | — |
| Multi-step dependent chain | call_tool | yes | 5 | 15,082 | -82% | 10,858 (-75%) | 7,890 | 35.4 [33.2–37.2] | 7,802 | 7,837 | 5.03 | 7,876 |
| Multi-step dependent chain | call_tool_opt | yes | 5 | 11,608 | -86% | 7,384 (-83%) | 4,416 | 43.7 [40.7–70.9] | 7,732 | 7,776 | 5.03 | 7,815 |
| Multi-step dependent chain | run_chain | yes | 4 | 6,935 | -92% | 3,846 (-91%) | 2,032 | 40 [37.8–70.5] | 6,139 | 6,179 | 4.03 | 6,217 |
| Multi-step dependent chain | pinned | yes | 3 | 10,890 | -87% | 8,568 (-80%) | 7,388 | 34.9 [33.7–53] | 4,718 | 4,753 | 3 | 4,753 |
| Parallel independent calls | direct | yes | 2 | 50,616 | — | 34,289 | 25,438 | 74.9 [73.6–99.8] | 4,012 | 4,087 | — | — |
| Parallel independent calls | direct_capped | yes | 2 | 50,616 | 0% | 34,289 (0%) | 25,438 | 75.1 [73.2–115.6] | 4,012 | 4,087 | — | — |
| Parallel independent calls | call_tool | yes | 4 | 7,050 | -86% | 3,961 (-88%) | 2,249 | 76 [74.6–101.6] | 6,141 | 6,217 | 4.03 | 6,255 |
| Parallel independent calls | call_tool_opt | yes | 4 | 6,968 | -86% | 3,879 (-89%) | 2,167 | 77.3 [75.9–116.9] | 6,139 | 6,217 | 4.03 | 6,255 |
| Parallel independent calls | run_chain | yes | 4 | 6,973 | -86% | 3,884 (-89%) | 2,034 | 79.4 [76.8–120.1] | 6,139 | 6,219 | 4.03 | 6,257 |
| Parallel independent calls | pinned | yes | 2 | 3,376 | -93% | 2,402 (-93%) | 1,818 | 75.3 [71.7–88.8] | 3,068 | 3,143 | 2 | 3,143 |
| Large JSON aggregation | direct | yes | 2 | 133,674 | — | 117,347 | 108,496 | 35.8 [34.1–67] | 5,673 | 5,709 | — | — |
| Large JSON aggregation | direct_capped | **no** (0/15) | 2 | 74,806 | -44% | 58,479 (-50%) | 49,628 | 35.3 [33.9–54.9] | 4,496 | 4,531 | — | — |
| Large JSON aggregation | call_tool | yes | 4 | 89,202 | -33% | 86,113 (-27%) | 84,925 | 36.6 [35.9–80.2] | 7,784 | 7,821 | 4.03 | 7,870 |
| Large JSON aggregation | call_tool_opt | yes | 4 | 17,529 | -87% | 14,440 (-88%) | 13,252 | 63.6 [61–72.4] | 6,351 | 6,414 | 4.03 | 6,454 |
| Large JSON aggregation | run_chain | yes | 4 | 6,282 | -95% | 3,193 (-97%) | 1,795 | 41.7 [40–57.2] | 6,126 | 6,167 | 4.03 | 6,205 |
| Large JSON aggregation | pinned | yes | 4 | 90,150 | -33% | 86,480 (-26%) | 85,162 | 37 [35.3–38.2] | 7,803 | 7,840 | 4.03 | 7,889 |
| HTML documentation retrieval | direct | yes | 2 | 58,378 | — | 42,051 | 33,200 | 34.6 [32.8–69.8] | 4,168 | 4,202 | — | — |
| HTML documentation retrieval | direct_capped | yes | 2 | 58,378 | 0% | 42,051 (0%) | 33,200 | 33.8 [32.2–61.7] | 4,168 | 4,201 | — | — |
| HTML documentation retrieval | call_tool | yes | 4 | 14,008 | -76% | 10,919 (-74%) | 9,664 | 34.8 [33–58.8] | 6,280 | 6,315 | 4.03 | 6,354 |
| HTML documentation retrieval | call_tool_opt | yes | 4 | 9,735 | -83% | 6,646 (-84%) | 5,391 | 38.6 [37.7–53.4] | 6,195 | 6,233 | 4.03 | 6,272 |
| HTML documentation retrieval | run_chain | yes | 4 | 6,402 | -89% | 3,313 (-92%) | 1,851 | 38.2 [36.3–64.3] | 6,128 | 6,166 | 4.03 | 6,204 |
| HTML documentation retrieval | pinned | yes | 4 | 14,956 | -74% | 11,286 (-73%) | 9,901 | 35.8 [33–74.2] | 6,299 | 6,335 | 4.03 | 6,374 |

† lazygate strategies only: adds the held-out wrong-tool rate × retry turns for runs that used `discover_tools` (a modeled penalty).

- Single known tool: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Multi-step dependent chain: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `pinned`
- Parallel independent calls: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Large JSON aggregation: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `direct`
- HTML documentation retrieval: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `direct_capped`

## Catalog of 500 tools

Direct MCP carries 50,495 schema tokens per turn (101 tokens per tool on average).

| Workload | Strategy | Correct | Turns | Input tokens | vs direct | Effective input | Context tokens | Tool ms p50 [min–max] | Model ms (assumed) | Modeled ms | Exp. turns† | Exp. ms† |
|---|---|:-:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | direct | yes | 2 | 101,214 | — | 68,353 | 50,599 | 35 [34.1–54.3] | 5,024 | 5,059 | — | — |
| Single known tool | direct_capped | yes | 2 | 101,214 | 0% | 68,353 (0%) | 50,599 | 34 [33.2–46.7] | 5,024 | 5,058 | — | — |
| Single known tool | call_tool | yes | 4 | 6,309 | -94% | 3,220 (-95%) | 1,748 | 36.5 [35.3–39] | 6,126 | 6,163 | 4.05 | 6,240 |
| Single known tool | call_tool_opt | yes | 4 | 6,245 | -94% | 3,156 (-95%) | 1,684 | 36.9 [35–49.8] | 6,125 | 6,162 | 4.05 | 6,239 |
| Single known tool | run_chain | yes | 4 | 6,616 | -93% | 3,527 (-95%) | 1,875 | 39.6 [38.2–62.6] | 6,132 | 6,172 | 4.05 | 6,249 |
| Single known tool | pinned | yes | 2 | 3,100 | -97% | 2,126 (-97%) | 1,542 | 35.1 [32.7–66.4] | 3,062 | 3,097 | 2 | 3,097 |
| Multi-step dependent chain | direct | yes | 3 | 158,061 | — | 79,701 | 56,445 | 33.6 [32.4–59.2] | 7,661 | 7,695 | — | — |
| Multi-step dependent chain | direct_capped | yes | 3 | 158,061 | 0% | 79,701 (0%) | 56,445 | 34.7 [33.9–44.3] | 7,661 | 7,696 | — | — |
| Multi-step dependent chain | call_tool | yes | 5 | 15,130 | -90% | 10,906 (-86%) | 7,902 | 36.2 [34.7–63.3] | 7,803 | 7,839 | 5.05 | 7,917 |
| Multi-step dependent chain | call_tool_opt | yes | 5 | 11,659 | -93% | 7,435 (-91%) | 4,431 | 43.3 [41.4–77.2] | 7,733 | 7,776 | 5.05 | 7,853 |
| Multi-step dependent chain | run_chain | yes | 4 | 6,971 | -96% | 3,882 (-95%) | 2,044 | 41.5 [39.1–73.1] | 6,139 | 6,181 | 4.05 | 6,258 |
| Multi-step dependent chain | pinned | yes | 3 | 10,890 | -93% | 8,568 (-89%) | 7,388 | 34.7 [33.2–52] | 4,718 | 4,753 | 3 | 4,753 |
| Parallel independent calls | direct | yes | 2 | 101,490 | — | 68,629 | 50,875 | 75.1 [72.3–101.4] | 5,030 | 5,105 | — | — |
| Parallel independent calls | direct_capped | yes | 2 | 101,490 | 0% | 68,629 (0%) | 50,875 | 76.5 [73.6–81.4] | 5,030 | 5,106 | — | — |
| Parallel independent calls | call_tool | yes | 4 | 7,062 | -93% | 3,973 (-94%) | 2,253 | 77.3 [75.8–88.3] | 6,141 | 6,219 | 4.05 | 6,296 |
| Parallel independent calls | call_tool_opt | yes | 4 | 6,980 | -93% | 3,891 (-94%) | 2,171 | 78 [76.7–109.6] | 6,140 | 6,218 | 4.05 | 6,295 |
| Parallel independent calls | run_chain | yes | 4 | 6,985 | -93% | 3,896 (-94%) | 2,038 | 79.7 [77.3–93.7] | 6,140 | 6,219 | 4.05 | 6,296 |
| Parallel independent calls | pinned | yes | 2 | 3,376 | -97% | 2,402 (-97%) | 1,818 | 75.7 [73.2–101.9] | 3,068 | 3,143 | 2 | 3,143 |
| Large JSON aggregation | direct | yes | 2 | 184,548 | — | 151,687 | 133,933 | 35.9 [34.4–61.8] | 6,691 | 6,727 | — | — |
| Large JSON aggregation | direct_capped | **no** (0/15) | 2 | 125,680 | -32% | 92,819 (-39%) | 75,065 | 35.7 [34.3–60.8] | 5,514 | 5,549 | — | — |
| Large JSON aggregation | call_tool | yes | 4 | 89,694 | -51% | 86,605 (-43%) | 85,089 | 39 [36.4–51.6] | 7,794 | 7,833 | 4.05 | 7,930 |
| Large JSON aggregation | call_tool_opt | yes | 4 | 18,020 | -90% | 14,931 (-90%) | 13,415 | 68.9 [60.9–89.1] | 6,360 | 6,429 | 4.05 | 6,509 |
| Large JSON aggregation | run_chain | yes | 4 | 6,774 | -96% | 3,685 (-98%) | 1,959 | 44.1 [39.6–53.5] | 6,135 | 6,180 | 4.05 | 6,257 |
| Large JSON aggregation | pinned | yes | 4 | 90,642 | -51% | 86,972 (-43%) | 85,326 | 37.6 [36.3–65.4] | 7,813 | 7,850 | 4.05 | 7,948 |
| HTML documentation retrieval | direct | yes | 2 | 109,252 | — | 76,391 | 58,637 | 32.9 [31.4–74.5] | 5,185 | 5,218 | — | — |
| HTML documentation retrieval | direct_capped | yes | 2 | 109,252 | 0% | 76,391 (0%) | 58,637 | 34 [32.1–54.6] | 5,185 | 5,219 | — | — |
| HTML documentation retrieval | call_tool | yes | 4 | 14,266 | -87% | 11,177 (-85%) | 9,750 | 35.4 [33.4–63.7] | 6,285 | 6,321 | 4.05 | 6,400 |
| HTML documentation retrieval | call_tool_opt | yes | 4 | 9,993 | -91% | 6,904 (-91%) | 5,477 | 42.5 [37.6–65.1] | 6,200 | 6,242 | 4.05 | 6,319 |
| HTML documentation retrieval | run_chain | yes | 4 | 6,660 | -94% | 3,571 (-95%) | 1,937 | 44.1 [37.8–70.5] | 6,133 | 6,177 | 4.05 | 6,254 |
| HTML documentation retrieval | pinned | yes | 4 | 15,214 | -86% | 11,544 (-85%) | 9,987 | 41 [33.8–68.2] | 6,304 | 6,345 | 4.05 | 6,424 |

† lazygate strategies only: adds the held-out wrong-tool rate × retry turns for runs that used `discover_tools` (a modeled penalty).

- Single known tool: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Multi-step dependent chain: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `pinned`
- Parallel independent calls: cheapest `pinned` (raw input) / `pinned` (effective, cached prefix), fastest (modeled) `pinned`
- Large JSON aggregation: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `run_chain`
- HTML documentation retrieval: cheapest `run_chain` (raw input) / `run_chain` (effective, cached prefix), fastest (modeled) `direct`

## Cold start: discover → describe → call vs merged discovery vs known tools

Same oracle, three ways of learning the call shape (see Method → lookups). Median of 3 rounds; turns and tokens are deterministic. "Exp. ms†" folds in the held-out wrong-tool rate.

### 20 tools

| Workload | Strategy | Cold turns | Merged turns | Known turns | Cold input | Merged input | Known input | Cold modeled ms | Merged modeled ms | Known modeled ms | Merged exp. ms† |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | call_tool | 4 | 3 | 2 | 5,913 | 4,209 | 2,638 | 6,166 | 4,631 | 3,100 | 4,669 |
| Single known tool | call_tool_opt | 4 | 3 | 2 | 5,849 | 4,145 | 2,574 | 6,166 | 4,631 | 3,114 | 4,669 |
| Single known tool | run_chain | 4 | 3 | 2 | 6,220 | 4,156 | 2,585 | 6,180 | 4,633 | 3,101 | 4,671 |
| Multi-step dependent chain | call_tool | 5 | 4 | 3 | 14,546 | 12,262 | 10,299 | 7,842 | 6,295 | 4,755 | 6,334 |
| Multi-step dependent chain | call_tool_opt | 5 | 4 | 3 | 11,074 | 8,788 | 6,823 | 7,779 | 6,235 | 4,694 | 6,274 |
| Multi-step dependent chain | run_chain | 4 | 3 | 2 | 6,533 | 4,390 | 2,661 | 6,184 | 4,642 | 3,106 | 4,680 |
| Parallel independent calls | call_tool | 4 | 3 | 2 | 6,768 | 4,843 | 2,998 | 6,226 | 4,686 | 3,148 | 4,724 |
| Parallel independent calls | call_tool_opt | 4 | 3 | 2 | 6,686 | 4,761 | 2,916 | 6,225 | 4,687 | 3,150 | 4,725 |
| Parallel independent calls | run_chain | 4 | 3 | 2 | 6,691 | 4,490 | 2,645 | 6,228 | 4,680 | 3,155 | 4,718 |
| Large JSON aggregation | call_tool | 4 | 3 | 2 | 89,202 | 87,553 | 85,972 | 7,835 | 6,306 | 4,771 | 6,358 |
| Large JSON aggregation | call_tool_opt | 4 | 3 | 2 | 17,531 | 15,876 | 14,297 | 6,439 | 4,940 | 3,374 | 4,980 |
| Large JSON aggregation | run_chain | 4 | 3 | 2 | 6,282 | 4,213 | 2,632 | 6,186 | 4,644 | 3,109 | 4,682 |
| HTML documentation retrieval | call_tool | 4 | 3 | 2 | 13,882 | 12,237 | 10,676 | 6,339 | 4,793 | 3,261 | 4,833 |
| HTML documentation retrieval | call_tool_opt | 4 | 3 | 2 | 9,609 | 7,964 | 6,403 | 6,244 | 4,713 | 3,179 | 4,752 |
| HTML documentation retrieval | run_chain | 4 | 3 | 2 | 6,276 | 4,217 | 2,656 | 6,177 | 4,636 | 3,103 | 4,674 |

### 100 tools

| Workload | Strategy | Cold turns | Merged turns | Known turns | Cold input | Merged input | Known input | Cold modeled ms | Merged modeled ms | Known modeled ms | Merged exp. ms† |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | call_tool | 4 | 3 | 2 | 5,913 | 4,209 | 2,638 | 6,153 | 4,621 | 3,087 | 4,659 |
| Single known tool | call_tool_opt | 4 | 3 | 2 | 5,849 | 4,145 | 2,574 | 6,152 | 4,621 | 3,099 | 4,659 |
| Single known tool | run_chain | 4 | 3 | 2 | 6,220 | 4,156 | 2,585 | 6,180 | 4,637 | 3,105 | 4,675 |
| Multi-step dependent chain | call_tool | 5 | 4 | 3 | 15,090 | 12,670 | 10,299 | 7,837 | 6,288 | 4,740 | 6,327 |
| Multi-step dependent chain | call_tool_opt | 5 | 4 | 3 | 11,598 | 9,188 | 6,836 | 7,773 | 6,233 | 4,678 | 6,272 |
| Multi-step dependent chain | run_chain | 4 | 3 | 2 | 6,941 | 4,662 | 2,661 | 6,180 | 4,632 | 3,094 | 4,670 |
| Parallel independent calls | call_tool | 4 | 3 | 2 | 7,026 | 5,015 | 2,998 | 6,217 | 4,676 | 3,135 | 4,714 |
| Parallel independent calls | call_tool_opt | 4 | 3 | 2 | 6,944 | 4,933 | 2,916 | 6,216 | 4,676 | 3,134 | 4,714 |
| Parallel independent calls | run_chain | 4 | 3 | 2 | 6,949 | 4,662 | 2,645 | 6,217 | 4,676 | 3,134 | 4,714 |
| Large JSON aggregation | call_tool | 4 | 3 | 2 | 89,202 | 87,553 | 85,972 | 7,821 | 6,288 | 4,755 | 6,340 |
| Large JSON aggregation | call_tool_opt | 4 | 3 | 2 | 17,527 | 15,879 | 14,302 | 6,414 | 4,880 | 3,362 | 4,920 |
| Large JSON aggregation | run_chain | 4 | 3 | 2 | 6,282 | 4,213 | 2,632 | 6,167 | 4,625 | 3,094 | 4,663 |
| HTML documentation retrieval | call_tool | 4 | 3 | 2 | 13,882 | 12,237 | 10,676 | 6,312 | 4,780 | 3,246 | 4,820 |
| HTML documentation retrieval | call_tool_opt | 4 | 3 | 2 | 9,609 | 7,964 | 6,403 | 6,231 | 4,696 | 3,175 | 4,735 |
| HTML documentation retrieval | run_chain | 4 | 3 | 2 | 6,276 | 4,217 | 2,656 | 6,163 | 4,623 | 3,090 | 4,661 |

### 250 tools

| Workload | Strategy | Cold turns | Merged turns | Known turns | Cold input | Merged input | Known input | Cold modeled ms | Merged modeled ms | Known modeled ms | Merged exp. ms† |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | call_tool | 4 | 3 | 2 | 6,045 | 4,297 | 2,638 | 6,156 | 4,620 | 3,085 | 4,658 |
| Single known tool | call_tool_opt | 4 | 3 | 2 | 5,981 | 4,233 | 2,574 | 6,156 | 4,620 | 3,085 | 4,658 |
| Single known tool | run_chain | 4 | 3 | 2 | 6,352 | 4,244 | 2,585 | 6,184 | 4,623 | 3,088 | 4,661 |
| Multi-step dependent chain | call_tool | 5 | 4 | 3 | 15,082 | 12,664 | 10,299 | 7,838 | 6,290 | 4,741 | 6,329 |
| Multi-step dependent chain | call_tool_opt | 5 | 4 | 3 | 11,610 | 9,194 | 6,815 | 7,776 | 6,226 | 4,679 | 6,265 |
| Multi-step dependent chain | run_chain | 4 | 3 | 2 | 6,935 | 4,658 | 2,661 | 6,179 | 4,634 | 3,092 | 4,672 |
| Parallel independent calls | call_tool | 4 | 3 | 2 | 7,050 | 5,031 | 2,998 | 6,218 | 4,677 | 3,134 | 4,715 |
| Parallel independent calls | call_tool_opt | 4 | 3 | 2 | 6,968 | 4,949 | 2,916 | 6,217 | 4,677 | 3,139 | 4,715 |
| Parallel independent calls | run_chain | 4 | 3 | 2 | 6,973 | 4,678 | 2,645 | 6,218 | 4,672 | 3,130 | 4,710 |
| Large JSON aggregation | call_tool | 4 | 3 | 2 | 89,202 | 87,553 | 85,972 | 7,832 | 6,289 | 4,756 | 6,341 |
| Large JSON aggregation | call_tool_opt | 4 | 3 | 2 | 17,527 | 15,881 | 14,295 | 6,418 | 4,881 | 3,348 | 4,921 |
| Large JSON aggregation | run_chain | 4 | 3 | 2 | 6,282 | 4,213 | 2,632 | 6,183 | 4,627 | 3,092 | 4,665 |
| HTML documentation retrieval | call_tool | 4 | 3 | 2 | 14,008 | 12,321 | 10,676 | 6,315 | 4,782 | 3,247 | 4,822 |
| HTML documentation retrieval | call_tool_opt | 4 | 3 | 2 | 9,735 | 8,048 | 6,403 | 6,235 | 4,702 | 3,165 | 4,741 |
| HTML documentation retrieval | run_chain | 4 | 3 | 2 | 6,402 | 4,301 | 2,656 | 6,180 | 4,626 | 3,090 | 4,664 |

### 500 tools

| Workload | Strategy | Cold turns | Merged turns | Known turns | Cold input | Merged input | Known input | Cold modeled ms | Merged modeled ms | Known modeled ms | Merged exp. ms† |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Single known tool | call_tool | 4 | 3 | 2 | 6,309 | 4,473 | 2,638 | 6,162 | 4,626 | 3,089 | 4,702 |
| Single known tool | call_tool_opt | 4 | 3 | 2 | 6,245 | 4,409 | 2,574 | 6,161 | 4,625 | 3,086 | 4,701 |
| Single known tool | run_chain | 4 | 3 | 2 | 6,616 | 4,420 | 2,585 | 6,172 | 4,630 | 3,087 | 4,706 |
| Multi-step dependent chain | call_tool | 5 | 4 | 3 | 15,130 | 12,700 | 10,299 | 7,839 | 6,290 | 4,740 | 6,368 |
| Multi-step dependent chain | call_tool_opt | 5 | 4 | 3 | 11,654 | 9,210 | 6,833 | 7,775 | 6,229 | 4,676 | 6,306 |
| Multi-step dependent chain | run_chain | 4 | 3 | 2 | 6,971 | 4,682 | 2,661 | 6,182 | 4,635 | 3,091 | 4,712 |
| Parallel independent calls | call_tool | 4 | 3 | 2 | 7,062 | 5,039 | 2,998 | 6,219 | 4,680 | 3,134 | 4,757 |
| Parallel independent calls | call_tool_opt | 4 | 3 | 2 | 6,980 | 4,957 | 2,916 | 6,218 | 4,678 | 3,136 | 4,755 |
| Parallel independent calls | run_chain | 4 | 3 | 2 | 6,985 | 4,686 | 2,645 | 6,219 | 4,673 | 3,130 | 4,750 |
| Large JSON aggregation | call_tool | 4 | 3 | 2 | 89,694 | 87,881 | 85,972 | 7,830 | 6,294 | 4,759 | 6,398 |
| Large JSON aggregation | call_tool_opt | 4 | 3 | 2 | 18,019 | 16,207 | 14,304 | 6,434 | 4,893 | 3,359 | 4,973 |
| Large JSON aggregation | run_chain | 4 | 3 | 2 | 6,774 | 4,541 | 2,632 | 6,175 | 4,640 | 3,103 | 4,717 |
| HTML documentation retrieval | call_tool | 4 | 3 | 2 | 14,266 | 12,493 | 10,676 | 6,321 | 4,785 | 3,246 | 4,864 |
| HTML documentation retrieval | call_tool_opt | 4 | 3 | 2 | 9,993 | 8,220 | 6,403 | 6,240 | 4,713 | 3,165 | 4,791 |
| HTML documentation retrieval | run_chain | 4 | 3 | 2 | 6,660 | 4,473 | 2,656 | 6,171 | 4,630 | 3,088 | 4,706 |

## Turn-time sensitivity (modeled)

Modeled ms (tool ms + turns × per-turn model time + input ÷ 1000 × 20 ms) for the fastest correct strategy per workload at each assumed model time per turn. Where the winner changes between columns the ranking depends on how slow the model is — the sweep is the answer, not any single column.

| Catalog | Workload | 500 ms/turn | 1,500 ms/turn | 3,000 ms/turn | Flips |
|--:|---|---|---|---|:-:|
| 20 | Single known tool | pinned (1,109) | pinned (3,109) | pinned (6,109) | no |
| 20 | Multi-step dependent chain | pinned (1,766) | pinned (4,766) | pinned (9,266) | no |
| 20 | Parallel independent calls | pinned (1,156) | pinned (3,156) | pinned (6,156) | no |
| 20 | Large JSON aggregation | run_chain (2,183) | direct (4,791) | direct (7,791) | **yes** |
| 20 | HTML documentation retrieval | direct (1,282) | direct (3,282) | direct (6,282) | no |
| 100 | Single known tool | pinned (1,099) | pinned (3,099) | pinned (6,099) | no |
| 100 | Multi-step dependent chain | pinned (1,756) | pinned (4,756) | pinned (9,256) | no |
| 100 | Parallel independent calls | pinned (1,143) | pinned (3,143) | pinned (6,143) | no |
| 100 | Large JSON aggregation | run_chain (2,166) | direct (5,101) | direct (8,101) | **yes** |
| 100 | HTML documentation retrieval | direct_capped (1,591) | direct_capped (3,591) | direct_capped (6,591) | no |
| 250 | Single known tool | pinned (1,096) | pinned (3,096) | pinned (6,096) | no |
| 250 | Multi-step dependent chain | pinned (1,753) | pinned (4,753) | pinned (9,253) | no |
| 250 | Parallel independent calls | pinned (1,143) | pinned (3,143) | pinned (6,143) | no |
| 250 | Large JSON aggregation | run_chain (2,167) | direct (5,709) | direct (8,709) | **yes** |
| 250 | HTML documentation retrieval | run_chain (2,166) | direct_capped (4,201) | direct_capped (7,201) | **yes** |
| 500 | Single known tool | pinned (1,097) | pinned (3,097) | pinned (6,097) | no |
| 500 | Multi-step dependent chain | pinned (1,753) | pinned (4,753) | pinned (9,253) | no |
| 500 | Parallel independent calls | pinned (1,143) | pinned (3,143) | pinned (6,143) | no |
| 500 | Large JSON aggregation | run_chain (2,180) | run_chain (6,180) | direct (9,727) | **yes** |
| 500 | HTML documentation retrieval | run_chain (2,177) | direct (5,218) | direct (8,218) | **yes** |

## Tool discovery

What `discover_tools` would show (confident matches, top 5) for a labeled query set; the expected server must be ranked. `wrong-tool` = a different server ranked first. **tuned** is the set the ranker and alias table were developed against; **held-out** was written afterwards, against its own catalog of near-duplicate neighbors (github/gitlab/bitbucket, mysql/postgres/sqlite, s3/gcs/azure-blob, …), and nothing was tuned to it, so it is the number to trust.

| Set | Servers | Ranker | Queries | Recall@1 | Recall@3 | Recall@5 | MRR | Wrong-tool | No result | p50 µs | p95 µs |
|---|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| tuned | 41 | lexical | 92 | 0.804 | 0.913 | 0.913 | 0.853 | 0.185 | 0.011 | 642 | 1113 |
| tuned | 41 | bm25 | 92 | 0.913 | 0.957 | 0.967 | 0.935 | 0.087 | 0 | 123 | 258 |
| tuned | 57 | lexical | 92 | 0.793 | 0.902 | 0.913 | 0.846 | 0.196 | 0.011 | 886 | 1309 |
| tuned | 57 | bm25 | 92 | 0.902 | 0.946 | 0.957 | 0.924 | 0.098 | 0 | 139 | 299 |
| tuned | 87 | lexical | 92 | 0.783 | 0.891 | 0.902 | 0.834 | 0.207 | 0.011 | 1256 | 1620 |
| tuned | 87 | bm25 | 92 | 0.913 | 0.946 | 0.957 | 0.93 | 0.087 | 0 | 167 | 299 |
| tuned | 137 | lexical | 92 | 0.783 | 0.891 | 0.891 | 0.832 | 0.207 | 0.011 | 2009 | 2475 |
| tuned | 137 | bm25 | 92 | 0.913 | 0.946 | 0.957 | 0.93 | 0.087 | 0 | 239 | 379 |
| heldout | 38 | lexical | 40 | 0.85 | 0.95 | 0.975 | 0.902 | 0.125 | 0.025 | 614 | 833 |
| heldout | 38 | bm25 | 40 | 0.95 | 0.95 | 0.95 | 0.95 | 0.025 | 0.025 | 133 | 264 |
| heldout | 54 | lexical | 40 | 0.85 | 0.925 | 0.95 | 0.894 | 0.125 | 0.025 | 881 | 1127 |
| heldout | 54 | bm25 | 40 | 0.95 | 0.95 | 0.95 | 0.95 | 0.025 | 0.025 | 181 | 309 |
| heldout | 84 | lexical | 40 | 0.825 | 0.925 | 0.95 | 0.881 | 0.15 | 0.025 | 1369 | 1664 |
| heldout | 84 | bm25 | 40 | 0.95 | 0.95 | 0.95 | 0.95 | 0.025 | 0.025 | 216 | 338 |
| heldout | 134 | lexical | 40 | 0.825 | 0.9 | 0.925 | 0.869 | 0.15 | 0.025 | 2163 | 2597 |
| heldout | 134 | bm25 | 40 | 0.925 | 0.95 | 0.95 | 0.938 | 0.05 | 0.025 | 283 | 438 |

Held-out queries whose server was not in the top 3 (bm25, 38 servers):

- "why is this endpoint throwing exceptions in production" → expected `sentry`, got nothing
- "find errors in the logs and open a ticket for the bug" → expected `jira`, got `sentry`, `gitlab`, `youtrack`

## Optimizer latency on large responses

`optimizeToolResult` with an output token budget (uncached tokenizer, so each sample counts from scratch).

| Case | Budget | Output tokens | Within budget | Tokenizer calls | Chars tokenized | p50 ms | p95 ms | Samples |
|---|--:|--:|:-:|--:|--:|--:|--:|--:|
| text_230KB | 500 | 444 | yes | 18 | 247,136 | 26.6 | 29.2 | 45 |
| json_array_300KB | 500 | 425 | yes | 14 | 318,541 | 42 | 52.7 | 45 |
| text_230KB | 2,000 | 1,939 | yes | 11 | 272,576 | 30.2 | 38.1 | 45 |
| json_array_300KB | 2,000 | 1,922 | yes | 13 | 347,177 | 47.8 | 60.1 | 45 |
| text_230KB | 8,000 | 7,933 | yes | 13 | 459,174 | 49.7 | 62.8 | 45 |
| json_array_300KB | 8,000 | 7,906 | yes | 15 | 501,929 | 68.2 | 82.9 | 45 |

## Method

- **agent**: scripted oracle: always issues a correct call or script; measures cost and information loss, not model behaviour
- **tokens**: input = tokens read by the model across all turns without prompt caching (schemas + prompt + every earlier call and result); context = schemas + calls + results counted once
- **effective**: effective input (a model, not a measurement) = the static prefix (prompt + tool schemas) is written to the cache on the first turn at 1.25× and read at 0.1× on every later turn, while everything the conversation added since (calls and results) is billed at 1×; conservative because earlier turns are not assumed cached either
- **turns**: model turns including the closing answer turn; parallel calls in one turn count once
- **latency**: tool ms = wall-clock of all tool traffic per round, median with min–max (fresh server process each round, so cold start is included for every strategy); no model involved. A 95th percentile is only shown from 20 samples on, otherwise the maximum
- **modeled**: modeled ms = tool ms (median) + assumed model time: turns × 1500 ms + input tokens ÷ 1000 × 20 ms (raw input); the turn-time sweep repeats it for 500 / 1500 / 3000 ms per turn. These are assumptions to explore sensitivity, not measurements
- **lookups**: cold: discover_tools, then describe_tool, then call (2 extra turns; the agent ignores the inline signatures). merged: discover_tools returns the signature of the best-matching tool(s) and the agent calls straight away (1 extra turn; a describe_tool turn is added only when a needed signature is missing). known: the agent already knows the server and the signatures (0 extra turns). The main tables use `cold`; the cold-start section compares all three
- **pinned**: pinned: lazygate with expose = [get_order_status, list_tickets, get_ticket, get_region_metric] merged into tools/list (their schemas are in context every turn, no lookup turns); every other tool goes through discover_tools, describe_tool and call_tool
- **directCap**: direct_capped: like direct, but a client that truncates MCP output at 25,000 tokens cuts larger tool results (the oracle then works with the truncated text); direct is the uncapped upper bound
- **schemas**: filler tool schemas use the built-in 3-property template (see the measured tokens per tool next to each catalog); use --schema-tokens-per-tool or --catalog-from to size them from a real catalog
- **discoveryCost**: exp. turns / exp. ms add the held-out wrong-tool rate × 1 retry turn(s) for every run that used discover_tools (a modeled penalty: a wrong top result costs the agent another discovery turn); the oracle itself never gets it wrong
- **catalog**: direct puts every tool schema in context; lazygate strategies list only the meta-tools (pinned adds a few tools) and pay discover_tools / describe_tool turns
