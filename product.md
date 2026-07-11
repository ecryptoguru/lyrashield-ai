# LyraSec AI — Product, Positioning & GTM

> Internal, pre-launch guidance. Product name and public domain remain founder decisions; do not treat this document as approved public copy, pricing, or evidence of customer traction.

## Positioning

LyraSec AI is an agent-native application-security platform for AI-built software. It turns a security request into a loop: **Target → Scan → Verified Finding → Fix PR → Retest → Report**.

The position is the combination, not a claim of unique capability: a solo builder and a security team can use the same loop at different depths, across UI, API, MCP, CLI, and GitHub workflows.

## Guardrails

- Never claim LyraSec AI is the only tool that verifies findings, creates fixes, or supports MCP.
- Do not publish benchmark, accuracy, pricing, customer, or social-proof claims.
- Do not present the forked engine as a public differentiator.
- Treat exploit validation as a product hygiene goal, not a quantified assurance claim.
- Name the product **LyraSec AI** in public copy; do not rename internal `@lyrashield/*` scopes or environment variables.

## Audience and message

| Audience                 | Useful framing                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| AI-assisted solo builder | “You shipped it quickly. Check it before you launch.”                            |
| Small SaaS team          | A security-review artifact: findings, fixes, retest, and a shareable report.     |
| Agency / dev shop        | Add a security report to each client handoff.                                    |
| Enterprise AppSec        | One loop from builder workflows to governed controls, audit trail, and CI gates. |

## Differentiation

Lead with a complete review package:

1. Scan a repository or URL.
2. Normalize and prioritize findings.
3. Explain the issue in plain language.
4. Create a fix proposal or PR under the required approval rules.
5. Retest and share the resulting report.

SCA, secret scanning, URL checks, SARIF, and GitHub diff gates are important coverage layers, but are table stakes individually. Do not overstate parity with dedicated point tools.

## Product status

Implemented: core workspaces/targets/scans, GitHub integration, scan orchestration, findings normalization, SCA and secret scanning, URL scanning, fix proposals, retests, reports, notifications, schedules, MCP, agent approvals, and the GitHub diff gate.

Not implemented: billing/usage limits, Security Copilot sidebar, visual security plan, and enterprise deployment/identity capabilities. See `PRD.md` for the authoritative roadmap.

## Pre-launch GTM

- Start with a small number of design partners, prioritizing teams that can provide structured feedback.
- Use the report, fix PR, and MCP workflow as demonstrations; do not use unverified marketing claims.
- Publish answer-first technical content for AI-built-app security only after founder approval.
- Keep sample blog posts as drafts until their claims, sources, author, and launch timing are approved.

## SEO and content themes

Initial themes: secure AI-generated code, security review before SaaS launch, dependency and secret exposure, fix-and-retest workflows, SARIF/PR gates, and agent/MCP security. Build a page only when it has a distinct user question and evidence-backed answer; avoid thin keyword variants.

## Founder decisions

1. Public domain and trademark clearance.
2. Whether the Lyra prefix remains the public brand.
3. Pricing, usage metric, payment-provider scope, and free-tier policy.
4. Design-partner target, launch timing, and build-in-public voice.
5. Approved model/provider and first controlled scan.

## Document map

- `PRD.md` — roadmap and acceptance scope
- `codebase.md` — implemented architecture
- `NEXT-STEPS.md` — immediate blockers and sequence
- `apps/marketing/BLOG_AUTHORING.md` — authoring and publication checklist
