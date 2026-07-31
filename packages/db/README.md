# @lyrashield/db

Prisma client, database services, migrations, and shared types for LyraShield.

## Purpose

- Defines the Prisma schema in `prisma/schema.prisma`.
- Generates the Prisma client and exports generated types from `src/generated/prisma`.
- Provides higher-level service modules for scans, findings, targets, reports, schedules, scorecards, agent approvals, and usage accounting.
- Owns all database migrations under `prisma/migrations/`.

## Main exports

- Prisma generated enums: `WorkspaceMode`, `WorkspacePlan`, `MemberRole`, `TargetType`, `ScanGoal`, `ScanMode`, `ScanStatus`, `FindingSeverity`, `FindingStatus`, `ScoreGrade`, `ReferralStatus`, etc.
- Prisma generated types: `Workspace`, `Target`, `Scan`, `Finding`, `FixProposal`, `Report`, `AgentApproval`, etc.
- Service modules: `scan-service.ts`, `finding-service.ts`, `agent-approval-service.ts`, `score-service.ts`, etc.

## Scripts

```bash
pnpm --filter @lyrashield/db generate
pnpm --filter @lyrashield/db migrate
pnpm --filter @lyrashield/db migrate:deploy
pnpm --filter @lyrashield/db studio
```

## See also

- `docs/deployment/LOCAL_SETUP.md`
- `codebase.md` for schema and migration notes.
