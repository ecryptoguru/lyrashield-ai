# Authority guide editorial brief

Date: 2026-07-17
Status: research complete, draft pending
Owner: LyraShield Team

## Article contract

- Program index: 1
- Working title: Vibe Coding Security: The Complete Guide
- Slug: `vibe-coding-security-guide`
- Primary query: `vibe coding security`
- Search intent: definitive educational guide with an actionable release workflow
- Target length: 2,500 to 3,000 words
- Author: LyraShield Team as an Organization
- Primary tag: `vibe-coding-security`
- Supporting tags: `access-control`, `web-security`, `supply-chain`, `agent-security`, `verification`
- Publication date: set when the release is approved
- Material update date: set only when the published guidance changes materially

## Reader and problem

The primary reader has used an AI coding assistant or an app builder to get a working product quickly. They can judge whether the happy path works, but they do not yet have a defensible answer to a harder question: what was tested before release, what evidence exists, and what remains unknown?

The guide should help a solo founder, startup engineering lead, agency developer, or hands-on product builder turn a functional prototype into a release decision. A security engineer should find the terminology and limitations accurate, even though the article is written for a broader technical audience.

## Unique angle and intent separation

This article is the map for the full 100-article library. It explains six layers of work and connects them through an evidence loop. It does not compete with these existing LyraShield pages:

- `/methodology` explains LyraShield AI evidence states and product method. The guide links to it for the formal state definitions rather than repeating the full methodology.
- `/sample-report` demonstrates an illustrative report shape. The guide explains what a release report should contain, then sends readers to the example.
- `/tools` and its five tool pages perform narrow browser-local checks. The guide explains when each check is useful and why no single tool proves application security.
- `/scan` is the detailed passive Lite Check route. The guide describes its public-surface boundary and does not present it as a full authenticated or repository assessment.
- Supporting blog articles answer one specific implementation or decision query. The guide gives each topic a short orientation and links to the deeper article once that article is public.

The guide should not become an undifferentiated checklist. Its useful contribution is the reasoning chain from target and scope to evidence, fix proposal, retest, and release report.

## Direct answer

Open with a 40 to 80 word answer that defines vibe coding security as the work of setting explicit trust boundaries, checking the generated application across six layers, retaining evidence, and retesting fixes before release. State plainly that a clean automated scan is useful evidence, not proof that an application is secure.

## Six security layers

### 1. Authorization and data boundaries

Cover authentication versus authorization, object ownership, tenant scoping, admin routes, row-level security, and a safe two-account test. Use broken access control and missing authorization as the standards anchor.

### 2. Identity, secrets, and session handling

Cover server-held secrets, password storage, token verification, password recovery, OAuth callback constraints, and secure session cookies. Explain why hiding a control in the browser is not access control.

### 3. Inputs, outputs, and server-side execution

Cover allowlisted validation, context-appropriate encoding, parameterized queries, SSRF defenses that re-check redirects and resolved addresses, upload isolation, and command or path handling. Keep examples inert and local.

### 4. Dependencies, builds, and deployment

Cover lockfiles, dependency provenance, vulnerability matching, install scripts, CI permissions, public-by-default storage, build artifacts, and production configuration. Explain why a package-name match alone does not establish that the vulnerable code path is reachable.

### 5. Coding agents and tool permissions

Treat repository files, web pages, issue text, and tool output as untrusted inputs when an agent reads them. Cover prompt injection, least-privilege tools, sandboxing, egress limits, approval for consequential actions, and separation from production credentials.

### 6. Verification, retesting, and operations

Cover threat modeling, independent evidence, scanner limitations, a fresh server-owned retest, launch gates, monitoring, recovery proof, incident ownership, and an assurance report. Keep detected, independently verified, retest-confirmed, and inconclusive outcomes distinct.

## Evidence loop

Use the exact sequence `Target -> Scan -> Evidence State -> Fix Proposal -> Retest -> Assurance Report` in prose or code styling. Explain each state in one short section:

1. Target records authorization and scope.
2. Scan records which checks ran, subjects covered, and limitations.
3. Evidence State distinguishes detection from independent verification and inconclusive results.
4. Fix Proposal is reviewable and approval-bound. Do not imply automatic pull-request execution.
5. Retest is a fresh check against the changed system.
6. Assurance Report combines evidence, coverage, limitations, and the release decision.

