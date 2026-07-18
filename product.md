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

Implemented: core workspaces/targets/scans, existing GitHub integration refresh, scan orchestration, findings normalization, source-aware SCA/secret/agent-config handling, pinned deterministic URL scanning, fix proposals, queued retests, reports, notifications, schedules, MCP, single-use agent approvals, the GitHub diff gate, audit hash chaining, S3-compatible evidence upload with checksum-first retry deduplication, hardened prompt-injection detection, shared queue/Redis helpers, email verification, split marketing/app origin routing, LyraShield Score, cross-admin-idempotent public scorecards, referrals, premium social sharing, Azure AI / GPT 5.6 mode routing, and an evidence-backed marketing surface with a public methodology page plus five browser-local no-upload tools. Full-scan admission fails closed unless a live worker heartbeat exists; every enqueue path shares the same unavailable response, enqueue races fail the created scan with retained history, and conservative reconciliation never silently replays a paid scan. New scans retain a manifest, coverage receipts, candidate provenance, verification receipts, and private usage telemetry: detected, validated, and independently verified are separate states. Safe/Quick/Standard scans use Luna with medium reasoning; Deep/Custom use Terra with high reasoning. Protected run limits and versioned per-request GPT-5.6 accounting remain internal; the dashboard shows neither model costs nor spend. Engine findings are not self-verified.

Live acquisition status: the passive Lite Scanner and browser-local tools are public, and privacy-bounded PostHog funnel/pageview analytics are configured for the canonical domain. The authenticated application and full BullMQ/engine worker are separate deployment surfaces and are not public production capabilities yet.

Not implemented: billing/plan quotas, provider-backed proof for a fresh GitHub installation claim, server-generated approval-bound PR patches, constrained intrusive sandbox exploit replay, a within-scan Luna-to-Terra validation cascade, prompt-cache orchestration, Security Copilot sidebar, visual security plan, and enterprise deployment/identity capabilities. Production full scans additionally require private evidence storage, BullMQ-compatible TLS Redis, dedicated sandbox-capable worker compute, the authenticated application origin, monitoring/recovery, and transport-level egress enforcement. See `PRD.md` for the authoritative roadmap.

## User-facing review options

| Workflow             | Mode     | Repository model | Reasoning |
| -------------------- | -------- | ---------------- | --------- |
| Release Check        | SAFE     | GPT-5.6 Luna     | medium    |
| Code Review          | STANDARD | GPT-5.6 Luna     | medium    |
| Deep Security Review | DEEP     | GPT-5.6 Terra    | high      |
| Weekly Monitor       | SAFE     | GPT-5.6 Luna     | medium    |

URL/API targets skip the external engine. QUICK and CUSTOM remain backend/API modes rather than extra one-off dashboard choices; Sol remains an internal accounting model but is not assigned to a preset. Protected limits and provider reconciliation are operator concerns and are not displayed in the product UI. See `userguide.md` for the complete workflow and option reference.

## Pre-launch GTM

- Start with a small number of design partners, prioritizing teams that can provide structured feedback.
- Use reports, fix proposals, retests, the public methodology, browser-local tools, and MCP read workflows as demonstrations; do not promise automatic PR creation or use unverified marketing claims.
- Publish answer-first technical content for AI-built-app security only after founder approval.
- Keep sample blog posts as drafts until their claims, sources, author, and launch timing are approved.

## SEO and content themes

Initial themes: secure AI-generated code, security review before SaaS launch, dependency and secret exposure, fix-and-retest workflows, SARIF/PR gates, and agent/MCP security. Build a page only when it has a distinct user question and evidence-backed answer; avoid thin keyword variants.

## Founder decisions

1. Trademark clearance for the confirmed `lyrashieldai.com` domain and LyraShield AI name.
2. Whether the Lyra prefix remains the public brand.
3. Pricing, usage metric, payment-provider scope, and free-tier policy.
4. Design-partner target, launch timing, and build-in-public voice.
5. Approved model/provider and first controlled scan.

## Document map

- `PRD.md` — roadmap and acceptance scope
- `codebase.md` — implemented architecture
- `AGENTS.md` — current handoff, immediate blockers, and execution sequence
- `userguide.md` — complete user workflows, options, permissions, and limitations
- `apps/marketing/BLOG_AUTHORING.md` — authoring and publication checklist
