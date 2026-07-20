# LyraShield AI

Evidence-backed release assurance for AI-built software.

LyraShield AI turns a target into a release-assurance loop:

`Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`

It keeps detected findings, independently verified evidence, retest-confirmed results, and inconclusive checks distinct. A score or AI suggestion is never treated as proof by itself.

## Try it

- Marketing and methodology: [lyrashieldai.com](https://lyrashieldai.com)
- Public passive Lite Check: [scanner.lyrashieldai.com](https://scanner.lyrashieldai.com)
- Authenticated workspace: [app.lyrashieldai.com](https://app.lyrashieldai.com) (invite-only production beta)

The public Lite Check is a bounded public-surface review. It is not the authenticated full scan pipeline and does not claim universal coverage. The beta app supports password and configured OAuth access without email verification; full-scan admission remains fail-closed until the dedicated worker and transport controls are independently proven.

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

## Built with Codex and GPT-5.6

Codex was used throughout implementation, testing, CI remediation, production hardening, deployment verification, and documentation review. GPT-5.6 is part of the controlled full-scan contract: Luna handles Safe/Quick/Standard work at medium reasoning; Terra coordinates Deep/Custom work with Luna specialists. The execution boundary enforces bounded context, agent, output, and spend controls before model requests.

## Security and release boundaries

- Workspace data is tenant-scoped and sensitive operations are audit-logged.
- Engine output is treated as untrusted; only independent verifier evidence can mark a finding verified.
- URL targets use pinned deterministic URL scanners rather than the repository engine.
- Queue admission fails closed without a healthy worker heartbeat.
- Public scorecard payloads are allowlisted and sharing is revocable.
- The public marketing surface and the authenticated workspace have separate deployment boundaries.

See [the production beta readiness plan](docs/plans/2026-07-20-production-beta-readiness.md) for the exact deployment and verification gates. Do not treat this repository, the Lite Check, or a local run as proof of an authenticated provider-backed production scan.
