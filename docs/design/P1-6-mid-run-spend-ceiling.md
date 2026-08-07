# P1-6 Design: Mid-run spend ceiling for the worker

**Status:** draft — requires founder review and sign-off before coding  
**Scope:** `apps/worker` + controlled `strix/**` engine contract, no web/dashboard changes  
**Owner:** worker / platform cost safety

---

## 1. Problem

Today the worker treats engine cost as a post-run reconciled value:

- `apps/worker/src/engine/command-builder.ts` passes `--max-budget-usd` to the engine subprocess.
- `strix/core/hooks.py` inside the engine reserves per-request budget and raises `BudgetExceededError`, which `strix/core/runner.py` converts to `terminal_reason: "budget_exceeded"` and exit code `3`.
- `apps/worker/src/jobs/run-scan.job.ts` only checks `budgetExceeded` in `persistEngineUsageCheckpoint` **after** the engine process exits.

The engine budget guard is the only in-flight guard. If it is ever bypassed (new engine path, reservation bug, provider cost not captured by reservation, subscription model abuse, or a future engine mode that does not self-enforce), the worker has no independent mid-run ceiling and provider spend can keep growing until the wall-clock timeout (`MAX_SCAN_RUNTIME_MS = 30 min`) fires.

P1-6 adds a worker-owned, mid-run spend ceiling that is independent of the engine's own budget logic.

---

## 2. Goals and non-goals

**Goals**
- The worker must be able to terminate an engine run while it is still alive if the observed spend crosses the approved cap.
- Spend observation must use the same source of truth the engine writes (`run.json`), not a parallel estimate, so the worker does not race or double-count.
- Termination must be safe, auditable, and leave the engine output parser with a consistent partial result.
- Existing post-run reconciliation and clamping must stay unchanged; the mid-run guard is additive.

**Non-goals**
- This design does not replace the engine's `--max-budget-usd`; the engine remains the primary fast stop.
- It does not add new dashboard UX, cost displays, or policy CRUD.
- It does not change how `maxBudgetUsd` is resolved (mode defaults, `Policy.maxBudgetUsd`, `PLATFORM_MAX_SCAN_BUDGET_USD`).

---

## 3. Budget resolution (unchanged)

`resolveScanBudgetUsd(mode, policyMaxBudgetUsd)` in `apps/worker/src/engine/command-builder.ts` continues to return the effective cap, clamped to `PLATFORM_MAX_SCAN_BUDGET_USD`. The worker passes this value to both:
- the engine via `--max-budget-usd`, and
- the new mid-run ceiling watcher.

Both layers use the same `maxBudgetUsd` value, so there is no internal conflict.

---

## 4. Mid-run observation mechanism

### 4.1 What to watch

The engine saves `run.json` continuously:
- `ReportState.record_sdk_usage()` calls `save_run_data()` after every LLM response.
- `ReportState.record_web_search_cost()` calls `save_run_data()` after every web search call.
- `ReportState` phase/terminal changes also call `save_run_data()`.

`run.json` already contains `llm_usage.cost` and `web_search_usage[].cost`. This is the authoritative live spend total.

### 4.2 Where to watch

`runner.ts` builds the engine work directory as `lyrashield_runs/${scanId}`. The engine writes `run.json` under a sub-directory named either `strix_runs` or `lyrashield_runs`. `findRunOutputDir()` already resolves this after the engine exits; the watcher can reuse the same resolution logic during the run.

### 4.3 Polling cadence

A 5-second polling interval is proposed. Rationale:
- Fast enough to cap an overshoot within a few dollars at current GPT-5.6 rates.
- Slow enough to avoid I/O noise and not compete with engine writes.
- Aligned with the existing `isCancelled` poll interval used by `runEngineProcess`.

The polling should begin only after the engine has had a short grace period to start and write its first `run.json` (e.g., 10 seconds), to avoid false negatives.

### 4.4 What to compute

For each tick:
1. Locate the current `run.json`.
2. Read it with the same bounded read used by `readEngineOutput` (`MAX_ENGINE_RUN_BYTES = 1 MiB`).
3. Parse `llm_usage.cost` (number) and `web_search_usage` (array of `{ cost: number }`).
4. Compute `observedCostUsd = llm_usage.cost + sum(web_search_usage.cost)`.
5. If `observedCostUsd > maxBudgetUsd`, trigger termination.

