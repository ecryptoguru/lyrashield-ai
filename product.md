# LyraShield AI — Product, Positioning & GTM

> Internal launch guidance. `lyrashieldai.com` is the confirmed canonical public domain; trademark clearance remains a founder/legal decision. Do not treat this document as approved pricing or evidence of customer traction.

## Positioning

LyraShield AI is the evidence-backed release-assurance layer for AI-built software. It records what was tested, separates detected risks from independently verified findings and retest-confirmed fixes, and packages that truth for builders, clients, and technical reviewers. The operating loop is **Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report**. A Fix PR is a future execution step only when a server-generated patch is safely approval-bound.

The position is the combination, not a claim of unique capability: a solo builder and a security team can use the same loop at different depths, across UI, API, MCP, CLI, and GitHub workflows.

## Guardrails

- Never claim LyraShield AI is the only tool that verifies findings, creates fixes, or supports MCP.
- Do not publish benchmark, accuracy, pricing, customer, or social-proof claims.
- Do not present the forked engine as a public differentiator.
- Treat exploit validation as a product hygiene goal, not a quantified assurance claim.
- Name the product **LyraShield AI** in public copy; do not rename internal `@lyrashield/*` scopes or environment variables.

## Audience and message

| Audience                 | Useful framing                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| AI-assisted solo builder | “You shipped it quickly. Check it before you launch.”                            |
| Small SaaS team          | A security-review artifact: findings, fixes, retest, and a shareable report.     |
| Agency / dev shop        | Add a security report to each client handoff.                                    |
| Enterprise AppSec        | One loop from builder workflows to governed controls, audit trail, and CI gates. |

## LyraShield Score & shareable scorecards (approved 2026-07-12)

Every completed Standard/Deep scan produces a deterministic, versioned **LyraShield Score** (0–100 + grade). Users can opt in to a public scorecard page + OG card carrying their referral code; referred signups earn both sides agent-minute credits after the referred workspace completes its first real scan.

Scorecard guardrails (non-negotiable, enforced in code):

