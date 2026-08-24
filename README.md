# LyraShield AI

Evidence-backed release assurance for AI-built software — for humans and for the coding agents building it.

LyraShield AI turns a target into a release-assurance loop:

`Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`

It keeps detected findings, independently verified evidence, retest-confirmed results, and inconclusive checks distinct. A score or AI suggestion is never treated as proof by itself.

## Try it

LyraShield AI is live in **open beta with open registration** — anyone can create a free account today. There is no waitlist or invitation gate.

- Create a free account: [app.lyrashieldai.com/sign-up](https://app.lyrashieldai.com/sign-up)
- Marketing and methodology: [lyrashieldai.com](https://lyrashieldai.com)
- Public passive Lite Check: [lyrashieldai.com/scan](https://lyrashieldai.com/scan)
- Authenticated workspace: [app.lyrashieldai.com](https://app.lyrashieldai.com)
- User guide: [userguide.md](userguide.md)
- LyraShield Local/Desktop: the BYOK desktop implementation supports a one-time 1-year license with perpetual fallback and customer-supplied ChatGPT/OpenAI or Azure OpenAI credentials. Public production distribution remains a separate signing and release gate.

The public Lite Check is a bounded public-surface review. It is not the authenticated full scan pipeline and does not claim universal coverage. Repository scans are admitted only while the dedicated production worker holds a live lease. The current Standard/Luna acceptance is complete; broader exposure still requires the evidence-storage, monitoring/capacity, failure-recovery, and separate authorized Deep/Terra gates in `PRD.md`.

## Use it from your coding agent

LyraShield ships three ways to run checks without leaving your editor or CI pipeline:

**CLI** — install and configure any supported agent in one command:

```bash
npx lyrashield login --oauth      # select one workspace in the browser (recommended)
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

`@lyrashield/mcp` is published on npm with 14 tools (read-only inspection plus scan/fix/retest actions gated behind human approval) and both stdio and remote Streamable-HTTP transports. Full per-agent setup for 26 preferred client surfaces is at [lyrashieldai.com/docs/integrations](https://lyrashieldai.com/docs/integrations). The `@lyrashield/agent-plugin` package is now v0.1.18 with Cursor streamable-http support, and the `packages/agent-registry` resolves its 30 install entries into those preferred surfaces.

**GitHub Action** — a diff-aware CI gate that needs no LyraShield account, using `action.yml` at the repository root:

```yaml
- uses: ecryptoguru/lyrashield-ai@v2
  with:
    fail_on_severity: HIGH
```

It runs entirely in your own runner with your own `GITHUB_TOKEN`, emits SARIF for GitHub Code Scanning, and every third-party action it uses is SHA-pinned. v2 accepts local `SAFE` and `AGGRESSIVE` modes and rejects `DEEP` with directions to the hosted scan. The frozen v1 tag remains available for existing workflows while they migrate.

## What is here

- `apps/web` — Next.js workspace for targets, scans, evidence, reports, scorecards, and approval-gated API/MCP actions.
- `apps/worker` — BullMQ scan worker with queue admission, reconciliation, evidence receipts, controlled engine execution, URL/API deterministic scanners (public-surface collector, behavior probes, OpenAPI contract scanner), and worker image provenance verification.
- `apps/marketing` — Astro 7 / Cloudflare Workers marketing site.
- `apps/marketing-motion` — deterministic Three.js assurance-world motion workspace; the Astro site consumes rendered posters and clips.
- `apps/desktop` — Tauri v2 BYOK desktop app (LyraShield Local/Desktop). Rust core + React frontend, ed25519 license verification, OS keychain BYOK credentials, and optional cloud sync.
- `packages/cli` — the published `lyrashield` command-line tool. (`@lyrashield/cli` is deprecated and will be removed in the next major release; use `lyrashield` instead.)
- `packages/agent-registry` — the single source of truth for 30 install entries resolving to 26 preferred client surfaces. It retains three explicit config-file alternatives for plugin-preferred clients plus one experimental VS Code plugin entry. The CLI installers and the docs site are both generated against it.
- `packages/agent-plugin` — the portable Agent Plugins v1.0.0 package (now v0.1.18 with Cursor streamable-http support) that bundles the MCP server and a `lyrashield` skill for the five preferred Agent Plugin clients (Claude Code, Cursor, OpenAI Codex, GitHub Copilot, Kiro). GitHub Copilot remains experimental until a retained client-runtime receipt exists.
- `packages/agent-rules` — renders LyraShield's security policy into each agent's native rules/instructions format (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, and others).
- `packages/mcp` — the published `@lyrashield/mcp` server.
- `packages/sdk` — the typed REST client shared by the CLI and the MCP server, so their behavior can't drift apart.
- `packages/billing` — Polar + Razorpay dual-gateway billing, usage metering, entitlement gating, trial lifecycle, and grace period handling.
- `packages/pricing` — plan definitions (TRIAL/STARTER/PRO/TEAM/AGENCY), minute packs, and local SKUs.
- `packages/licenses` — ed25519 signed license sign/verify for the Local/Desktop app.
- `packages/affiliate` — commission engine, attribution, fraud controls, and payout ledger (RazorpayX/Payoneer).
- `packages/evidence-storage` — envelope encryption (AES-256-GCM) for scan artifacts.
- `packages/*` (remaining) — auth, configuration, credentials, database, integrations, logger, score, security, types, UI.

The former `packages/eval-ai-safety` runner was removed as unused. Its versioned 2026-08-13 result artifact remains in `apps/marketing/src/data/ai-safety-results.json`; the current fixed live AI safety catalog lives in `packages/types/src/ai-safety-tests.ts`.

The authenticated workflow supports project targets, findings, deterministic receipts, immutable manifests, score snapshots, reports, schedules, notifications, GitHub integrations, and privacy-bounded sharing. Fix PR execution remains deliberately fail-closed until a server-generated patch pipeline is bound to an approval.

## Evidence states

| State                  | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Detected               | A scanner observed a candidate finding.                        |
| Independently verified | Separate verification evidence exists.                         |
| Retest-confirmed       | A clean deterministic retest had complete applicable coverage. |
| Inconclusive           | Available evidence cannot establish the claim.                 |

## Local setup

Prerequisites: Node.js 24, pnpm 11, Docker, and an environment file based on `.env.example`. CI and production container stages use the same Node major; the container base is pinned by digest.

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

For the desktop app (LyraShield Local/Desktop):

```bash
cd apps/desktop && pnpm tauri dev
```

Requires Rust 1.77+ and Docker for scans.

### Azure AI Foundry runtime configuration

Repository scans accept only GPT-5.6 Terra or Luna deployments. Configure `LYRASHIELD_LUNA_LLM` and `LYRASHIELD_TERRA_LLM` for the normal routes, or set `LYRASHIELD_LLM` as their explicit fallback. Keep `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, and `AZURE_API_VERSION` tied to the same Foundry project/resource. Empty routed values are intentionally omitted from the engine process so fallback selection remains deterministic.

The configured Azure Foundry endpoint supports baseline Responses requests and `previous_response_id`, but it rejects the `programmatic_tool_calling` tool type. Production therefore uses direct JSON function tools. Leave `LYRASHIELD_PROGRAMMATIC_TOOL_CALLING` unset unless the engine's bounded `lyrashield provider-contract --require-programmatic-tool-calling` gate succeeds for the exact deployment. `previous_response_id` alone does not enable persistent scan reasoning: the engine currently uses SQLite session persistence, which the Agents SDK does not permit alongside `previous_response_id`.

### Web Search (Parallel Search)

Repository scans can optionally call Parallel Search for real-time OSINT. Set `LYRASHIELD_WEB_SEARCH_ENABLED=1` and `LYRASHIELD_WEB_SEARCH_API_KEY` in the worker environment. The engine redacts target hosts, secrets, and PII from the query, limits results and calls by `LYRASHIELD_WEB_SEARCH_MAX_RESULTS` and `LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN`, and tracks cost against `LYRASHIELD_WEB_SEARCH_BUDGET_USD`. Production workers must also allow egress to `api.parallel.ai:443` in `ops/worker/refresh-egress.sh`. No scan mode is gated today; the tool is available whenever it is enabled.

## Engine derivative and upstream maintenance

Repository reviews run through [LyraShield Engine](https://github.com/ecryptoguru/lyrashield-engine), the separately versioned sandboxed analysis process used by the worker. It is a controlled derivative of [Strix](https://github.com/usestrix/strix), not a claim that upstream results or benchmarks apply to LyraShield.

LyraShield owns the product-critical execution contract: GPT-5.6 model policy, bounded context/output/agent/spend controls, non-interactive lifecycle and telemetry-off behavior, deterministic finding identity, evidence/control metadata, and the bounded worker artifacts. The upstream substrate remains responsible for reviewed generic sandbox, tool, agent-SDK, and vulnerability-skill plumbing. Read the engine's [ownership boundary](https://github.com/ecryptoguru/lyrashield-engine#ownership-boundary) and [upstream-import ledger](https://github.com/ecryptoguru/lyrashield-engine/blob/main/UPGRADES.md) for the exact line.

Upgrades are deliberately review-gated: the engine records its incorporated Strix base, compares stable releases, prepares a review PR, and requires human approval plus its read-only CI gate. It never auto-resolves conflicts, force-pushes history, or deploys from the sync workflow. The [engine verification and upgrade guidance](https://github.com/ecryptoguru/lyrashield-engine#verification) describes the checks; they prove implementation compatibility, not scan accuracy or universal coverage.

The application pins an exact engine commit in `.github/workflows/deploy-azure.yml`, executes the engine-owned worker contract against that checkout, builds the worker with it, and verifies the exact pushed worker digest before deployment can succeed. A separate operator promotion reconciles that immutable digest on the dedicated worker VM; it never follows `latest` or another mutable tag. A new engine release is not active until that pin is deliberately advanced, the cross-repository gate passes, and the resulting worker digest is explicitly promoted.

## Security and release boundaries

- Workspace data is tenant-scoped; sensitive operations are audit-logged; and child tables (`ScanEvent`, `Evidence`, `FixProposal`, `PullRequest`, `ScanCoverageReceipt`, `ScanResultManifest`, `ScorecardShare`, `ScorecardEvent`, `Ticket`) are protected by Postgres RLS.
- Engine output is treated as untrusted; only independent verifier evidence can mark a finding verified.
- URL/API targets use pinned deterministic URL scanners with a versioned `url-scan/2.0.0` capability registry (six profiles: Surface, Expanded Surface, Behavioral Surface, Endpoint, Contract, Contract Behavior Review) rather than the repository engine.
- Queue admission fails closed without a healthy worker heartbeat.
- Public scorecard payloads are allowlisted and sharing is revocable.
- The MCP server's mutating tools (start a scan, record a fix, queue a retest) require human approval before executing, both locally and over the remote endpoint.
- The public marketing surface and the authenticated workspace have separate deployment boundaries.
- Worker image provenance is verified end-to-end: PR CI proves the pinned engine commit is merged, its engine checks passed, and the worker contract is compatible; the main deployment repeats provenance/contract checks, builds the SHA-only worker candidate, pulls its exact digest, and verifies app and engine OCI labels before any deploy. Operator promotion of that digest on the worker VM remains a separate manual action.

See [PRD release status](PRD.md#9-release-status) and the [production smoke-test plan](docs/ops/production-smoke-test-plan.md) for the current deployment and verification gates. Do not treat this repository, the Lite Check, the CLI, or a local run as proof of an authenticated provider-backed production scan.

## Further reading

- [AGENTS.md](AGENTS.md) — current implementation state, execution queue, and non-negotiable rules for anyone (human or AI) working in this codebase.
- [codebase.md](codebase.md) — the architecture and implementation map.
- [PRD.md](PRD.md) — product strategy and the release-readiness backlog.
- [Phase2.md](Phase2.md) — verbatim Phase 2 and future-roadmap archive from the original PRD.
- [docs/README.md](docs/README.md) — documentation ownership, categories, and retention policy.
- [product.md](product.md) — current positioning and founder decisions.
- [monetization.md](monetization.md) — business and pricing plan (plans, minute packs, affiliate payouts).
- [docs/ops/desktop-release-runbook.md](docs/ops/desktop-release-runbook.md) — release procedure for the Local/Desktop app.
- [docs/ops/license-signing-keys-runbook.md](docs/ops/license-signing-keys-runbook.md) — ed25519 license key generation and rotation.

## License

The LyraShield AI source code in this repository is available under the [MIT License](LICENSE). Third-party dependencies and separately referenced upstream projects retain their own licenses. The LyraShield AI name and logos are not granted for use by the MIT License.
