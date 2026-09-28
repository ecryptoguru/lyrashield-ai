# Task 6 label parity

Implemented scan goal label parity. The scan list and detail now use the existing canonical `GOAL_OPTIONS` mapping, so `CHECK_PR` renders as “Check a PR” in both surfaces. Historical `SECURITY_REVIEW` remains “Security scan”; unknown scan-goal values retain their prior raw-token fallback in the enum helper. No separate DH-24 wording choice was made: this follows the existing canonical map.

Changed `apps/web/src/lib/labels.ts`, `apps/web/src/lib/enum-labels.ts`, and the scan list/detail component tests.

Verification:

- Focused Vitest run: 3 files, 24 tests passed.
- `pnpm --filter @lyrashield/web typecheck`: failed with extensive pre-existing/generated-type errors across the web app and shared packages (for example incomplete inferred Prisma results in admin pages and Myra tools); none pointed to the changed label code.
