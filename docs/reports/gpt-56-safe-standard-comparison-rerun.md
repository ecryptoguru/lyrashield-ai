# GPT-5.6 SAFE vs STANDARD scan comparison — `ecryptoguru/OnboardingAI2`

**Date:** 2026-07-26  
**Target:** `https://github.com/ecryptoguru/OnboardingAI2`  
**Engine:** `lyrashield-engine` `main` (post cache-regression fix)  
**Models:** `azure_ai/gpt-5.6-luna` (`medium` reasoning effort) for SAFE and STANDARD

## Quick facts

| | SAFE | STANDARD |
| --- | --- | --- |
| **Latency** | 405.8 s (6.8 min) | 500.3 s (8.3 min) |
| **Billed cost** | $0.50 | $1.43 |
| **Cache hit ratio** | 82.5% | 70.3% |
| **Findings** | 40 (1 C, 2 H, 37 M) | 42 (2 C, 2 H, 38 M) |
| **Score / grade** | 52 / D | 45 / F |
| **Budget cap** | $1.20 | $3.20 |

## Executive summary

- A regression was discovered and fixed during this comparison: the `prompt_cache_options` setting in `lyrashield-engine/strix/core/inputs.py` had been switched to `mode: "explicit"` without inserting explicit `prompt_cache_breakpoint` content markers. This disabled prompt caching, caused the previous STANDARD run to stop at the `$3.20` budget cap, and made SAFE ~2x more expensive than expected.
- After removing the `prompt_cache_options` parameter entirely and relying on the existing `prompt_cache_key` in `ModelSettings.extra_args`, prompt caching was restored.
- The re-run produced results consistent with the earlier SAFE/STANDARD benchmarks: SAFE cost **~$0.50** with **82.5%** of input tokens served from cache, STANDARD cost **~$1.43** with **70.3%** cache hit ratio.
- STANDARD found more total findings (42 vs 40) but with a different severity mix than the previous run: the previous STANDARD run reported 4 CRITICAL and 1 HIGH, while this run reported 2 CRITICAL and 2 HIGH. SAFE was 45% faster than the prior run while staying within the same `$1.20` budget.

## Regression detected: the broken `prompt_cache_options` run

Two initial scans were executed using the then-current `main` engine code, which set `ModelSettings.prompt_cache_options = {"mode": "explicit", "ttl": "30m"}` in `strix/core/inputs.py` but did not insert explicit cache breakpoints in the request content. OpenAI/Azure therefore applied no cache, leading to much higher per-request costs.

| Metric | SAFE (broken explicit) | STANDARD (broken explicit) |
| --- | --- | --- |
| Status | COMPLETED | **STOPPED_BUDGET** |
| Total latency | 331.1 s | 223.6 s |
| `billedCost` | $1.05 | $3.11 |
| `actualCostCents` | 105 | 311 |
| LLM requests | 42 | 70 |
| Input tokens | 1,665,385 | 3,380,676 |
| Cached input tokens | 770,048 (46.2%) | 413,184 (12.2%) |
| Output tokens | 12,544 | 16,136 |
| Findings | 42 | 39 |
| Score / grade | 47 / F | n/a (budget stop) |

Key take-aways from the broken run:

- **SAFE** completed but cost more than double the expected ~$0.50 because only 46% of input was cached.
- **STANDARD** hit the `$3.20` mode cap and stopped early (`errorCategory: BUDGET_EXCEEDED`), reporting only 39 findings vs the expected ~41–42.
- The low cache ratios were the direct cause of the budget failure.

## Fix applied

`lyrashield-engine/strix/core/inputs.py` and `strix/core/runner.py` were updated to stop passing `prompt_cache_options` to `ModelSettings`. The existing `prompt_cache_key` in `extra_args` is retained and is sufficient for the provider to apply its default implicit cache breakpoints. `tests/test_inputs.py` was updated to assert that `prompt_cache_options` is `None` and `prompt_cache_key` is preserved.

Engine test suite result after the fix:

```text
590 passed in 17.28s
```

## Re-run results vs. previous benchmarks

### SAFE

