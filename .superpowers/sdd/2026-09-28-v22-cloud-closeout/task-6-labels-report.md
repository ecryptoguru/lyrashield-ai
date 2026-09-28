# Task 6 label parity

Implemented scan goal label parity. The scan list and detail now use the existing canonical `GOAL_OPTIONS` mapping, so `CHECK_PR` renders as “Check a PR” and historical `SECURITY_REVIEW` as “Security scan” in both surfaces. Unknown goals preserve `getGoalLabel`'s humanized fallback (for example, `FUTURE_REVIEW` becomes “Future review”) in both surfaces. No separate DH-24 wording choice was made: this follows the existing canonical map.

Changed `apps/web/src/lib/labels.ts`, `apps/web/src/lib/enum-labels.ts`, and the scan list/detail component tests.

Verification:

- Focused Vitest run: 4 files, 25 tests passed, including rendered scan list/detail parity for `CHECK_PR`, `SECURITY_REVIEW`, and unknown `FUTURE_REVIEW`; `getGoalLabel` retains its humanized unknown-goal contract.
- `pnpm --filter @lyrashield/web typecheck`: failed with extensive pre-existing/generated-type errors across the web app and shared packages (for example incomplete inferred Prisma results in admin pages and Myra tools); none pointed to the changed label code.
