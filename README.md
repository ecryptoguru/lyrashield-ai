# LyraShield AI

Evidence-backed release assurance for AI-built software.

LyraShield AI turns a target into a release-assurance loop:

`Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`

It keeps detected findings, independently verified evidence, retest-confirmed results, and inconclusive checks distinct. A score or AI suggestion is never treated as proof by itself.

## Try it

- Marketing and methodology: [lyrashieldai.com](https://lyrashieldai.com)
- Public passive Lite Check: [lyrashieldai.com/scan](https://lyrashieldai.com/scan)
- Authenticated workspace: [app.lyrashieldai.com](https://app.lyrashieldai.com) (invite-only production beta)

The public Lite Check is a bounded public-surface review. It is not the authenticated full scan pipeline and does not claim universal coverage. The invite-only beta app supports password and configured OAuth access without email verification. Production web requests use a restricted `NOBYPASSRLS` database role, and repository scans are admitted only while the dedicated production worker holds a live lease. The current release gate still requires a current-tree Safe retest and a successful, reconciled Deep run.

## Judge and project links

- [Public product site](https://lyrashieldai.com) · [public Lite Check](https://lyrashieldai.com/scan) · [authenticated beta](https://app.lyrashieldai.com) (invite-only)
- [Methodology](https://lyrashieldai.com/methodology) · [synthetic sample report](https://lyrashieldai.com/sample-report) · [Vibe Security 50](docs/vibe-security-50.md)
- [Application source](https://github.com/ecryptoguru/lyrashield-ai) · [engine source](https://github.com/ecryptoguru/lyrashield-engine) · [engine ownership boundary](https://github.com/ecryptoguru/lyrashield-engine#ownership-boundary) · [engine upgrade ledger](https://github.com/ecryptoguru/lyrashield-engine/blob/main/UPGRADES.md)
- [Build Week judge path](#openai-build-week-judge-path) · [engine derivative and upstream maintenance](#engine-derivative-and-upstream-maintenance) · [production-beta readiness plan](docs/plans/2026-07-20-production-beta-readiness.md)

## OpenAI Build Week judge path

LyraShield AI is entered in the **Developer Tools** track. Judges can exercise the submitted public path without an account, rebuilding the repository, or using paid services:

1. Open [the public Lite Check](https://lyrashieldai.com/scan).
2. Enter `lyrashieldai.com`, confirm authorization and the Terms, and run the check.
3. Inspect the result and its stated limitations; the interface does not convert an unavailable or inconclusive check into a pass.
4. Compare the states with [the public methodology](https://lyrashieldai.com/methodology) and [synthetic sample report](https://lyrashieldai.com/sample-report).

The public demo supports current desktop and mobile browsers and is automatically tested in Chromium. Local development and Docker validation target macOS and Linux with Node.js 24+, pnpm, and Docker. Windows/WSL2 is not a release-tested target.

### What changed during Build Week

LyraShield AI existed before the submission period. The official start was **July 13, 2026, 9:00 AM PT (16:00 UTC)**. The pre-period baseline is commit [`72ba1e2`](https://github.com/ecryptoguru/lyrashield-ai/commit/72ba1e2a54fdedf81989325031c781f41d14dec6), authored at 15:48:53 UTC—before that start—and is not claimed as Build Week work.

| Period                    | What to evaluate                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before July 13, 16:00 UTC | The repository state reachable at [`72ba1e2`](https://github.com/ecryptoguru/lyrashield-ai/tree/72ba1e2a54fdedf81989325031c781f41d14dec6). It is the disclosed starting point, including pre-existing product and engine infrastructure.                                              |
| During Build Week         | The reviewed delta from [`72ba1e2..HEAD`](https://github.com/ecryptoguru/lyrashield-ai/compare/72ba1e2a54fdedf81989325031c781f41d14dec6...main), beginning with [`1f54eb0`](https://github.com/ecryptoguru/lyrashield-ai/commit/1f54eb0). The additions below are the submitted work. |

Judges should evaluate the meaningful post-baseline extensions:

- **Evidence integrity:** immutable result manifests, coverage receipts, finding candidates, independent verification receipts, and server-owned retests distinguish detected, independently verified, retest-confirmed, and inconclusive results ([PR #67](https://github.com/ecryptoguru/lyrashield-ai/pull/67), [PR #68](https://github.com/ecryptoguru/lyrashield-ai/pull/68)).
- **Working public product:** the passive Lite Scanner, direct-domain flow, truthful one-pass progress, privacy-bounded scorecards, and production deployment created the no-login judge path ([PR #71](https://github.com/ecryptoguru/lyrashield-ai/pull/71), [PR #76](https://github.com/ecryptoguru/lyrashield-ai/pull/76), [PR #84](https://github.com/ecryptoguru/lyrashield-ai/pull/84), [PR #86](https://github.com/ecryptoguru/lyrashield-ai/pull/86)).
- **Complete product experience:** the premium dashboard, responsive navigation, evidence console, assurance reports, and guided review loop replaced proof-of-concept surfaces with an accessible end-to-end experience ([PR #60](https://github.com/ecryptoguru/lyrashield-ai/pull/60), [PR #99](https://github.com/ecryptoguru/lyrashield-ai/pull/99), [PR #107](https://github.com/ecryptoguru/lyrashield-ai/pull/107)).
- **GPT-5.6 execution contract:** protected model routing, per-request accounting, bounded context/output/agents/spend, deterministic finding identity, explicit coverage controls, and fail-closed provider handling hardened the controlled full-scan path ([PR #109](https://github.com/ecryptoguru/lyrashield-ai/pull/109), [PR #113](https://github.com/ecryptoguru/lyrashield-ai/pull/113), [PR #119](https://github.com/ecryptoguru/lyrashield-ai/pull/119)).
- **Operational reliability:** worker heartbeats, fail-closed scan admission, orphan reconciliation, queue cleanup, production readiness, and invite-only beta authentication made failure behavior explicit ([PR #115](https://github.com/ecryptoguru/lyrashield-ai/pull/115), [PR #120](https://github.com/ecryptoguru/lyrashield-ai/pull/120), [PR #123](https://github.com/ecryptoguru/lyrashield-ai/pull/123)).

The dated Git history and linked pull requests are the audit trail. To inspect the same boundary locally:

```bash
git log --since='2026-07-13T16:00:00Z' --date=iso-strict --oneline
git diff --stat 72ba1e2a54fdedf81989325031c781f41d14dec6..HEAD
```

## OpenAI Build Week judge path

LyraShield AI is entered in the **Developer Tools** track. Judges can exercise the submitted public path without an account, rebuilding the repository, or using paid services:

1. Open [the public Lite Check](https://lyrashieldai.com/scan).
2. Enter `lyrashieldai.com`, confirm authorization and the Terms, and run the check.
3. Inspect the result and its stated limitations; the interface does not convert an unavailable or inconclusive check into a pass.
4. Compare the states with [the public methodology](https://lyrashieldai.com/methodology) and [synthetic sample report](https://lyrashieldai.com/sample-report).

The public demo supports current desktop and mobile browsers and is automatically tested in Chromium. Local development and Docker validation target macOS and Linux with Node.js 24+, pnpm, and Docker. Windows/WSL2 is not a release-tested target.

### What changed during Build Week

LyraShield AI existed before the submission period. The pre-period baseline is commit [`72ba1e2`](https://github.com/ecryptoguru/lyrashield-ai/commit/72ba1e2a54fdedf81989325031c781f41d14dec6), authored before the official July 13, 2026 9:00 AM PT start. Judges should evaluate the meaningful extensions added after that baseline:

- **Evidence integrity:** immutable result manifests, coverage receipts, finding candidates, independent verification receipts, and server-owned retests distinguish detected, independently verified, retest-confirmed, and inconclusive results ([PR #67](https://github.com/ecryptoguru/lyrashield-ai/pull/67), [PR #68](https://github.com/ecryptoguru/lyrashield-ai/pull/68)).
- **Working public product:** the passive Lite Scanner, direct-domain flow, truthful one-pass progress, privacy-bounded scorecards, and production deployment created the no-login judge path ([PR #71](https://github.com/ecryptoguru/lyrashield-ai/pull/71), [PR #76](https://github.com/ecryptoguru/lyrashield-ai/pull/76), [PR #84](https://github.com/ecryptoguru/lyrashield-ai/pull/84), [PR #86](https://github.com/ecryptoguru/lyrashield-ai/pull/86)).
- **Complete product experience:** the premium dashboard, responsive navigation, evidence console, assurance reports, and guided review loop replaced proof-of-concept surfaces with an accessible end-to-end experience ([PR #60](https://github.com/ecryptoguru/lyrashield-ai/pull/60), [PR #99](https://github.com/ecryptoguru/lyrashield-ai/pull/99), [PR #107](https://github.com/ecryptoguru/lyrashield-ai/pull/107)).
- **GPT-5.6 execution contract:** protected model routing, per-request accounting, bounded context/output/agents/spend, deterministic finding identity, explicit coverage controls, and fail-closed provider handling hardened the controlled full-scan path ([PR #109](https://github.com/ecryptoguru/lyrashield-ai/pull/109), [PR #113](https://github.com/ecryptoguru/lyrashield-ai/pull/113), [PR #119](https://github.com/ecryptoguru/lyrashield-ai/pull/119)).
- **Operational reliability:** worker heartbeats, fail-closed scan admission, orphan reconciliation, queue cleanup, production readiness, and invite-only beta authentication made failure behavior explicit ([PR #115](https://github.com/ecryptoguru/lyrashield-ai/pull/115), [PR #120](https://github.com/ecryptoguru/lyrashield-ai/pull/120), [PR #123](https://github.com/ecryptoguru/lyrashield-ai/pull/123)).

The dated Git history and linked pull requests are the audit trail. To inspect the same boundary locally:

```bash
git log --since='2026-07-13T16:00:00Z' --date=iso-strict --oneline
git diff --stat 72ba1e2a54fdedf81989325031c781f41d14dec6..HEAD
```

## OpenAI Build Week judge path

LyraShield AI is entered in the **Developer Tools** track. Judges can exercise the submitted public path without an account, rebuilding the repository, or using paid services:

1. Open [the public Lite Check](https://lyrashieldai.com/scan).
2. Enter `lyrashieldai.com`, confirm authorization and the Terms, and run the check.
3. Inspect the result and its stated limitations; the interface does not convert an unavailable or inconclusive check into a pass.
4. Compare the states with [the public methodology](https://lyrashieldai.com/methodology) and [synthetic sample report](https://lyrashieldai.com/sample-report).

The public demo supports current desktop and mobile browsers and is automatically tested in Chromium. Local development and Docker validation target macOS and Linux with Node.js 24+, pnpm, and Docker. Windows/WSL2 is not a release-tested target.

### What changed during Build Week

LyraShield AI existed before the submission period. The pre-period baseline is commit [`72ba1e2`](https://github.com/ecryptoguru/lyrashield-ai/commit/72ba1e2a54fdedf81989325031c781f41d14dec6), authored before the official July 13, 2026 9:00 AM PT start. Judges should evaluate the meaningful extensions added after that baseline:

- **Evidence integrity:** immutable result manifests, coverage receipts, finding candidates, independent verification receipts, and server-owned retests distinguish detected, independently verified, retest-confirmed, and inconclusive results ([PR #67](https://github.com/ecryptoguru/lyrashield-ai/pull/67), [PR #68](https://github.com/ecryptoguru/lyrashield-ai/pull/68)).
- **Working public product:** the passive Lite Scanner, direct-domain flow, truthful one-pass progress, privacy-bounded scorecards, and production deployment created the no-login judge path ([PR #71](https://github.com/ecryptoguru/lyrashield-ai/pull/71), [PR #76](https://github.com/ecryptoguru/lyrashield-ai/pull/76), [PR #84](https://github.com/ecryptoguru/lyrashield-ai/pull/84), [PR #86](https://github.com/ecryptoguru/lyrashield-ai/pull/86)).
- **Complete product experience:** the premium dashboard, responsive navigation, evidence console, assurance reports, and guided review loop replaced proof-of-concept surfaces with an accessible end-to-end experience ([PR #60](https://github.com/ecryptoguru/lyrashield-ai/pull/60), [PR #99](https://github.com/ecryptoguru/lyrashield-ai/pull/99), [PR #107](https://github.com/ecryptoguru/lyrashield-ai/pull/107)).
- **GPT-5.6 execution contract:** protected model routing, per-request accounting, bounded context/output/agents/spend, deterministic finding identity, explicit coverage controls, and fail-closed provider handling hardened the controlled full-scan path ([PR #109](https://github.com/ecryptoguru/lyrashield-ai/pull/109), [PR #113](https://github.com/ecryptoguru/lyrashield-ai/pull/113), [PR #119](https://github.com/ecryptoguru/lyrashield-ai/pull/119)).
- **Operational reliability:** worker heartbeats, fail-closed scan admission, orphan reconciliation, queue cleanup, production readiness, and invite-only beta authentication made failure behavior explicit ([PR #115](https://github.com/ecryptoguru/lyrashield-ai/pull/115), [PR #120](https://github.com/ecryptoguru/lyrashield-ai/pull/120), [PR #123](https://github.com/ecryptoguru/lyrashield-ai/pull/123)).

The dated Git history and linked pull requests are the audit trail. To inspect the same boundary locally:

```bash
git log --since='2026-07-13T16:00:00Z' --date=iso-strict --oneline
git diff --stat 72ba1e2a54fdedf81989325031c781f41d14dec6..HEAD
```

## What is here

- `apps/web` — Next.js workspace for targets, scans, evidence, reports, scorecards, and approval-gated actions.
- `apps/worker` — BullMQ scan worker with queue admission, reconciliation, evidence receipts, and controlled engine execution.
- `apps/agent` — approval-gated agent actions.
- `apps/marketing` — Astro/Cloudflare marketing site and browser-local free tools.
- `packages/*` — auth, configuration, database, integrations, MCP, score, security, shared UI, and logging.

The authenticated workflow currently supports project targets, findings, deterministic receipts, immutable manifests, score snapshots, reports, schedules, notifications, GitHub integrations, and privacy-bounded sharing. Fix PR execution remains deliberately fail-closed until a server-generated patch pipeline is bound to an approval.

## Evidence states

| State                  | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Detected               | A scanner observed a candidate finding.                        |
| Independently verified | Separate verification evidence exists.                         |
| Retest-confirmed       | A clean deterministic retest had complete applicable coverage. |
| Inconclusive           | Available evidence cannot establish the claim.                 |

## Local setup

Prerequisites: Node.js 24+, pnpm, Docker, and an environment file based on `.env.example`.

```bash
pnpm install
pnpm --filter @lyrashield/db generate
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

## Engine derivative and upstream maintenance

Repository reviews run through [LyraShield Engine](https://github.com/ecryptoguru/lyrashield-engine), the separately versioned sandboxed analysis process used by the worker. It is a controlled derivative of [Strix](https://github.com/usestrix/strix), not a claim that upstream results or benchmarks apply to LyraShield.

LyraShield owns the product-critical execution contract: GPT-5.6 model policy, bounded context/output/agent/spend controls, non-interactive lifecycle and telemetry-off behavior, deterministic finding identity, evidence/control metadata, and the bounded worker artifacts. The upstream substrate remains responsible for reviewed generic sandbox, tool, agent-SDK, and vulnerability-skill plumbing. Read the engine's [ownership boundary](https://github.com/ecryptoguru/lyrashield-engine#ownership-boundary) and [upstream-import ledger](https://github.com/ecryptoguru/lyrashield-engine/blob/main/UPGRADES.md) for the exact line.

Upgrades are deliberately review-gated: the engine records its incorporated Strix base, compares stable releases, prepares a review PR, and requires human approval plus its read-only CI gate. It never auto-resolves conflicts, force-pushes history, or deploys from the sync workflow. The [engine verification and upgrade guidance](https://github.com/ecryptoguru/lyrashield-engine#verification) describes the checks; they prove implementation compatibility, not scan accuracy or universal coverage.

Quick links: [judge path](#openai-build-week-judge-path) · [Codex and GPT-5.6 use](#built-with-codex-and-gpt-56) · [security and release boundaries](#security-and-release-boundaries).

## Built with Codex and GPT-5.6

Codex was the engineering collaborator throughout the Build Week extensions: it traced cross-package data flows, implemented focused changes, added regression tests, reviewed rendered UX, diagnosed CI and deployment failures, and reconciled documentation with live behavior. The founder retained the key product decisions: evidence state rather than an AI confidence claim; passive public scanning separated from the authenticated engine; independent proof required for verification; and risky scan or Fix PR paths failing closed.

GPT-5.6 contributed in two ways. GPT-5.6-powered Codex sessions performed the Build Week implementation and review work. GPT-5.6 is also part of the controlled full-scan runtime contract: Luna handles Safe/Quick/Standard work at medium reasoning; Terra coordinates Deep/Custom work with Luna specialists. The execution boundary enforces bounded context, agent, output, concurrency, and spend controls before model requests. The public Lite Check is deterministic and does not call that full-scan runtime.

## Security and release boundaries

- Workspace data is tenant-scoped and sensitive operations are audit-logged.
- Engine output is treated as untrusted; only independent verifier evidence can mark a finding verified.
- URL targets use pinned deterministic URL scanners rather than the repository engine.
- Queue admission fails closed without a healthy worker heartbeat.
- Public scorecard payloads are allowlisted and sharing is revocable.
- The public marketing surface and the authenticated workspace have separate deployment boundaries.

See [the production beta readiness plan](docs/plans/2026-07-20-production-beta-readiness.md) for the exact deployment and verification gates. Do not treat this repository, the Lite Check, or a local run as proof of an authenticated provider-backed production scan.

## License

The LyraShield AI source code in this repository is available under the [MIT License](LICENSE). Third-party dependencies and separately referenced upstream projects retain their own licenses. The LyraShield AI name and logos are not granted for use by the MIT License.