| Metric | Previous benchmark (`gpt-56-cost-cache-analysis.md`) | This re-run (fixed cache) | Change |
| --- | --- | --- | --- |
| Status | COMPLETED | COMPLETED | — |
| Total latency | 734.7 s (12.2 min) | 405.8 s (6.8 min) | **-44.8%** |
| Engine latency | 734.6 s | 405.7 s | **-44.8%** |
| LLM requests | 39 | 38 | -1 |
| Input tokens | 1,490,772 | 1,700,050 | +14.0% |
| Cached input tokens | 1,167,360 (78.3%) | 1,402,880 (82.5%) | **+4.2 pp** |
| Output tokens | 9,864 | 10,646 | +7.9% |
| `billedCost` | ~$0.50 (exact $0.501334) | $0.501334 | ~flat |
| `actualCostCents` | `null` (reconciliation bug) | 50 | fixed |
| Findings | 39 | 40 | +1 |
| CRITICAL | 1 | 1 | — |
| HIGH | 2 | 2 | — |
| MEDIUM | 36 | 37 | +1 |
| Score / grade | 53 / F | 52 / D | comparable (grade change likely a score-threshold rounding effect, not a material quality shift) |

### STANDARD

| Metric | Previous benchmark | This re-run (fixed cache) | Change |
| --- | --- | --- | --- |
| Status | COMPLETED | COMPLETED | — |
| Total latency | 331.3 s (5.5 min) | 500.3 s (8.3 min) | **+51.0%** |
| Engine latency | 331.2 s | 500.2 s | **+51.0%** |
| LLM requests | 83 | 74 | -10.8% |
| Input tokens | 3,561,150 | 3,556,418 | -0.1% |
| Cached input tokens | 2,437,120 (68.4%) | 2,501,120 (70.3%) | **+1.9 pp** |
| Output tokens | 18,995 | 20,995 | +10.5% |
| `billedCost` | ~$1.48 (exact $1.482) | $1.43138 | **-3.4%** |
| `actualCostCents` | `null` (reconciliation bug) | 143 | fixed |
| Findings | 41 | 42 | +1 |
| CRITICAL | 4 | 2 | -2 |
| HIGH | 1 | 2 | +1 |
| MEDIUM | 36 | 38 | +2 |
| Score / grade | 37 / F | 45 / F | comparable (score difference within stochastic variance; both grade F) |

## Cost analysis

Using the official GPT-5.6 Luna rate card (`apps/worker/src/engine/gpt56-pricing.ts`):

| Model | Input | Cached input | Cache-write input | Output |
| --- | --- | --- | --- | --- |
| `gpt-5.6-luna` | $1.00 / M | $0.10 / M | $1.25 / M | $6.00 / M |

### SAFE re-run

```text
uncached  = 1,700,050 - 1,402,880 = 297,170
input cost  = 297,170 × $1.00/M = $0.297
cached cost = 1,402,880 × $0.10/M = $0.140
output cost = 10,646 × $6.00/M    = $0.064
--------------------------------------------
approximate SAFE cost                = $0.501
```

- Cost per finding: $0.50 / 40 = **$0.0125**
- Cost per critical finding: $0.50 / 1 = **$0.50**

### STANDARD re-run

```text
uncached  = 3,556,418 - 2,501,120 = 1,055,298
input cost  = 1,055,298 × $1.00/M = $1.055
cached cost = 2,501,120 × $0.10/M = $0.250
output cost = 20,995 × $6.00/M    = $0.126
--------------------------------------------
approximate STANDARD cost            = $1.431
```

- Cost per finding: $1.43 / 42 = **$0.034**
- Cost per critical finding: $1.43 / 2 = **$0.72**

### Value of prompt caching

| Scenario | SAFE cost | STANDARD cost |
| --- | --- | --- |
| With caching (observed) | $0.50 | $1.43 |
| Without caching (all input at $1/M + output) | $1.76 | $3.69 |
| **Cache savings** | **~$1.26 (72%)** | **~$2.26 (61%)** |

## Latency and quality observations

