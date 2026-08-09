# LyraShield AI

Evidence-backed release assurance for AI-built software — for humans and for the coding agents building it.

LyraShield AI turns a target into a release-assurance loop:

`Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`

It keeps detected findings, independently verified evidence, retest-confirmed results, and inconclusive checks distinct. A score or AI suggestion is never treated as proof by itself.

## Try it

- Marketing and methodology: [lyrashieldai.com](https://lyrashieldai.com)
- Public passive Lite Check: [lyrashieldai.com/scan](https://lyrashieldai.com/scan)
- Authenticated workspace: [app.lyrashieldai.com](https://app.lyrashieldai.com) (open registration)
- User guide: [userguide.md](userguide.md)

The public Lite Check is a bounded public-surface review. It is not the authenticated full scan pipeline and does not claim universal coverage. Repository scans are admitted only while the dedicated production worker holds a live lease, and the current release gate requires a current-tree Safe retest plus a successful, reconciled Deep run.

## Use it from your coding agent

LyraShield ships three ways to run checks without leaving your editor or CI pipeline:

**CLI** — install and configure any supported agent in one command:

```bash
npx lyrashield login              # paste a workspace API key when prompted
npx lyrashield init                # detect installed agents and configure them
npx lyrashield gate                # CI-friendly diff-aware security gate
```

`lyrashield` is published on npm (also available as the scoped alias `@lyrashield/cli`, now deprecated). It installs via three strategies, all driven by the same `packages/agent-registry` source of truth:

- **Agent Plugin** — for the 4 launch clients with Agent Plugins v1.0.0 support today (Claude Code, Cursor, OpenAI Codex, Kiro), `npx lyrashield init` and `npx lyrashield install <agent>` prefer a portable plugin install from `@lyrashield/agent-plugin`. Plugin files land in the client-specific plugin directory and never inline a raw API key.
- **Config-file** — for 16 clients whose settings can be safely written, the CLI merges into the existing file, never overwrites, and refuses to place a raw API key in a conventionally shared file unless you explicitly pass `--inline-secret` and the file is gitignored.
- **Guided manual** — for 7 clients whose tooling has no writable config file (Cline, JetBrains, PiCode, OpenClaw, Hermes, Goose, Aider), the CLI prints exact copy-paste command/argument/env values.
- **Vendor CLI** — Amp is configured by shelling out to `amp mcp add`.

Run `npx lyrashield doctor` any time to check what's configured and what's missing.

**MCP server** — for editors that speak Model Context Protocol directly:

```json
{
  "mcpServers": {
    "lyrashield": {
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp"],
      "env": { "LYRASHIELD_API_KEY": "lsk_your_key" }
    }
  }
}
```

`@lyrashield/mcp` is published on npm with 14 tools (read-only inspection plus scan/fix/retest actions gated behind human approval) and both stdio and remote Streamable-HTTP transports. Full per-agent setup for Claude Code, Cursor, Windsurf, VS Code, Zed, and 19 others is at [lyrashieldai.com/docs/integrations](https://lyrashieldai.com/docs/integrations).

**GitHub Action** — a diff-aware CI gate that needs no LyraShield account, using `action.yml` at the repository root:

```yaml
- uses: ecryptoguru/lyrashield-ai@v1
  with:
    fail_on_severity: HIGH
```

It runs entirely in your own runner with your own `GITHUB_TOKEN`, emits SARIF for GitHub Code Scanning, and every third-party action it uses is SHA-pinned.

## What is here

- `apps/web` — Next.js workspace for targets, scans, evidence, reports, scorecards, and approval-gated API/MCP actions.
- `apps/worker` — BullMQ scan worker with queue admission, reconciliation, evidence receipts, and controlled engine execution.
- `apps/marketing` — Astro 7 / Cloudflare Workers marketing site.
- `apps/marketing-motion` — deterministic Three.js assurance-world motion workspace; the Astro site consumes rendered posters and clips.
- `packages/cli` — the published `lyrashield` command-line tool. (`@lyrashield/cli` is deprecated and will be removed in the next major release; use `lyrashield` instead.)
- `packages/agent-registry` — the single source of truth for 24 distinct coding agents rendered as 30 registry entries; 6 clients have both a config-file and a reserved `agent-plugin` entry. The CLI installers and the docs site are both generated against it.
- `packages/agent-plugin` — the portable Agent Plugins v1.0.0 package that bundles the MCP server and a `lyrashield` skill for the 4 launch clients with Agent Plugins support today (Claude Code, Cursor, OpenAI Codex, Kiro).
- `packages/agent-rules` — renders LyraShield's security policy into each agent's native rules/instructions format (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, and others).
- `packages/mcp` — the published `@lyrashield/mcp` server.
- `packages/sdk` — the typed REST client shared by the CLI and the MCP server, so their behavior can't drift apart.
- `packages/*` (remaining) — auth, configuration, database, integrations, logger, score, security, types, UI.

The authenticated workflow supports project targets, findings, deterministic receipts, immutable manifests, score snapshots, reports, schedules, notifications, GitHub integrations, and privacy-bounded sharing. Fix PR execution remains deliberately fail-closed until a server-generated patch pipeline is bound to an approval.

## Evidence states

| State                  | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Detected               | A scanner observed a candidate finding.                        |
| Independently verified | Separate verification evidence exists.                         |
| Retest-confirmed       | A clean deterministic retest had complete applicable coverage. |
| Inconclusive           | Available evidence cannot establish the claim.                 |

## Local setup

Prerequisites: Node.js 20+ (this monorepo and CI are validated on Node 24), pnpm, Docker, and an environment file based on `.env.example`.

```bash
pnpm install
pnpm --filter @lyrashield/db generate
pnpm db:migrate
pnpm dev
```

For production-like local validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

The full worker requires a BullMQ-compatible Redis URL, private evidence storage, the controlled engine image/runtime, and Azure model configuration. It intentionally refuses scan admission if no live worker is registered.

### Azure AI Foundry runtime configuration

Repository scans accept only GPT-5.6 Terra or Luna deployments. Configure `LYRASHIELD_LUNA_LLM` and `LYRASHIELD_TERRA_LLM` for the normal routes, or set `LYRASHIELD_LLM` as their explicit fallback. Keep `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, and `AZURE_API_VERSION` tied to the same Foundry project/resource. Empty routed values are intentionally omitted from the engine process so fallback selection remains deterministic.

The configured Azure Foundry endpoint supports baseline Responses requests and `previous_response_id`, but it rejects the `programmatic_tool_calling` tool type. Production therefore uses direct JSON function tools. Leave `LYRASHIELD_PROGRAMMATIC_TOOL_CALLING` unset unless the engine's bounded `lyrashield provider-contract --require-programmatic-tool-calling` gate succeeds for the exact deployment. `previous_response_id` alone does not enable persistent scan reasoning: the engine currently uses SQLite session persistence, which the Agents SDK does not permit alongside `previous_response_id`.

### Web Search (Parallel Search)

Repository scans can optionally call Parallel Search for real-time OSINT. Set `LYRASHIELD_WEB_SEARCH_ENABLED=1` and `LYRASHIELD_WEB_SEARCH_API_KEY` in the worker environment. The engine redacts target hosts, secrets, and PII from the query, limits results and calls by `LYRASHIELD_WEB_SEARCH_MAX_RESULTS` and `LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN`, and tracks cost against `LYRASHIELD_WEB_SEARCH_BUDGET_USD`. Production workers must also allow egress to `api.parallel.ai:443` in `ops/worker/refresh-egress.sh`. No scan mode is gated today; the tool is available whenever it is enabled.

## Engine derivative and upstream maintenance

Repository reviews run through [LyraShield Engine](https://github.com/ecryptoguru/lyrashield-engine), the separately versioned sandboxed analysis process used by the worker. It is a controlled derivative of [Strix](https://github.com/usestrix/strix), not a claim that upstream results or benchmarks apply to LyraShield.

LyraShield owns the product-critical execution contract: GPT-5.6 model policy, bounded context/output/agent/spend controls, non-interactive lifecycle and telemetry-off behavior, deterministic finding identity, evidence/control metadata, and the bounded worker artifacts. The upstream substrate remains responsible for reviewed generic sandbox, tool, agent-SDK, and vulnerability-skill plumbing. Read the engine's [ownership boundary](https://github.com/ecryptoguru/lyrashield-engine#ownership-boundary) and [upstream-import ledger](https://github.com/ecryptoguru/lyrashield-engine/blob/main/UPGRADES.md) for the exact line.

Upgrades are deliberately review-gated: the engine records its incorporated Strix base, compares stable releases, prepares a review PR, and requires human approval plus its read-only CI gate. It never auto-resolves conflicts, force-pushes history, or deploys from the sync workflow. The [engine verification and upgrade guidance](https://github.com/ecryptoguru/lyrashield-engine#verification) describes the checks; they prove implementation compatibility, not scan accuracy or universal coverage.

## Security and release boundaries

- Workspace data is tenant-scoped; sensitive operations are audit-logged; and child tables (`ScanEvent`, `Evidence`, `FixProposal`, `PullRequest`, `ScanCoverageReceipt`, `ScanResultManifest`, `ScorecardShare`, `ScorecardEvent`, `Ticket`) are protected by Postgres RLS.
- Engine output is treated as untrusted; only independent verifier evidence can mark a finding verified.
- URL targets use pinned deterministic URL scanners rather than the repository engine.
- Queue admission fails closed without a healthy worker heartbeat.
- Public scorecard payloads are allowlisted and sharing is revocable.
- The MCP server's mutating tools (start a scan, record a fix, queue a retest) require human approval before executing, both locally and over the remote endpoint.
- The public marketing surface and the authenticated workspace have separate deployment boundaries.

See [the production beta readiness plan](docs/plans/2026-07-20-production-beta-readiness.md) for the exact deployment and verification gates. Do not treat this repository, the Lite Check, the CLI, or a local run as proof of an authenticated provider-backed production scan.

## Further reading

- [AGENTS.md](AGENTS.md) — current implementation state, execution queue, and non-negotiable rules for anyone (human or AI) working in this codebase.
- [codebase.md](codebase.md) — the architecture and implementation map.
- [PRD.md](PRD.md) — product strategy and the release-readiness backlog.
- [product.md](product.md) — current positioning and founder decisions.

## License

The LyraShield AI source code in this repository is available under the [MIT License](LICENSE). Third-party dependencies and separately referenced upstream projects retain their own licenses. The LyraShield AI name and logos are not granted for use by the MIT License.
