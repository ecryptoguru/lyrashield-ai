# GPT-5.6 cost and cache optimisation analysis — SAFE vs STANDARD

This report compares the two successful local scans of `ecryptoguru/OnboardingAI2` (`SAFE` and `STANDARD`), cross-checks the results against the official GPT-5.6 documentation and the supplied OpenAI transcript, and proposes concrete cost/cache optimisations. The P1 cost-reconciliation fix was implemented immediately; remaining engine-side recommendations are itemised in a separate file in the `lyrashield-engine` repository for your approval.

## 1. Executive summary

- Both scans completed and stayed well inside the $3.20 mode cap.
- **Prompt caching is already working**: ~78% (SAFE) and ~68% (STANDARD) of input tokens were served from cache, saving roughly **$1.05** and **$2.19** respectively versus an uncached run.
- **STANDARD is faster and finds more critical issues**: 5.5 min vs 12.2 min, 4 critical findings vs 1, at ~~3x the cost (~~$1.48 vs ~$0.50).
- **Cost accounting is fixed in `output-parser.ts`**: `actualCostCents`, `providerCostUsd`, and `billedCostUsd` were `null` because the worker discarded per-request usage buckets when any entry omitted `cache_write_tokens`. Missing cache counters now default to `0` so cost reconciliation succeeds.
- **Four optimisation levers** are available, in rough priority order:
  1. Fix per-request usage-bucket parsing so cost is reconciled and stored.
  2. Add explicit `prompt_cache_breakpoint` markers around stable system/repo context.
  3. Tune compaction/output-token caps per scan mode.
  4. Evaluate programmatic tool calling and persistent reasoning for multi-step agent workflows.

## 2. Scan results side by side

| Metric                  | SAFE (`cms12f4mp...`) | STANDARD (`cms1p41q9...`) | Notes                                  |
| ----------------------- | --------------------- | ------------------------- | -------------------------------------- |
| Status                  | COMPLETED             | COMPLETED                 |                                        |
| Total latency           | 734.7 s (12.2 min)    | 331.3 s (5.5 min)         | STANDARD is 2.2x faster                |
| Engine latency          | 734.6 s               | 331.2 s                   |                                        |
| LLM requests            | 39                    | 83                        | STANDARD makes 2.1x more calls         |
| Input tokens            | 1,490,772             | 3,561,150                 |                                        |
| Cached input tokens     | 1,167,360             | 2,437,120                 |                                        |
| Cache hit ratio         | **78.3%**             | **68.4%**                 | SAFE caches better per request         |
| Output tokens           | 9,864                 | 18,995                    | Output is tiny vs input                |
| Risk score / grade      | 53 / F                | 37 / F                    | Score formula weights multiple factors |
| Findings                | 39                    | 41                        |                                        |
| CRITICAL                | 1                     | 4                         |                                        |
| HIGH                    | 2                     | 1                         |                                        |
| MEDIUM                  | 36                    | 36                        |                                        |
| `actualCostCents` in DB | `null`                | `null`                    | Reconciliation failure                 |

## 3. Cost analysis

### 3.1 Official GPT-5.6 Luna/Terra rate card

Source: `apps/worker/src/engine/gpt56-pricing.ts`

| Model           | Input     | Cached input | Cache-write input | Output     |
| --------------- | --------- | ------------ | ----------------- | ---------- |
| `gpt-5.6-luna`  | $1.00 / M | $0.10 / M    | $1.25 / M         | $6.00 / M  |
| `gpt-5.6-terra` | $2.50 / M | $0.25 / M    | $3.125 / M        | $15.00 / M |

Long-context input (> 272k tokens in a single request) is billed at **2x**.

### 3.2 Cost calculation for the Luna runs

Both scans used `azure_ai/gpt-5.6-luna` (`medium` reasoning effort).

#### SAFE

```text
uncached  = 1,490,772 - 1,167,360 - 0 = 323,412
input cost  = 323,412 × $1.00/M = $0.323
cached cost = 1,167,360 × $0.10/M = $0.117
output cost = 9,864 × $6.00/M    = $0.059
-------------------------------------------
approximate SAFE cost               = $0.499 (~$0.50)
```

