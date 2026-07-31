# LyraShield Agent

Approval-gated agent action service for the LyraShield MCP and CLI.

## Purpose

- Defines and executes agent actions (e.g., list targets, run scans, get status) behind a permission and approval gate.
- Each action declares an input schema, required permission, and optional `needsApproval` check.
- Returns `PENDING` with an `approvalId` when an action needs human approval; the caller can re-invoke with the approval to execute.
- Actions are consumed by the MCP server (`packages/mcp`) and the CLI (`packages/cli` via `mcp call`).

## Tech stack

- Node.js 20+ with TypeScript and `tsx`
- `bullmq` for scan job enqueue
- `@lyrashield/auth`, `@lyrashield/db`, `@lyrashield/integrations`, `@lyrashield/types`, `@lyrashield/logger`

## Scripts

```bash
pnpm dev
pnpm build
pnpm start
pnpm typecheck
pnpm lint
```

## See also

- `packages/mcp/README.md`
- `packages/types` for `AgentActionDefinition`.
- `codebase.md` §27 for the agent action layer.