- The public card shows only: grade, scope line, scan date, methodology version, resolved-findings count. Never open findings, severities, CWEs, or target URLs.
- Copy is scope-qualified and states the score "is not a security guarantee." The scoring methodology is fully public (founder decision #1).
- Sharing is opt-in, role-restricted, audit-logged, revocable, and carries a supersession notice once a newer scan exists.
- Distribution supports premium grade and verified-fix cards, native/channel sharing, image downloads, and README badges. Growth measurement is limited to coarse allowlisted events; social renders never count as human views and analytics never receive target, repository, finding, IP, user-agent, or caption data.

The intended loop is **verified progress → useful public artifact → qualified visitor → new account → first completed real scan**. Views and share-button handoffs are diagnostic funnel signals, not vanity impressions or rewarded conversions. Referral rewards remain locked until the referred workspace completes its first real scan.

Channel copy should lead with the earned outcome (current scoped grade or retest-confirmed fixes), preserve the referral link, and send readers to the public methodology. Never manufacture urgency, customer proof, benchmark claims, or a higher grade than the frozen scorecard contains.

## Differentiation

Lead with a defensible release-assurance record:

1. Scan a repository or URL.
2. Record what completed, what was limited, and what remains evidence-required.
3. Separate detected candidates from independently verified findings.
4. Explain and prioritize the issue in plain language, then create an approval-gated fix proposal.
5. Run a server-owned retest and retain a validated or inconclusive outcome.
6. Share an immutable Assurance Story report or privacy-bounded scorecard.

SCA, secret scanning, URL checks, SARIF, and GitHub diff gates are important coverage layers, but are table stakes individually. Do not overstate parity with dedicated point tools.

## Product status

### Implemented

- Core workspaces, targets, scans, and scan orchestration.
- Source-aware SCA, secret, and agent-config handling.
- Pinned deterministic URL/API scanning with a versioned `url-scan/2.0.0` capability registry: six released profiles (Surface, Expanded Surface, Behavioral Surface, Endpoint, Contract, Contract Behavior Review) with bounded limits, SSRF-safe public-surface collection, Deep web behavior probes, OpenAPI contract parsing, and required ownership attestation.
- Fix proposals, queued retests, and reports.
- Notifications, schedules, and single-use agent approvals.
- GitHub integration refresh and the GitHub diff gate.
- Audit hash chaining and S3-compatible evidence upload with checksum-first retry deduplication.
- Hardened prompt-injection detection and shared queue/Redis helpers.
- The `lyrashield` CLI (`login/use/doctor/install/uninstall/init` plus scan, finding, and report commands).
- The `agent-registry` package that renders per-agent config for 24 distinct coding agents (30 registry entries, including 6 `agent-plugin` variants) in JSON/JSONC/TOML/YAML.
- Agent Plugins v1.0.0 support: the portable `@lyrashield/agent-plugin` package with confirmed manifests for Claude Code, Cursor, OpenAI Codex, and Kiro. The registry retains VS Code and GitHub Copilot entries as reserved, not yet verified, plugin variants.
- MCP: the stdio `@lyrashield/mcp` package and the remote Streamable HTTP endpoint at `/api/mcp`.
- Hosted OAuth for MCP remote clients with workspace selection, optional write scope, and preserved query parameters (PRs #247, #255, #257, #258).
- CLI OAuth device login writing `~/.lyrashield/credentials.json` with `0o600` (PR #247). The `@lyrashield/cli` scoped alias is deprecated in favor of `lyrashield`.
- Marketplace v0.1.8 export, client schema alignment, Zed Node capability, and ClawHub skill under MIT-0 (PRs #247, #263, #264).
- Email verification is implemented and load-bearing, but deliberately disabled in production pending a mail provider — an accepted, documented blocker; see `docs/deployment/PRODUCTION_DEPLOYMENT.md` "Known production blockers".
- Split marketing/app origin routing and the public Lite Scanner.
- LyraShield Score, cross-admin-idempotent public scorecards, referrals, and premium social sharing.
- Azure AI / GPT-5.6 mode routing (Safe/Quick/Standard → Luna/medium; Deep/Custom → Terra/medium with Luna/high specialists).
- Evidence-backed marketing surface with a public methodology page (release verdict scale: Go, Go with conditions, No go, Not evaluated) and five browser-local no-upload tools.
- Shared label module for consistent UI vocabulary with no raw database enums rendered.
- Per-workspace scan-creation rate limiting and concurrency caps.
- Audited status transitions with an optional persisted reason for accepted risk and false positive.
- Fail-closed scan queue admission: a live worker heartbeat is required; every enqueue path returns the same unavailable response; enqueue races fail the created scan with retained history; and conservative reconciliation never silently replays a paid scan.
- New scans retain a manifest, coverage receipts, candidate provenance, verification receipts, and private usage telemetry: detected, validated, and independently verified are separate states.
- Azure Foundry deployments use direct JSON function tools by default; the configured endpoint accepts baseline Responses and `previous_response_id` but rejects `programmatic_tool_calling`.
- Protected run limits and versioned per-request GPT-5.6 accounting remain internal; the dashboard shows neither model costs nor spend. Engine findings are not self-verified.
- **AI App Security scanner (Release A, 2026-08-13).** A deterministic static-analysis scanner for AI-specific risks mapped to the OWASP Top 10 for LLM Applications (2025). Eight signals (AI-01–AI-08) cover prompt-injection input validation, sensitive data in LLM context, AI library supply chain, LLM output in dangerous sinks, unbounded agent permissions, system prompt exposure, unauthenticated vector DB / RAG access, and missing LLM consumption limits. A free browser-local tool at `/tools/ai-app-security-scanner` runs AI-01, AI-02, and AI-04–AI-08 entirely in the browser with no upload; paid Standard and Deep scans rerun the same core across a repository snapshot, add AI-03 advisory enrichment, apply an optional bounded LLM triage overlay (off by default, additive only), and persist a private versioned AI App Security Score with separate coverage. The score is private, immutable, and excluded from public scorecards. Public copy says "mapped to OWASP" and never implies OWASP endorsement, certification, universal detection, or a safety guarantee. See `docs/plans/2026-08-13-ai-app-security-scanner.md` and `docs/claims-readiness.md`.
- **AI safety evaluation harness (2026-08-13).** `packages/eval-ai-safety/` evaluates LyraShield's deterministic `PromptInjectionGuard` (not an underlying LLM's general safety training) against the OWASP Gen AI Red Teaming Guide (42 test cases; 85.7% expected-outcome match) and the MLCommons AILuminate demo set (292 prompts; 4.5% guard-rule match, observational only). Results are published on `/ai-safety` with bounded, honest language.

### Live

- LyraShield AI is in **open beta with open registration**. The passive Lite Scanner, browser-local tools, and authenticated application are public, and access is via **create a free account** at `https://app.lyrashieldai.com/sign-up` — never a waitlist or invitation. The marketing email form is an optional product-updates subscription only.
- The authenticated app and full BullMQ/engine worker are a separate deployment surface; full repository scans require the worker pipeline and configured evidence storage.

### Not implemented

- Billing/plan quotas, provider-backed proof for a fresh GitHub installation claim, server-generated approval-bound PR patches, constrained intrusive sandbox exploit replay, a within-scan Luna-to-Terra validation cascade, prompt-cache orchestration, Security Copilot sidebar, visual security plan, and enterprise deployment/identity capabilities.
- Production full scans additionally require private evidence storage, BullMQ-compatible TLS Redis, dedicated sandbox-capable worker compute, the authenticated application origin, monitoring/recovery, and transport-level egress enforcement.

See `PRD.md` for the authoritative roadmap.

## User-facing review options

| Workflow             | Mode     | Repository model                 | Reasoning     |
| -------------------- | -------- | -------------------------------- | ------------- |
| Release Check        | QUICK    | GPT-5.6 Luna                     | medium        |
| Code Review          | STANDARD | GPT-5.6 Luna                     | medium        |
| Deep Security Review | DEEP     | GPT-5.6 Terra + Luna specialists | medium + high |
| Weekly Monitor       | QUICK    | GPT-5.6 Luna                     | medium        |

URL/API targets skip the external engine. SAFE remains a compatibility alias for the canonical repository QUICK profile, and CUSTOM resolves to Deep; neither is an extra one-off dashboard choice. Sol remains an internal accounting model but is not assigned to a preset. Protected limits and provider reconciliation are operator concerns and are not displayed in the product UI. See `userguide.md` for the complete workflow and option reference.

## Launch and growth

- Open-beta registration is live at `app.lyrashieldai.com/sign-up`; the marketing email form is an optional product-updates subscription, not an access gate. Acquisition flows through the public Lite Check, browser-local tools, public scorecards, referrals, and technical content.
- Use reports, fix proposals, retests, the public methodology, browser-local tools, and MCP read workflows as demonstrations; do not promise automatic PR creation or use unverified marketing claims.
- Publish answer-first technical content for AI-built-app security only after founder approval.
- Keep sample blog posts as drafts until their claims, sources, author, and launch timing are approved.

## SEO and content themes

Initial themes: secure AI-generated code, security review before SaaS launch, dependency and secret exposure, fix-and-retest workflows, SARIF/PR gates, and agent/MCP security. Build a page only when it has a distinct user question and evidence-backed answer; avoid thin keyword variants.

## Founder decisions

1. Trademark clearance for the confirmed `lyrashieldai.com` domain and LyraShield AI name.
2. Whether the Lyra prefix remains the public brand.
3. Pricing, usage metric, payment-provider scope, and free-tier policy.
4. Public-launch timing and build-in-public voice.
5. Approved model/provider and first controlled scan.

## Document map

- `PRD.md` — roadmap and acceptance scope
- `codebase.md` — implemented architecture
- `AGENTS.md` — current handoff, immediate blockers, and execution sequence
- `userguide.md` — complete user workflows, options, permissions, and limitations
- `apps/marketing/BLOG_AUTHORING.md` — authoring and publication checklist
