# @lyrashield/score

Pure, versioned score engine for LyraShield scans.

## Purpose

- Computes a deterministic `LyraShield Score` (0-100 + grade) from a completed scan's findings.
- Versioned under `SCORE_MODEL_VERSION = "lyrashield-score/1.0.0"`.
- Applies weighted deductions by severity, caps grades for verified critical/high findings and active verified secrets, and tracks share eligibility.
- The database layer owns persistence; this package owns only the score math.

## Main exports

- `computeScore(findings, scan)`: returns `ScoreResult` with `score`, `grade`, and `breakdown`.
- `ScoreGrade`, `ScoreSeverity`, `ScoreStatus` types
- `FindingInput`, `ScanInput`, `ScoreBreakdown`, `ScoreResult`
- `WEIGHTS`

## Usage

```ts
import { computeScore } from "@lyrashield/score"

const result = computeScore(findings, { mode: "STANDARD", isDefaultBranch: true })
// result.score, result.grade, result.shareEligible
```

## See also

- `packages/db/src/score-service.ts`
- `codebase.md` §33 for the scorecard and sharing architecture.