The worker already has `parseEngineOutput` and JSON parsing utilities. We should add a small `extractObservedCostUsd(runJson: unknown): number | null` helper in `apps/worker/src/engine/output-parser.ts`.

---

## 5. Termination action

### 5.1 How to stop the engine

`runEngineProcess` in `runner.ts` already exposes a `terminate()` function that:
- triggers `createKillEscalation(child, SIGKILL_GRACE_MS)`,
- sends `SIGTERM` and schedules `SIGKILL` after 5 s if the process is still alive.

The watcher should call this same `terminate()` path. Because `terminate()` is currently defined inside `runEngineProcess`'s promise, we need to expose it to the watcher. The cleanest way is:

- Return an object from `runEngineProcess` that includes a `terminate()` method **and** a promise for the process result.
- `runEngine` keeps the process-result promise and also passes the `terminate` function to the watcher.

Alternatively, and more minimally, the watcher can be launched inside `runEngineProcess` using the existing `terminationRequested` flag:

```ts
const budgetTimer = setInterval(async () => {
  if (closed || terminationRequested) return
  const cost = await readLatestRunCost(absWorkDir)
  if (cost !== null && cost > maxBudgetUsd) {
    logger.warn("Worker mid-run budget ceiling breached", { scanId, cost, maxBudgetUsd })
    // set a flag so the close handler knows the reason
    budgetStopped = true
    terminate()
  }
}, 5000)
```

This keeps the watcher and the process lifecycle in one closure and matches the existing `cancellationTimer` / `heartbeatTimer` pattern.

### 5.2 Result classification

When the worker terminates the engine due to its own ceiling, the engine may not have had a chance to set `terminal_reason: "budget_exceeded"`. The worker must handle this explicitly:

- `runEngine` should set `budgetStoppedByWorker = true` before terminating.
- If the engine exits with code `3` (engine-side budget exceeded), keep current behavior.
- If the worker initiated the stop, treat it as `BUDGET_EXCEEDED` regardless of exit code (likely `1` or `5` because the engine was killed mid-request).
- `processScanJob` should pass `budgetStoppedByWorker` to `persistEngineUsageCheckpoint` and emit a `budget_exceeded` scan event with the observed cost.

### 5.3 Exit code contract

The worker's `EXIT_CODE_MAP` already maps:
- `3` → `BUDGET_EXCEEDED`
- `5` → `ENGINE_INCOMPLETE`

For a worker-initiated budget kill, the engine exit code may be `137` (SIGKILL), `15` (SIGTERM), or `1` (engine internal). The worker should treat all of these as `BUDGET_EXCEEDED` **only if** the watcher triggered the kill. This is a worker-side override, not a change to the engine.

---

## 6. Proposed file changes

### 6.1 `apps/worker/src/engine/runner.ts`

- Add `BUDGET_POLL_INTERVAL_MS = 5000` and `BUDGET_POLL_START_GRACE_MS = 10000` constants.
- Add `readLatestRunCost(workDir: string): Promise<number | null>` helper.
- In `runEngineProcess`, add a `budgetTimer` that starts after the grace period and polls `run.json`.
- Track `budgetStopped = false` and `budgetExceeded = false` flags.
- When the ceiling is breached, set `budgetStopped = true`, call `terminate()`, and emit a `worker_budget_ceiling` scan event.
- In the `close` handler, include `budgetStopped` in the returned result.
- Extend `EngineRunResult` to include `budgetStoppedByWorker: boolean`.

### 6.2 `apps/worker/src/engine/output-parser.ts`

- Add `extractObservedCostUsd(runRecord: unknown): number | null` that safely extracts `llm_usage.cost` and `web_search_usage[].cost` and returns the sum.

### 6.3 `apps/worker/src/jobs/run-scan.job.ts`

- Pass `budgetStoppedByWorker` from `engineResult` to `persistEngineUsageCheckpoint`.
- In `persistEngineUsageCheckpoint`, if `budgetStoppedByWorker` is true, force `budgetExceeded = true` and use `Math.min(observedCost, maxBudgetUsd)` for `billedCostUsd`.
- Emit `budget_exceeded` scan event when the worker triggered the stop.

