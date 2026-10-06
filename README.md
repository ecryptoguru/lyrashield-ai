# LyraShield AI

Evidence-backed release assurance for AI-built software — for humans and for the coding agents building it.

LyraShield AI turns a target into a release-assurance loop:

`Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`

It keeps detected findings, independently verified evidence, retest-confirmed results, and inconclusive checks distinct. A score or AI suggestion is never treated as proof by itself.

## Why LyraShield

A scanner tells you what it flagged. LyraShield tells you what was tested, what was proven, what remains unknown — and hands you a record you can show to a client, investor or reviewer. Eight design choices carry that difference:

1. **Evidence states, not confidence scores.** Every result is `DETECTED`, `VALIDATED`, `VERIFIED` or `INCONCLUSIVE`. Confidence is triage metadata; engine-only absence is always inconclusive; a clean retest is retest-confirmed, never silently "verified".
2. **Built for how AI-built apps actually fail.** The public AI-Built Failure Taxonomy, eight AI App Security signals (AI-01–AI-08) mapped to the OWASP Top 10 for LLM Applications (2025), and 14 WebMCP controls that review the agent tool surface itself — agent rules, MCP configs, embedded secrets, prompt-injection exposure.
3. **Agent-native.** Assurance runs where the coding agent already works: published CLI, MCP server (21 tools, stdio + remote Streamable HTTP with hosted OAuth), portable Agent Plugin, a 51-entry install registry resolving to 48 preferred client surfaces, and an account-less GitHub Action.
4. **An approval-gated fix loop that closes itself.** Fix PRs come only from a server-generated patch bound to an explicit human approval — no client-authored patches, nothing auto-merges. A merged fix branch automatically queues a retest and re-evaluates the gate.
5. **A launch verdict anyone can verify.** The Launch Gate (`lyrashield-gate/2.3.0`) produces `READY` / `NOT_READY` / `INSUFFICIENT_EVIDENCE` per target; reports are ed25519-signed with a public verify endpoint; release-identity confirmation answers only `MATCH`, `MISMATCH` or `UNAVAILABLE`.
6. **Honest coverage accounting.** The Vibe Security 50 contract (`vibe-security-50/1.2.0`) records one immutable receipt per control — "no finding" is never "passed", and seven evidence-required controls are marked as such because no scan can prove them.
7. **Two modes, one loop.** Cloud (subscription; LyraShield pays model cost) and Local/Desktop (one-year BYOK license with perpetual fallback; scans stay on your machine, nothing syncs by default).
8. **Fail-closed trust architecture.** Postgres RLS tenant isolation, untrusted and bounded engine output, and every result manifest binding the exact product revision, worker image digest and engine revision into its checksum.