## Required factual anchors

- OWASP Top 10:2025 is an awareness document. Use its risk categories without treating it as a complete test plan.
- OWASP ASVS 5.0.0 provides testable web application security requirements.
- MITRE CWE separates missing authorization from authentication and warns that broad input-validation labels can obscure the actual weakness.
- NIST SSDF 1.1 organizes secure development practices across preparing the organization, protecting software, producing well-secured software, and responding to vulnerabilities.
- NCSC guidance treats security as continuous and explicitly says its principles do not guarantee a secure product.
- OAuth Security BCP requires exact redirect URI matching in the stated cases and applies PKCE guidance to web applications as well as native clients.
- OWASP GenAI guidance treats prompt injection as a system-design problem and recommends least privilege plus human approval for high-risk actions.
- NIST SP 800-115 requires testing methods to be chosen with their benefits and limitations in view.
- Vibe Security 50 contains 43 machine-testable controls and 7 evidence-required controls. An unreported control is not a pass.

## Safe examples

- Authorization: use two local test accounts and synthetic records. Never probe an unapproved production tenant.
- Secret exposure: inspect a local build output or the browser's own downloaded bundle. Use placeholder keys.
- Input handling: show a deliberately vulnerable local handler and a corrected validation or parameterization pattern. Do not provide a working exploit against a named target.
- Dependency checks: use a toy lockfile or an inert package example. Distinguish a vulnerable version match from exploitability.
- Agent security: use a harmless instruction-poisoning example that attempts to read a synthetic file, then show a permission boundary that denies it.
- Retesting: show the same safe check failing before a fix and passing after it, while noting the untested boundaries.

## Internal links and CTA

Links that are valid for the authority release:

- `/methodology`
- `/sample-report`
- `/tools`
- `/tools/ai-app-security-checklist`
- `/tools/security-headers-checker`
- `/tools/secret-exposure-scanner`
- `/tools/supabase-rls-checker`
- `/tools/jwt-session-inspector`
- `/scan`
- `/#free-scan`
- `/blog/editorial-policy`

Supporting article links remain plain-text future references until their release batch is public. Do not publish broken links. The primary CTA is `Run a free Lite Check` to `/#free-scan`, with a nearby sentence that defines the check as passive and public-surface only.

## FAQ decision

Include four visible FAQs because they answer distinct high-intent questions:

1. Is vibe-coded software safe for production?
2. What should I test before launching an AI-built app?
3. Can an automated scanner prove that an app is secure?
4. When should a security review happen?

Answers must remain concise, match the article body, and appear in FAQ schema only if the renderer emits the same visible questions and answers.

## Image concept

- Image ID: `authority-guide-01`
- Concept: a controlled evidence path joins six distinct security layers before one release gate
- Alt text: Six layered security paths joining at a translucent evidence gate
- Crop requirement: keep the convergence point and all six incoming paths inside the central 60 percent safe area
- Restrictions: text-free, no people, no logos, no fake interface, no shield cliché, and no visual claim that the gate guarantees safety

## Cannibalization review

Pass when the authority guide stays at the system and release-decision level, while supporting articles own implementation queries. In particular, do not let the guide become the best answer for the exact queries `supabase rls security`, `idor vulnerability test`, `security headers checker`, `coding agent prompt injection`, or `verify vulnerability finding`. Give each a useful paragraph, then point to its dedicated article when available.

## Acceptance checklist

- The body is 2,500 to 3,000 words and uses at least eight primary or authoritative sources.
- The opening answer is 40 to 80 words.
- Every material technical claim maps to `docs/editorial/blog-research/authority.md`.
- Product language keeps coverage and evidence boundaries literal.
- The 43 and 7 control split matches the executable registry and coverage contract.
- Examples are safe, local, and non-exploitative.
- Final prose passes the Humanizer draft, audit, and rewrite loop.
- Final prose contains no em dash or en dash characters.
- The article has one H1, stable H2 and H3 anchors, one main landmark, a self-canonical URL, Organization authorship, and the approved image.
- All links resolve in the release candidate, or remain non-clickable future references.
