# @lyrashield/agent-rules

Render, add, remove, and validate per-agent rules and skill files.

## Purpose

- Produces the `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, and other instruction files that teach an AI coding agent about LyraShield policies.
- Exports rule policy helpers in `src/policy.ts` and renderer helpers in `src/renderers/index.js`.
- Provides `addRules`, `removeRules`, and `checkRules` for the CLI `rules` command.
- The `managed-block` discipline is tested in `src/__tests__/scan.test.ts`; the worker agent-config scanner checks these files for poisoned instructions.

## Main exports

- `listRuleFormats`, `renderRule`, `renderRuleForAgent`, `formatForRulesFile`, `resolveRuleFilePath`
- `addRules`, `removeRules`, `checkRules`
- Types: `RulePolicy`, `RuleFormat`

## Scripts

```bash
pnpm --filter @lyrashield/agent-rules typecheck
pnpm --filter @lyrashield/agent-rules test
pnpm --filter @lyrashield/agent-rules build
```

## See also

- `packages/agent-registry/README.md`
- `apps/worker/src/engine/scanners/agent-config-scanner.ts`
- `packages/cli/src/commands/rules.ts`
