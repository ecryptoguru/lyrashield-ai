# Plugin UX Improvements

## Goal

Make the LyraShield agent plugin truly one-command: auto-detect the current project, remember it as the default, switch projects easily, and have the agent skill guide the user through the right scan mode with clear examples and cost awareness.

## Decisions (confirmed)

- Billing stays cost-aware but billing-agnostic for now; future SaaS will use minutes per month. The plugin should make mode choice clear and nudge toward the cheapest mode that fits the task.
- Auto-target covers git repos only in the first pass; local dev server discovery is out of scope.
- Default project (`lyrashield project use`) is implemented, plus `lyrashield project list` and `lyrashield project switch` so users can change projects.
- Skill tone is contextual: decision table + example prompts, not prescriptive.

## Tasks

- [x] **Task 1 — SKILL.md rewrite**
  - Add a "Mode and cost guide" table mapping user intent to goal + mode.
  - Add example user prompts and the exact agent tool call for each.
  - Simplify the scope clause and keep it honest.
  - Verify: buildPlugin still passes and `pnpm --filter @lyrashield/agent-plugin test` passes.

- [x] **Task 2 — CLI project default commands**
  - Add `lyrashield project use [path|repo]` — detect git repo (`git remote -v`), create or reuse a repo target via `/targets`, and store `defaultTargetId` + `workspaceId` in `~/.lyrashield/project.json`.
  - Add `lyrashield project list` — list registered workspace targets.
  - Add `lyrashield project switch <targetId>` — change the current default.
  - Verify: `pnpm --filter @lyrashield/cli test` passes.

- [x] **Task 3 — CLI scan auto-target**
  - Add `--auto` to `lyrashield scan` and `lyrashield pr-scan`.
  - `--auto` detects the current repository and an explicit `--repo` takes precedence over the saved default project.
  - Skip `--target` requirement when default or auto-resolved target exists.
  - Verify: CLI tests cover auto-target success, missing git repo, and fallback to target ID.

- [x] **Task 4 — MCP auto-target**
  - Extend `lyrashield_scan_target` and `lyrashield_run_pr_scan` to accept `repo` (owner/repo or full git URL) and `auto` boolean.
  - Resolve `repo` to an existing target or create a new repo target through the API.
  - Keep current `targetId` behavior unchanged. `auto` is available only in the local stdio server; hosted MCP requests must provide `repo` or `targetId`.
  - Verify: `pnpm --filter @lyrashield/mcp test` passes.

- [x] **Task 5 — Readme and userguide updates**
  - Update `packages/agent-plugin/README.md`, `packages/cli/README.md`, and `userguide.md` with the new `lyrashield project use`, `lyrashield project switch`, and `lyrashield scan --auto` flows.
  - Add the mode guide to the userguide.
  - Verify: docs render correctly and `pnpm format:check` passes.

- [x] **Task 6 — Final validation**
  - Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and the affected package tests.
  - Run `git diff --check`, package-install smoke coverage, and focused regressions for explicit-repository precedence, paginated target reuse, remote MCP behavior, and concurrent plugin builds.

## Out of scope

- Local dev server auto-detection and URL auto-attestation.
- Billing/minute-credit implementation or dashboard changes.
