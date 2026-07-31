# @lyrashield/types

Shared Zod schemas and TypeScript types across the LyraShield monorepo.

## Purpose

- Single source of truth for domain enums and input schemas (workspaces, targets, scans, findings, schedules, reports, retests, agent approvals, etc.).
- Exports the BullMQ scan job payload shape shared by `apps/web` and `apps/worker`.
- Defines SARIF 2.1.0 and CVSS types used by reports and the engine.
- Provides agent-action input schemas and the `AgentActionDefinition` contract.

## Main exports

- `WorkspaceModeSchema`, `WorkspacePlanSchema`, `MemberRoleSchema`
- `TargetTypeSchema`, `TargetEnvironmentSchema`
- `ScanGoalSchema`, `ScanModeSchema`, `ScanStatusSchema`
- `FindingSeveritySchema`, `FindingStatusSchema`
- `CreateScanSchema`, `CreateRepoTargetSchema`, `CreateUrlTargetSchema`
- `CreateFixProposalSchema`, `CreateRetestSchema`, `CreateReportSchema`, `CreateScheduleSchema`
- `ScanJobData`, `AgentActionDefinition`, `AgentActionResult`
- `SarifReport`, `SarifRun`, `SarifRule`, `SarifResult`, `CvssScore`

## See also

- `packages/db` for generated Prisma types.
- `apps/agent` for agent action handlers.