- **Cost per finding**: $0.50 / 39 ≈ **$0.013**
- **Cost per critical finding**: $0.50 / 1 = **$0.50**

#### STANDARD

```text
uncached  = 3,561,150 - 2,437,120 - 0 = 1,124,030
input cost  = 1,124,030 × $1.00/M = $1.124
cached cost = 2,437,120 × $0.10/M = $0.244
output cost = 18,995 × $6.00/M    = $0.114
-------------------------------------------
approximate STANDARD cost           = $1.482 (~$1.48)
```

- **Cost per finding**: $1.48 / 41 ≈ **$0.036**
- **Cost per critical finding**: $1.48 / 4 ≈ **$0.37**

### 3.3 Value of cache

| Scenario                            | SAFE cost        | STANDARD cost    |
| ----------------------------------- | ---------------- | ---------------- |
| With caching (observed)             | $0.50            | $1.48            |
| Without caching (all input at $1/M) | $1.55            | $3.68            |
| **Cache savings**                   | **~$1.05 (68%)** | **~$2.19 (60%)** |

Output tokens are such a small fraction of spend that optimising output tokens (e.g., lowering `max_output_tokens`) would save only cents, not dollars. The big levers are **input size** and **cache hit ratio**.

### 3.4 Why `actualCostCents` is `null`

`apps/worker/src/jobs/run-scan.job.ts` calls `persistEngineUsageCheckpoint` with `engineResult.output.runRecord?.llm_usage`. The worker has two pricing paths:

1. **Per-request model buckets** (`model_usage_buckets`) — preferred, exact.
2. **Aggregate root counters** (`input_tokens`, `cached_input_tokens`, `output_tokens`) — only used when buckets are unavailable, and **explicitly rejected when aggregate input > 272k tokens** because long-context multipliers cannot be inferred from totals.

Both scans exceed 272k aggregate input, so the aggregate path returns `null`. The per-request path requires every `request_usage_entries` item to expose `cache_write_tokens`; if any entry omits it, `normalizeRequestUsageBuckets` in `apps/worker/src/engine/output-parser.ts` returns `{}` and the per-request buckets are lost.

The engine's `LLMUsageLedger` already preserves `request_usage_entries` and can include `cache_write_tokens` when the provider reports it, but it omits the key when the value is zero. The worker should treat a missing `cache_write_tokens` as `0` rather than a fatal parse error.

**Recommendation 1**: patch `apps/worker/src/engine/output-parser.ts` so `normalizeRequestUsageBuckets` defaults missing `cache_write_tokens` to `0` and missing `cached_tokens` to `0`.

## 4. What the engine already does

### 4.1 Prompt caching

`lyrashield-engine/strix/core/runner.py` sets `prompt_cache_key` for the coordinator and delegate agents:

```python
model_settings = make_model_settings(
    ...,
    prompt_cache_key=f"lyrashield:{scan_id}:coordinator",
)
delegate_model_settings = make_model_settings(
    ...,
    prompt_cache_key=f"lyrashield:{scan_id}:delegates",
)
```

`strix/core/inputs.py` passes `prompt_cache_key` through `ModelSettings.extra_args`. This gives the provider a per-scan cache key but does **not** mark where the stable prefix ends. According to the official GPT-5.6 docs, the most cost-effective pattern is:

- Put stable system instructions / repo context first.
- Append variable content (target metadata, current date, user instructions) **after** a `prompt_cache_breakpoint`.
- Reuse the same `prompt_cache_key` for subsequent requests.

The transcript highlights a 90% input-cost reduction in the prompt-caching demo; our current implementation is leaving that upside on the table.

### 4.2 Input compaction

`strix/core/hooks.py` implements client-side compaction:

```python
MODEL_INPUT_COMPACTION_TRIGGER_TOKENS = 96_000
MODEL_INPUT_COMPACTION_TARGET_TOKENS = 64_000
_GPT56_LONG_CONTEXT_TOKENS = 272_000
_LONG_CONTEXT_SAFETY_MARGIN_TOKENS = 32_000
```

