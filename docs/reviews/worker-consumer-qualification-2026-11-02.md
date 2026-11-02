# Worker consumer qualification — 2026-11-02

This is local compatibility evidence for the current worker reader. Product baseline `d488862bd269c07194afe87a918ca413e4a62217` plus reader commits through `f095bda4a9b9d4a2931ee8bac16206568129e6a4` owns the tested production behavior. The qualification patch adds tests and reproducible tooling; it changes no application behavior, engine pin or release workflow.

The engine's existing `scripts/verify-worker-contract.sh` and `.lyrashield-worker-pin` remain unchanged. Its exact pinned consumer, `86537799e615fb3c07376106b315393e81d7ae9d`, is a separate compatibility gate. Passing the current-reader suite does not replace that gate.

## Reproduction

Use prepared checkouts with the engine's frozen Python environment, product frozen pnpm dependencies and generated Prisma client. From the engine checkout, generate the fixture directory with its committed `scripts/generate-http-evidence-fixtures.py`. Set `ENGINE_CHECKOUT`, `PINNED_CONSUMER_CHECKOUT`, `PRODUCT_CHECKOUT` and `WRITER_FIXTURES` to those local directories. These paths are operator inputs and are not embedded in artifacts.

```sh
# Run from the engine checkout against the unchanged, clean pinned consumer.
PYTHONPATH=. .venv/bin/python scripts/generate-http-evidence-fixtures.py --output-dir "$WRITER_FIXTURES"
LYRASHIELD_BIN="$ENGINE_CHECKOUT/.venv/bin/lyrashield" \
  bash scripts/verify-worker-contract.sh "$PINNED_CONSUMER_CHECKOUT"

# Run from the current product checkout, using the same candidate engine CLI.
node scripts/verify-worker-qualification-safety.mjs "$WRITER_FIXTURES"
LYRASHIELD_BIN="$ENGINE_CHECKOUT/.venv/bin/lyrashield" \
  bash scripts/verify-current-worker-contract.sh "$WRITER_FIXTURES"
```

The [declared current test manifest](../../scripts/current-worker-contract-tests.txt) includes all nine pinned-contract suites and the previous reader qualification suites, plus relevant triage, coverage and evidence API checks. The [current invocation](../../scripts/verify-current-worker-contract.sh) rejects staged or unstaged tracked changes and unreadable Git state before running any CLI, install or test command. It matches complete required CLI option tokens, installs the frozen pnpm lockfile, runs the manifest with V8 coverage and then invokes the [actual writer-to-reader bridge](../../scripts/verify-worker-writer-artifacts.ts). Untracked operator files remain allowed. Similar names such as `--target-list` and `--instruction-file` do not satisfy `--target` or `--instruction`.

The invocation uses the pinned contract's synthetic CI auth/database values. It disables disposable database tests and opt-in Composer Docker smoke. The repository's Vitest environment also replaces database connections with its dead local unit endpoint. No model provider, production database, paid scan or deployment is part of this qualification.

## Local results

The recorded application qualification below ran on `858085e8caadc0613c610c08872cf7dfac6ad3d9`. The stricter qualification tools add focused checks without changing application behavior.

