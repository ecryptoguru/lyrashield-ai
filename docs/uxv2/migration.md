# UX V2 Migration and Rollout

This document records the rollout stages, flag names, fallback criteria, and the criteria for removing flags.

## Feature flags

All flags are evaluated in `apps/web/src/lib/flags.ts` and consumed via `useFeatureFlags()`.

| Flag                | Phase introduced | Default | Controls                                       |
| ------------------- | ---------------- | ------- | ---------------------------------------------- |
| `uxV2Shell`         | 0                | false   | Mobile shell, bottom navigation, radius tokens |
| `uxV2Onboarding`    | 2                | false   | Autonomous GitHub onboarding                   |
| `uxV2Runs`          | 5                | false   | Trust Runs screens and live progress           |
| `uxV2Issues`        | 6                | false   | Issues and Approval Centre screens             |
| `uxV2Evidence`      | 7                | false   | Evidence home and public verdict               |
| `uxV2Notifications` | 8                | false   | Notification centre and preferences            |
| `uxV2Sharing`       | 9                | false   | New share composer and card variants           |

## Rollout stages

1. **Internal preview** — `UX_V2_INTERNAL_USER_IDS` comma-separated user IDs.
2. **New-account beta** — `UX_V2_NEW_USERS_FROM` ISO date; users created on or after the date see V2.
3. **Opt-in migration** — per-workspace cookie override (`lyrashield-uxv2-flags`).
4. **Default experience** — all flags default to true.
5. **Legacy removal** — delete flags and fallback branches.

## Fallback preservation

Every V2 screen must render the existing screen when the corresponding flag is false. Legacy routes must continue to resolve until Stage 5.

## Removal criteria

- All visual-regression baselines pass.
- Activation funnel metrics are stable or improved.
- No critical regressions in lint, typecheck, unit tests, build, or E2E.
- Founder approval.