`resolve_compaction_thresholds(max_input_tokens)` clamps the trigger below the 272k long-context boundary. `LYRASHIELD_MAX_INPUT_TOKENS` is not set in `.env`, so defaults apply.

Compaction keeps requests below 2x input billing, but the current defaults may discard useful history too aggressively for deep repository analysis. The transcript's compaction demo showed an 82% input-token reduction, but only after a ~30-second compaction pass. There is a latency/cost trade-off here.

### 4.3 Output-token caps

`strix/core/runner.py`:

```python
_DEFAULT_OUTPUT_TOKENS = 8_192
DELEGATE_OUTPUT_TOKEN_CEILING = 8_192

def resolve_max_output_tokens(scan_mode: str, configured: int | None) -> int:
    if configured is not None:
        return configured
    return _MODE_OUTPUT_TOKEN_LIMITS.get(scan_mode, _DEFAULT_OUTPUT_TOKENS)
```

`LYRASHIELD_MAX_OUTPUT_TOKENS` and `LYRASHIELD_MAX_INPUT_TOKENS` are read from `LYRASHIELD_*` env aliases but are not set in `.env`.

The current output cap is already conservative (8,192). Output tokens represent < 8% of spend in these scans, so lowering it further has limited ROI unless it also reduces per-request latency.

### 4.4 Programmatic tool calling and persistent reasoning

The engine does **not** currently use:

- `programmatic_tool_calling` (JavaScript sandbox for batched tool calls).
- `previous_response_id` / `reasoning.context: all_turns` for persistent reasoning.

The transcript reports 24% token savings from programmatic tool calling and better continuity from persistent reasoning. These are OpenAI Responses API features; Azure AI inference may not expose all of them, so they require a provider-capability check before adoption.

## 5. Recommendations and implementation map

### P1 — Fix cost reconciliation (app-side, small)

**File**: `apps/worker/src/engine/output-parser.ts`
**Change**: in `normalizeRequestUsageBuckets`, treat missing `cached_tokens` and `cache_write_tokens` in `input_tokens_details` as `0` instead of returning `{}`.
**Expected impact**: `actualCostCents` and `billedCostUsd` populate for future scans; cost dashboards and budget enforcement become accurate.

### P2 — Add explicit prompt-cache breakpoints (engine-side, medium)

**File**: `lyrashield-engine/strix/core/inputs.py` and `strix/core/runner.py`
**Change**: when building the conversation input, mark the stable prefix (system prompt, repo context, skills) with `prompt_cache_breakpoint` / `prompt_cache_options`, and keep per-target/date variables after the breakpoint. Keep the existing `prompt_cache_key` per scan.
**Expected impact**: higher cache hit ratio on multi-turn coordinator/delegate runs; lower input cost; the transcript demo suggests up to 90% input-cost reduction for reusable prefixes.

### P3 — Expose and tune `LYRASHIELD_MAX_INPUT_TOKENS` / `LYRASHIELD_MAX_OUTPUT_TOKENS` (app + engine)

**Files**: `.env` / `.env.example`, `apps/worker/src/engine/runner.ts` env allow-list, `lyrashield-engine/strix/config/settings.py`
**Change**: add the env vars to the worker allow-list and document sensible defaults. `max_input_tokens` drives compaction; `max_output_tokens` drives per-request reservations and `ModelSettings.max_tokens`.
**Expected impact**: gives operators one knob to avoid 2x long-context billing without editing engine code.

### P4 — Evaluate programmatic tool calling for multi-tool agents (engine-side, research)

**File**: `lyrashield-engine/strix/core/inputs.py` / agent construction
**Change**: for agents that make many independent tool calls (repo mapper, SCA gatherer), pass `{"type": "programmatic_tool_calling"}` in tools and `allowed_callers: ["programmatic"]` on suitable functions. The runtime executes the generated sandbox program and feeds results back.
**Expected impact**: transcript shows 24% fewer input tokens and saved model turns; risky until we confirm Azure AI supports the feature.