- [Tool regressions](../../scripts/verify-worker-qualification-tools.mjs): **13 checks passed** against disposable copies of the actual 13-bundle writer fixtures and temporary Git repositories. Missing mandatory receipts, digest mismatch, an unreceipted HTTP artifact, staged/unstaged source changes, failed Git status and misleading CLI option prefixes are rejected; exact tuples, clean source and untracked local notes remain positive controls. Dependency/test commands are stubbed only in the gate's isolated test repository.
- [Fixture safety regressions](../../scripts/verify-worker-qualification-safety.mjs): **four cases passed**, executing the normal 13 checks plus separate summary, case-directory and artifact symlink probes. The runner rejects links before registering mutation tests and materializes private regular files for every mutation. All external sentinels retain their exact original bytes, including when the child rejects the input.
- Unchanged pinned consumer: **9 suites passed; 419 tests passed**.
- Current consumer: **36 suites passed; 1,019 tests passed; 11 skipped**. The skips are the existing opt-in Composer Docker smoke cases.
- Separate Composer smoke: **2 suites passed; 27 tests passed; no skips**, including all 11 opt-in cases. The exact pinned Composer image was already cached as arm64; the run used `DOCKER_DEFAULT_PLATFORM=linux/arm64`, `LYRASHIELD_COMPOSER_SMOKE=1` and `--maxWorkers=1`. Metadata and DNS were fixture-supplied; containers used no networking, plugins, scripts or installation, with 256 MiB memory and one CPU limits. No image pull was needed.
- Worker and web typechecks, changed TypeScript ESLint with zero warnings, changed-file formatting and shell syntax checks passed.
- Production web build passed through the repository's `ci-selection.mjs build app` command selecting web and worker dependency closures: four build/generation tasks succeeded, none cached. Next.js compilation, TypeScript and prerendering completed with synthetic CI auth values, email verification disabled and a dead local database endpoint. This is build evidence; authenticated browser and deployed web/worker revision parity remain separate gates.
- V8 coverage over all code imported by this selected suite: statements **30.46%**, branches **27.32%**, functions **24.94%**, lines **35.29%**. These are whole imported-code totals, not a claim of complete product coverage. The generated Prisma runtime emitted a missing sourcemap warning; the tests and coverage command completed successfully.

The populated-cache regression first proves a same-revision hit, changes only the valid 40-character `engineRevision`, requires a miss without an artifact or reuse receipt and then confirms the original revision still hits. A separate regression proves that off mode neither reads nor writes Redis even when a valid entry already exists. Existing suites cover private-repository credentials without propagation, relay readiness, PHP/Composer finding identity, deterministic retest authority, result manifests and pending-claim persistence/API presentation.

## Actual writer artifacts

The bridge requires an exact per-case receipt file set: `run.json` and `vulnerabilities.json`, plus `http_exchanges.json` only for cases expected to produce that artifact. It checks actual HTTP file presence too. It reads each consumed file once, verifies that buffer's byte length and SHA-256, and passes strings decoded from those same verified buffers to `parseEngineOutput`. Missing or extra receipt entries cannot bypass integrity checks, and no second file read occurs between verification and parsing. Expected reader outcomes are declared independently in the bridge; the receipt does not define expected authority.

The final 13-bundle fixture set was regenerated from writer commit `1c4996688d01cee79435a115b63a6b65a710d5b9` with the portable generator command above.

| Fixture         | Reader outcome                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Reverse reuse   | Captured ID 18 survives; ID 17 remains pending.                                                                            |
| Shared capacity | First finding retains 10 captured IDs plus pending 99; the second finding independently retains captured 99.               |
| Failed overflow | No HTTP artifact is available; ordinary ID 1 is dropped with an ingestion issue; all 10 pending IDs survive.               |
| Header bound    | One captured exchange survives the writer's bounded header export.                                                         |
| Maximum bytes   | The 1,030,906-byte HTTP artifact retains 30 captured exchanges; 34 uncaptured claims remain pending across their findings. |

The five negative outcome/document metadata cases qualify zero captures, quarantine the failed document and retain pending ID 17. A negative lookup preserves previously captured, bound ID 17. A late deadline quarantines the failed document and retains pending ID 17. The omission-limit case qualifies no HTTP artifact and retains all 560 pending IDs across 56 findings with independent per-finding bounds.

All 13 tuples passed the actual parser. Every finding remains engine-unverified. These checks establish transport/readability and reference binding, not vulnerability validation.

## Remaining gates

The writer stays default off until the corrected reader is deployed and qualified. This record establishes neither CI nor rollout. Paired worker image build/policy smoke, live database/Redis/R2 persistence, authenticated responsive browser acceptance, customer compatibility tests and live provider/runtime acceptance remain separate gates. No external database, provider, push or deployment was used here.