### 6.4 `apps/worker/src/engine/runner.test.ts` and `run-scan.job.test.ts`

- Add unit tests for `readLatestRunCost` with a mocked run record.
- Add test for worker-initiated budget kill in `runner.test.ts`.
- Add test for `persistEngineUsageCheckpoint` with `budgetStoppedByWorker`.

### 6.5 Engine (optional / future)

No engine changes are required for the first implementation. The worker acts as a defense-in-depth layer. If we later want the engine to be aware of the worker ceiling (e.g., to set `terminal_reason` even on SIGKILL), we can:
- Add `LYRASHIELD_WORKER_BUDGET_CEILING=1` env var, or
- Add a `worker_budget_ceiling` reason in `ReportState`.
This is out of scope for P1-6 unless the founder wants deeper integration.

---

## 7. Failure modes and mitigations

| Failure | Mitigation |
|---------|------------|
| `run.json` not yet written during poll | Grace period + `null` cost ignored; polling resumes. |
| `run.json` parse error or oversize | Log warning, skip tick, continue polling. The timeout timer is the backstop. |
| Engine exits with code 137 before writing `terminal_reason` | Worker uses `budgetStoppedByWorker` flag to classify as `BUDGET_EXCEEDED`. |
| Cost exceeds cap between 5 s polls | This is acceptable: the ceiling is a safety guard, not a per-request reservation. The engine's own reservation still provides the per-request stop. |
| Partial output due to SIGKILL | `parseEngineOutput` already handles partial `run.json`; `findingsComplete` will be false and the worker will persist partial findings as appropriate. |
| Watcher races with `readEngineOutput` after exit | Use atomic read within `MAX_ENGINE_RUN_BYTES`; the final post-run read may be from a different file state, but `parseEngineOutput` is deterministic. |

---

## 8. Observability

New log lines and scan events:
- `worker_budget_poll` (debug) — cost observation.
- `worker_budget_ceiling` (warning) — ceiling breached, terminating engine.
- `budget_exceeded` (error) scan event — same event name as today; adds `workerInitiated: true` metadata field.

---

## 9. Open questions for founder sign-off

1. **Polling interval:** Is 5 s acceptable, or should we tighten/loosen it? 10 s would reduce I/O but could allow larger overshoot.
2. **Cost source:** Should the worker also include non-LLM costs (e.g., egress proxy? image pull? sandbox?) in the ceiling, or is `llm_usage.cost + web_search_usage` sufficient?
3. **Ceiling vs. engine cap:** Should the worker ceiling be the **same** value as `maxBudgetUsd`, or should it be a separate hard cap (e.g., `maxBudgetUsd * 1.05` or `PLATFORM_MAX_SCAN_BUDGET_USD`) to avoid overlapping with the engine reservation and to leave headroom for the final partial request?
4. **Scope of changes:** Should this remain a worker-only change, or do you want the engine to record `terminal_reason: "worker_budget_ceiling"` even when killed externally?
5. **Testing environment:** The local test suite cannot run the real engine. Should we invest in an integration test with a mocked `run.json` producer, or rely on unit tests for P1-6?

---

## 10. Recommended next step

Once questions 1–3 are answered, create an implementation branch `feat/P1-6-worker-midrun-budget` and open a draft PR. The PR will contain only the worker changes listed in §6.1–§6.4. No engine PR is needed for the initial implementation.

---

## Appendix: current worker budget flow (for reference)

```
run-scan.job.ts
  resolveScanBudgetUsd(mode, policy) -> maxBudgetUsd
  runEngine({ ... maxBudgetUsd }, scanId, timeoutMs, isCancelled)
    command-builder.ts: buildEngineCommand -> --max-budget-usd ${maxBudgetUsd}
    runner.ts: spawn engine subprocess
    (no mid-run worker check)
    engine exits
    runner.ts: read run.json, parse output
  persistEngineUsageCheckpoint({ maxBudgetUsd, llmUsage })
    if engine-reported/rate-card cost > maxBudgetUsd:
      mark budgetExceeded, clamp billedCostUsd to cap
```

P1-6 inserts a worker watcher between `spawn` and `exit`.