These are design commitments, not detection-performance claims — see the claims boundary in [PRD §1](PRD.md#1-product-definition) and [policies.md](docs/policies.md).

## Try it

LyraShield AI is live in **open beta with open registration** — anyone can create a free account today. There is no waitlist or invitation gate.

- Create a free account: [app.lyrashieldai.com/sign-up](https://app.lyrashieldai.com/sign-up)
- Marketing and methodology: [lyrashieldai.com](https://lyrashieldai.com)
- Public passive Lite Check: [lyrashieldai.com/scan](https://lyrashieldai.com/scan)
- Authenticated workspace: [app.lyrashieldai.com](https://app.lyrashieldai.com)
- User guide: [docs/user-guide.md](docs/user-guide.md)
- LyraShield Local/Desktop: the BYOK desktop implementation supports a one-time 1-year license with perpetual fallback and customer-supplied ChatGPT/OpenAI or Azure OpenAI credentials. Public production distribution remains a separate signing and release gate.

The public Lite Check is a bounded public-surface review. It is not the authenticated full scan pipeline and does not claim universal coverage. Repository scans are admitted only while the dedicated production worker holds a live lease. The current Standard/Luna acceptance is complete; broader exposure still requires the evidence-storage, monitoring/capacity, failure-recovery, and separate authorized Deep/Sol gates in `PRD.md`.

## Use it from your coding agent

LyraShield ships three ways to run checks without leaving your editor or CI pipeline:

**CLI** — preview client setup and run local or CI checks:

```bash
npx -y lyrashield@0.2.14 login --oauth  # select one workspace in the browser
npx -y lyrashield@0.2.14 init --dry-run # preview the client's setup
npx -y lyrashield@0.2.14 gate          # CI-friendly diff-aware security gate
npx -y lyrashield@0.2.14 skills install pi --project # install LyraShield workflow skills for Pi
```

`lyrashield` is published on npm (also available as the scoped alias `@lyrashield/cli`, now deprecated). It installs through the paths defined in `packages/agent-registry`:

- **Agent Plugin** — the published `@lyrashield/agent-plugin` package provides portable artifacts for supported clients. The CLI gives client-specific setup guidance where a writable local plugin path is not verified; public marketplace listing and authenticated client acceptance are tracked separately. Plugin files never inline a raw API key.
- **Config-file** — the published CLI merges entries while preserving unrelated settings, refuses symlinked destinations and malformed roots, and preserves existing file permissions. It refuses to place a raw API key in a conventionally shared file unless you explicitly pass `--inline-secret` and the file is gitignored.
- **Guided manual** — for clients whose tooling has no writable config file, the CLI prints exact copy-paste command/argument/env values.
- **Vendor CLI** — Amp is configured by shelling out to `amp mcp add`.

The coordinated CLI release adds the safe atomic config writer and shared skills installer. Config-file commands remain limited to clients whose install contract matches the verified CLI release; the CLI preserves unrelated settings and customized skills.

Run `npx -y lyrashield@0.2.14 doctor` to inspect local configuration and credentials. Client activation and authenticated acceptance remain separate checks.

**MCP server** — for editors that speak Model Context Protocol directly:

```json
{
  "mcpServers": {
    "lyrashield": {
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp@0.2.12"],
      "env": { "LYRASHIELD_API_URL": "https://app.lyrashieldai.com" }
    }
  }
}
```

`@lyrashield/mcp` is published on npm with 21 tools (read-only inspection plus scoped scan, attachment, fix and retest actions), both stdio and remote Streamable-HTTP transports and a [tool catalog](packages/mcp/README.md). A connected OAuth client runs its authorized operations automatically within its connection grant. Hosted mutations without a valid delegation — including API-key and legacy-token calls — receive one structured `connect_required` response pointing at OAuth connect; nothing is queued and no mutation executes. Authorized API keys can use read-only tools. The current source registry resolves 51 install entries into 48 preferred client surfaces, with client-specific setup at [lyrashieldai.com/docs/integrations](https://lyrashieldai.com/docs/integrations). The portable Agent Plugin package is versioned `0.1.31`; public marketplace listing and client-runtime acceptance are tracked separately.

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
- `packages/agent-registry` — the single source of truth for 51 install entries resolving to 48 preferred client surfaces. The CLI installers and docs site are generated against it.
- `packages/agent-plugin` — the portable Agent Plugins v1.0.0 package. Version 0.1.31 provides Cursor Streamable HTTP support and six skills, including the backward-compatible `lyrashield` skill, for five preferred Agent Plugin clients (Claude Code, Cursor, OpenAI Codex, GitHub Copilot and Kiro). GitHub Copilot remains experimental until a retained client-runtime receipt exists.
- `packages/agent-rules` — renders LyraShield's security policy into each agent's native rules/instructions format (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, and others).
- `packages/mcp` — the published `@lyrashield/mcp` server.
- `packages/sdk` — the typed REST client shared by the CLI and the MCP server, so their behavior can't drift apart.
- `packages/billing` — Polar + Razorpay dual-gateway billing, usage metering, entitlement gating, trial lifecycle, and grace period handling.
- `packages/pricing` — cloud plan definitions, minute packs, and local SKUs. See [commercial terms](PRD.md#5-commercial-model).
- `packages/licenses` — ed25519 signed license sign/verify for the Local/Desktop app.
- `packages/affiliate` — commission engine, attribution, fraud controls, and payout ledger (RazorpayX/Payoneer).
- `packages/evidence-storage` — envelope encryption (AES-256-GCM) for scan artifacts.
- `packages/*` (remaining) — auth, configuration, credentials, database, integrations, logger, score, security, types, UI.

The fixed live AI safety catalog lives in `packages/types/src/ai-safety-tests.ts`; historical result provenance is recorded in [codebase.md](codebase.md#3-repository-map).

The authenticated workflow supports project targets, findings, deterministic receipts, immutable manifests, score snapshots, reports, schedules, notifications, GitHub integrations, and privacy-bounded sharing. Fix PR execution runs through a server-generated patch pipeline that is bound to explicit human approval and never merges.

## Evidence states

See [PRD §3](PRD.md#3-scan-and-evidence-contract) for the evidence-state vocabulary and claims boundary.

## Local setup

Prerequisites: Node.js 24, pnpm 12.2.0 (pinned in `package.json`), Docker, and an environment file based on `.env.example`. CI and production container stages use the same Node major; the container base is pinned by digest.

```bash
pnpm install
pnpm --filter @lyrashield/db generate
pnpm db:migrate
pnpm --filter @lyrashield/web dev
```

For production-like local validation:

```bash
pnpm --filter @lyrashield/sdk build
pnpm --filter @lyrashield/mcp build
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

`pnpm test` includes PostgreSQL-backed RLS checks. Use a migrated, disposable local
database for `DATABASE_URL` and a separate `NOSUPERUSER NOBYPASSRLS` role for
`RLS_RUNTIME_DATABASE_URL`; the CI database setup in `.github/workflows/ci.yml`
shows the required grants. The SDK and MCP builds above provide package entry
points used by CLI and API tests in a fresh checkout. Never aim fixture suites
at a development database containing user data or at production.

The account-preference RLS runtime test requires an explicit opt-in. Point
`DATABASE_URL` at the owner role and `RLS_RUNTIME_DATABASE_URL` at the restricted
role on the **same disposable local database**. Its safety guard accepts only
`lyrashield_test`, `v15_product`, or `lyra_v18_ci`; both URLs must use the same
local host and port. Then run:

```bash
ACCOUNT_PREFERENCE_RLS_RUNTIME_TEST=1 pnpm exec vitest run packages/db/src/account-preference.rls.runtime.test.ts
```

Without the opt-in, this suite is skipped. CI runs it explicitly and requires it
to execute successfully.

The full worker requires a BullMQ-compatible Redis URL, private evidence storage, the controlled engine image/runtime, and Azure model configuration. It intentionally refuses scan admission if no live worker is registered.

For the desktop app (LyraShield Local/Desktop):

```bash
cd apps/desktop && pnpm tauri dev
```

Requires Rust 1.77+ and Docker for scans.

### Azure AI Foundry runtime configuration

Repository scans require GPT-6 Luna for Safe/Quick/Standard and GPT-6 Sol with Luna specialists for Deep/Custom. Configure `LYRASHIELD_LUNA_LLM` and `LYRASHIELD_SOL_LLM`; `LYRASHIELD_LLM` remains an explicit fallback for non-Deep routes. Keep `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, and `AZURE_API_VERSION` tied to the same Foundry project/resource. Empty routed values are intentionally omitted from the engine process so fallback selection remains deterministic.

The configured Azure Foundry endpoint supports baseline Responses requests and `previous_response_id`, but it rejects the `programmatic_tool_calling` tool type. Production therefore uses direct JSON function tools. Leave `LYRASHIELD_PROGRAMMATIC_TOOL_CALLING` unset unless the engine's bounded `lyrashield provider-contract --require-programmatic-tool-calling` gate succeeds for the exact deployment. `previous_response_id` alone does not enable persistent scan reasoning: the engine currently uses SQLite session persistence, which the Agents SDK does not permit alongside `previous_response_id`.

### Web Search (Parallel Search)

Repository scans can optionally call Parallel Search for real-time OSINT. Set `LYRASHIELD_WEB_SEARCH_ENABLED=1` and `LYRASHIELD_WEB_SEARCH_API_KEY` in the worker environment. The engine redacts target hosts, secrets, and PII from the query, limits results and calls by `LYRASHIELD_WEB_SEARCH_MAX_RESULTS` and `LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN`, and tracks cost against `LYRASHIELD_WEB_SEARCH_BUDGET_USD`. Production workers must also allow egress to `api.parallel.ai:443` in `ops/worker/refresh-egress.sh`. No scan mode is gated today; the tool is available whenever it is enabled.

## Engine derivative and upstream maintenance

Repository reviews run through [LyraShield Engine](https://github.com/ecryptoguru/lyrashield-engine), the separately versioned sandboxed analysis process used by the worker. It is a controlled derivative of [Strix](https://github.com/usestrix/strix), not a claim that upstream results or benchmarks apply to LyraShield.

LyraShield owns the product-critical execution contract: GPT-6 model policy, bounded context/output/agent/spend controls, non-interactive lifecycle and telemetry-off behavior, deterministic finding identity, evidence/control metadata, and the bounded worker artifacts. The upstream substrate remains responsible for reviewed generic sandbox, tool, agent-SDK, and vulnerability-skill plumbing. Read the engine's [ownership boundary](https://github.com/ecryptoguru/lyrashield-engine#ownership-boundary) and [upstream-import ledger](https://github.com/ecryptoguru/lyrashield-engine/blob/main/UPGRADES.md) for the exact line.

Upgrades are deliberately review-gated: the engine records its incorporated Strix base, compares stable releases, prepares a review PR, and requires human approval plus its read-only CI gate. It never auto-resolves conflicts, force-pushes history, or deploys from the sync workflow. The [engine verification and upgrade guidance](https://github.com/ecryptoguru/lyrashield-engine#verification) describes the checks; they prove implementation compatibility, not scan accuracy or universal coverage.

The application pins an exact engine commit in `.github/workflows/deploy-azure.yml`, executes the engine-owned worker contract against that checkout, builds the worker with it, and verifies the exact pushed worker digest before deployment can succeed. A separate operator promotion reconciles that immutable digest on the dedicated worker VM; it never follows `latest` or another mutable tag. A new engine release is not active until that pin is deliberately advanced, the cross-repository gate passes, and the resulting worker digest is explicitly promoted.

## Security and release boundaries

- Workspace data is tenant-scoped; sensitive operations are audit-logged; and child tables (`ScanEvent`, `Evidence`, `FixProposal`, `PullRequest`, `ScanCoverageReceipt`, `ScanResultManifest`, `ScorecardShare`, `ScorecardEvent`, `Ticket`) are protected by Postgres RLS.
- Engine output is treated as untrusted; only independent verifier evidence can mark a finding verified.
- URL/API targets use pinned deterministic URL scanners with a versioned `url-scan/3.0.0` capability registry (six profiles: Surface, Expanded Surface, Behavioral Surface, Endpoint, Contract, Contract Behavior Review) rather than the repository engine.
- Queue admission fails closed without a healthy worker heartbeat.
- Public scorecard payloads are allowlisted and sharing is revocable.
- The MCP server's mutating tools (start a scan, record a fix, queue a retest) run within the connection grant for a connected OAuth client — their authorized operations execute automatically without a per-action approval. A caller without a connected client receives one structured `connect_required` response pointing at OAuth connect. The PENDING/approvalId cycle is retired on the remote path; historical approval records remain viewable and resolvable through the REST routes.
- The public marketing surface and the authenticated workspace have separate deployment boundaries.
- Worker image provenance is verified end-to-end: PR CI proves the pinned engine commit is merged, its engine checks passed, and the worker contract is compatible; the main deployment repeats provenance/contract checks, builds the SHA-only worker candidate, pulls its exact digest, and verifies app and engine OCI labels before any deploy. Operator promotion of that digest on the worker VM remains a separate manual action.

See [PRD release status](PRD.md#9-release-status) for the current deployment and verification gates. Do not treat this repository, the Lite Check, the CLI, or a local run as proof of an authenticated provider-backed production scan.

## Further reading

See the [documentation map](docs/README.md) for current owners, including the [operator runbook](docs/operations.md), the [litepaper](docs/litepaper.md) (executive overview), the [whitepaper](docs/whitepaper.md) (authoritative public description) and the [yellowpaper](docs/yellowpaper.md) (technical specification).

## License

The LyraShield AI source code in this repository is available under the [MIT License](LICENSE). Third-party dependencies and separately referenced upstream projects retain their own licenses. The LyraShield AI name and logos are not granted for use by the MIT License.