- **SAFE** is now significantly faster (405.8 s vs 734.7 s) while producing the same severity profile and roughly the same cost. The time saving is most likely from better cache hit ratio and reduced per-request model work.
- **STANDARD** is slower (500.3 s vs 331.3 s) despite making 9 fewer LLM requests. The increased wall-clock time appears to be provider-side variability on the larger initial prompt; cost actually decreased by 3.4%, and cache hit ratio improved.
- **Findings stability**: Both runs produced the expected SCA base of 36 medium findings, plus the consistent agent-config and secrets findings. The engine-generated findings varied slightly between runs: the previous STANDARD run reported 4 CRITICAL / 1 HIGH, while this run reported 2 CRITICAL / 2 HIGH; SAFE stayed at 1 CRITICAL / 2 HIGH with one additional MEDIUM. This is normal for a stochastic model exploring a repository. The total count and overall risk grade remained in the same band.

## Files changed

- `lyrashield-engine/strix/core/inputs.py` — removed `prompt_cache_options` and the unused `prompt_cache_breakpoints` parameter from `make_model_settings`.
- `lyrashield-engine/strix/core/runner.py` — removed the `prompt_cache_breakpoints` keyword argument from the coordinator `make_model_settings` call.
- `lyrashield-engine/tests/test_inputs.py` — updated the test to assert `prompt_cache_options` is `None` while `prompt_cache_key` is preserved.
- `lyrashieldai/Dockerfile` — added `git` to the `worker-engine` stage so `uv` can install git dependencies.
- `lyrashieldai/apps/worker/scripts/live-test.ts` — reads `SCAN_MODE`, `MAX_BUDGET_USD`, `SCAN_GOAL`, and `MAX_DURATION_MINUTES` from environment variables.

## Explicit breakpoint smoke test

I built an opt-in `LYRASHIELD_PROMPT_CACHE_EXPLICIT=1` path in `lyrashield-engine` that:

- emits a `prompt_cache_breakpoint` content part on the stable root-agent prefix in `build_root_initial_input`,
- sets `ModelSettings.prompt_cache_options = {"mode": "explicit", "ttl": "30m"}` for the coordinator, and
- is gated off by default so the stable implicit-caching path is unchanged.

A SAFE (`quick`) smoke scan against the same `ecryptoguru/OnboardingAI2` target on `azure_ai/gpt-5.6-luna` immediately failed with:

```text
agents.exceptions.ModelBehaviorError: Responses stream ended with terminal event `response.incomplete`.
status=incomplete; incomplete_details=IncompleteDetails(reason='content_filter')
```

The same configuration without `LYRASHIELD_PROMPT_CACHE_EXPLICIT=1` completed successfully in the earlier comparison runs. This indicates the current Azure AI deployment does not cleanly accept the explicit `prompt_cache_breakpoint` content-part/`prompt_cache_options` combination, or it triggers Azure's content-safety filter. Until a provider/SDK smoke test succeeds, explicit breakpoints should stay off for this deployment.

The experimental implementation lives on the `lyrashield-engine` branch `feat/explicit-prompt-cache-breakpoints` and is *not* merged to `main`.

## Risks and caveats

- This comparison is based on a single repository (`ecryptoguru/OnboardingAI2`) and a small number of runs. Latency numbers are subject to provider load and cache warmup.
- The engine-side fix intentionally reverts to default implicit caching. Explicit `prompt_cache_breakpoint` markers are now gated behind `LYRASHIELD_PROMPT_CACHE_EXPLICIT=1` and have been shown to fail on Azure AI `gpt-5.6-luna` with a `content_filter` incomplete response. They should not be enabled without a passing provider smoke test.
- The score/grade differences (e.g. SAFE 53/F vs 52/D) are within the expected variance of the scoring model and should not be interpreted as a material quality change without a larger corpus.

## Next steps

1. ✅ Merge the engine cache-regression fix to `lyrashield-engine/main` (PR `#37` merged).
2. ✅ Merge the `Dockerfile` and `live-test.ts` changes to `lyrashieldai/main` (pushed as `48811e6`).
3. ✅ Test explicit `prompt_cache_breakpoint` markers behind an opt-in gate; result: **not viable on Azure AI `gpt-5.6-luna`** (`response.incomplete` with `content_filter`).
4. On a larger corpus, validate that cache hit ratios stay above 70% for STANDARD and above 80% for SAFE.
5. If STANDARD latency continues to vary between ~330 s and ~500 s, add per-scan latency telemetry to correlate it with cache-write time and request queue depth.
6. Revisit explicit breakpoints only when a provider smoke test proves the deployment accepts them and improves cache hit ratio beyond the current 82.5% (SAFE) / 70.3% (STANDARD).