### P5 — Persistent reasoning across agent turns (engine-side, research)

**File**: `lyrashield-engine/strix/core/runner.py`
**Change**: carry `previous_response_id` between coordinator turns and use `reasoning: { context: "all_turns" }` for follow-up requests.
**Expected impact**: better continuity and cache efficiency on long chains; requires `store=False`/ZDR handling and provider support.

## 6. What to implement where

| Optimisation                    | Repo                | Files                                                                                    |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Cost reconciliation fix         | `lyrashieldai`      | `apps/worker/src/engine/output-parser.ts`                                                |
| Env var plumbing for max tokens | `lyrashieldai`      | `.env`, `.env.example`, `apps/worker/src/engine/runner.ts`, `packages/config/src/env.ts` |
| Prompt-cache breakpoints        | `lyrashield-engine` | `strix/core/inputs.py`, `strix/core/runner.py`                                           |
| Compaction threshold tuning     | `lyrashield-engine` | `strix/core/hooks.py`                                                                    |
| Programmatic tool calling       | `lyrashield-engine` | `strix/core/inputs.py`, agent tooling                                                    |
| Persistent reasoning            | `lyrashield-engine` | `strix/core/runner.py`                                                                   |

Engine-side recommendations are detailed in `lyrashield-engine/docs/cost-cache-engine-plan.md`.

## 7. Risks and caveats

- **Provider feature parity**: Azure AI / `azure_ai/gpt-5.6-luna` may not support every OpenAI Responses API field (`prompt_cache_breakpoint`, `programmatic_tool_calling`, `previous_response_id`). Each P2–P5 change needs a provider smoke test before rollout.
- **Fork discipline**: the engine is a controlled LyraShield derivative of Strix. Engine changes must stay minimal, pass the existing 329 engine tests, and not be marketed as coverage/result improvements without a LyraShield evaluation corpus.
- **Compaction trade-off**: lowering `max_input_tokens` reduces cost but may drop older repo context, forcing the agent to re-read files and actually increasing latency or cost.
- **Cost fail-closed**: `gpt56-pricing.ts` intentionally refuses to price ambiguous aggregates. Any fix must preserve that behaviour and only populate `actualCostCents` when per-request buckets are complete.

## 8. Next steps

1. Review this report and `lyrashield-engine/docs/cost-cache-engine-plan.md`.
2. Approve the priority order and which remaining items to ship next.
3. P1 (`apps/worker/src/engine/output-parser.ts`) is already implemented; P2–P5 are ready to apply on approval.

## Appendix A — Raw worker logs excerpt (STANDARD)

```json
lyrashield-worker  | {"level":"info","message":"Scanner orchestrator complete","scanId":"cms1p41q90004a7s673wt48qh","totalFindings":41,"engine":3,"sca":36,"secrets":"[REDACTED]","url":0,"agentConfig":1,"falsePositivesFiltered":0,"stats":{"total":41,"bySeverity":{"CRITICAL":4,"MEDIUM":36,"HIGH":1},"byConfidence":{"high":40,"medium":1,"low":0},"verified":41,"unverified":0,"falsePositiveRisk":{"low":41,"medium":0,"high":0}}}
lyrashield-worker  | {"level":"info","message":"Score snapshot created","scanId":"cms1p41q90004a7s673wt48qh","score":37,"grade":"F"}
lyrashield-worker  | {"level":"info","message":"Engine workspace cleaned up",...}
```

## Appendix B — Official doc references

- OpenAI prompt caching guide: `prompt_cache_key`, `prompt_cache_options`, `prompt_cache_breakpoint`
- OpenAI programmatic tool calling guide: `programmatic_tool_calling` tool type, `allowed_callers`
- OpenAI reasoning guide: `reasoning.context` (`current_turn` / `all_turns`), `previous_response_id`
- OpenAI compaction endpoint: `POST /v1/responses/compact`, `context_management.compact_threshold`
