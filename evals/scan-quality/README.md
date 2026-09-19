# Scan-quality surface evals

Deterministic corpus for the app-side scan quality surface
(`lyrashield-scan-quality/1.0.0`, `packages/types/src/scan-quality.ts`).

Each `cases/*.json` fixture is **stored evidence** for one scan — exactly what
`getScanQualitySurface` reads from the database:

- `evidence.scan` — status, mode, determinism mode, duration, model request count
- `evidence.receipts` — `ScanCoverageReceipt` rows (`scanner`, `controlId`,
  `status`, optional `reason`/`metadata`)
- `evidence.findings` — verification tier + severity per stored finding
- `evidence.manifestChecksum`, `evidence.ingestionWarnings`, `evidence.attachments`

`expect` maps dotted surface paths (e.g. `facts.findings.total`) to exact
expected values. The runner also rebuilds every surface twice and requires
identical `surfaceChecksum`s — the surface must be a pure function of stored
evidence. The `parity` table is asserted complete (every metric × every
surface) and identical across surfaces.

Nothing here claims accuracy, certification, or guaranteed detection: counts
are measured facts from stored rows, ratios are labeled heuristics, and
`engine-scope:`/`engine-gap:` receipts are counted separately as
engine-declared coverage.

Run:

```sh
./packages/db/node_modules/.bin/tsx evals/scan-quality/run.ts
./packages/db/node_modules/.bin/tsx evals/scan-quality/run.ts --case=completed-standard
```

`last-report.json` is written (gitignored). Corpus shape + determinism are
also enforced by `evals/scan-quality/cases.test.ts` under Vitest.
