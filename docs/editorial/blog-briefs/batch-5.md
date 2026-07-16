# Batch 5 editorial briefs

Date: 2026-07-17
Status: research complete, drafting pending
Owner: LyraShield Team
Release: topics 69 through 84

## Batch contract

- Article count: 16
- Target length: 1,200 to 1,500 words per supporting article, with the program-map target treated as the drafting center
- Authority dependency: `/blog/vibe-coding-security-guide` appears contextually in the first third of every article
- Author: LyraShield Team as an Organization
- Stable tags only: `vibe-coding-security`, `access-control`, `web-security`, `supply-chain`, `agent-security`, `verification`
- Source minimum: at least three authoritative references per article, including at least two primary or official sources
- Required article elements: 40 to 80 word direct answer, vulnerable pattern, AI-code failure mode, safe verification, corrected pattern, edge cases, automation limits, free-tool link, related article, useful FAQs when warranted, and visible source and material-update dates
- Product boundary: the passive Lite Check and five browser-local tools are public. The authenticated release-assurance product is implemented in the repository but remains in active development and is not presented as a generally available production service.

## Batch intent separation

| Topic | Primary job                                                              | Must not become                                                        |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 69    | Harden coding-agent GitHub Actions as a privileged execution environment | A generic pull-request gate tutorial or a GitHub Actions feature tour  |
| 70    | Design a secure MCP server boundary                                      | A least-privilege-tools article duplicated from topic 43               |
| 71    | Secure the full Stripe SaaS state machine                                | A duplicate webhook-signature or entitlement-only guide                |
| 72    | Run a pre-launch app security checklist                                  | A claim that checking boxes or one scan proves readiness               |
| 73    | Test object isolation with two owned accounts                            | A broad IDOR explainer duplicated from topic 3                         |
| 74    | Stop secrets before commit and respond correctly to detections           | A general secrets-management or incident-response article              |
| 75    | Match lockfile dependencies to OSV advisories and interpret the result   | A general dependency-audit article duplicated from topic 38            |
| 76    | Choose among SAST, DAST, and SCA by evidence type                        | A vendor comparison or a claim that the categories are interchangeable |
| 77    | Use a security-review prompt as a review aid                             | A promise that prompting replaces testing or human review              |
| 78    | Produce a lightweight founder-owned threat model                         | A generic launch checklist or a compliance artifact                    |
| 79    | Explain why remediation needs a fresh retest                             | A general finding-validation guide duplicated from topic 80            |
| 80    | Validate whether a reported security condition is real                   | A remediation or retest workflow duplicated from topic 79              |
| 81    | Normalize scanner output with SARIF                                      | A general CI gate article or a claim that SARIF verifies findings      |
| 82    | Gate only the relevant pull-request change with enforceable checks       | A GitHub Actions hardening guide duplicated from topic 69              |
| 83    | Make an accountable go, conditional-go, or no-go decision                | A numeric score presented as a security guarantee                      |
| 84    | Hand a client a scoped, useful, and protected security report            | A sales report, compliance certificate, or raw scanner dump            |

## Topic 69: Secure GitHub Actions Used by Coding Agents

- Program index: 69
- Slug: `github-actions-coding-agent-security`
- Primary query: `github actions ai agent security`
- Search intent: stack-specific implementation guide
- Target length: 1,450 words
- Tags: `vibe-coding-security`, `agent-security`, `supply-chain`, `verification`

### Reader and problem

The reader lets a coding agent open pull requests, edit workflows, run tests, or inspect repository context. They need to prevent untrusted pull-request content or generated workflow changes from inheriting repository write access, long-lived cloud credentials, or a privileged runner.

### Unique angle

Treat the workflow as a privileged program whose inputs can be attacker-controlled. Center the article on event choice, token permissions, immutable action references, OIDC audience and subject constraints, runner isolation, artifact trust, and exact approval boundaries. Topic 82 will explain how to make security checks merge-blocking; this article explains how to keep the workflow that runs those checks from becoming the attack path.

### Direct-answer target and outline

Open with a 40 to 80 word answer: give agent-triggered workflows read-only permissions by default, never combine privileged triggers with checkout or execution of untrusted code, pin actions to full commit SHAs, prefer short-lived OIDC credentials with restrictive claims, and require review for workflow or deployment changes.

1. Identify privileged events, secrets, runners, caches, artifacts, and deployment identities.
2. Show an intentionally unsafe `pull_request_target` plus untrusted checkout pattern.
3. Replace it with an unprivileged review workflow and a separately approved privileged action.
4. Set job-level `permissions`, pin actions, constrain OIDC claims, and isolate runners.
5. Verify locally and in an owned test repository without exposing real secrets.
6. Explain that workflow hardening does not prove the generated application is secure.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`, in the first third with anchor text about the full AI-built application security model
- Free tool: `/tools/ai-app-security-checklist`, as a browser-local way to record whether agent, dependency, secret, testing, and operational controls have owners; state that it does not inspect repository settings, action pins, token permissions, workflow execution, or cloud trust policy
- Optional secondary tool: `/tools/secret-exposure-scanner` only when discussing common credential patterns in selected workflow or configuration text; state that it does not inspect repository settings or workflow authority
- Related dependency: `/blog/cicd-agent-confused-deputy`
- Contextual LyraShield link: `/methodology`; describe the repository GitHub Actions workflow as review-stage code, not a public hosted service or production proof

### FAQ decision

Include three FAQs: whether `pull_request_target` is always unsafe, whether OIDC removes every credential risk, and whether a GitHub-hosted runner makes untrusted code safe.

### Image concept

An agent tool path crossing a narrow permission boundary into a sealed CI chamber, with separate read-only and approved-write routes. No GitHub logo, workflow text, or fake dashboard.

### Sources and claim guardrails

Use B5-S01, B5-S02, B5-S03, and B5-S04. Do not claim that full-SHA pinning prevents every supply-chain attack. Do not show real tokens. Do not describe the repository workflow's `DEEP` input as deeper coverage because the current workflow explicitly treats it as SAFE-equivalent.

## Topic 70: Build a Secure MCP Server

- Program index: 70
- Slug: `secure-mcp-server-guide`
- Primary query: `mcp server security`
- Search intent: protocol-specific implementation guide
- Target length: 1,500 words
- Tags: `vibe-coding-security`, `agent-security`, `access-control`, `verification`

### Reader and problem

The reader is exposing resources or tools through an MCP server and needs to keep a capable client from turning an authorization error, token passthrough, overbroad tool, or local transport mistake into cross-user data access or unintended mutation.

### Unique angle

Start from the current MCP specification and its attack model, then build outward to application authorization. Topic 43 covers least-privilege tool design. This article covers the server boundary: transport choice, authentication, audience-bound tokens, per-tool authorization, consent, session isolation, input handling, logging, and sandboxing.

### Direct-answer target and outline

Open with a 40 to 80 word answer: use stdio for a single trusted local client or authenticated HTTPS for remote access, validate audience-bound tokens on every HTTP request, forbid token passthrough, authorize each resource and tool, isolate sessions by user, minimize scopes, and gate consequential tools at execution time.

1. Draw the host, client, server, authorization server, downstream API, and data boundaries.
2. Choose stdio or HTTP deliberately instead of exposing a local server broadly.
3. Implement protected-resource discovery, PKCE-compatible authorization, token audience validation, and exact redirect controls.
4. Prevent confused-deputy and token-passthrough paths.
5. Authorize every tool and resource, validate inputs, scrub logs, and separate user sessions.
6. Require execution-time approval and sandboxing for mutations or code execution.
7. Test negative cases with synthetic users and harmless tools.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/least-privilege-mcp-tools` and `/blog/coding-agent-sandbox-egress`
- Contextual LyraShield link: `/methodology`; mention that the repository MCP surface has read-only findings and launch-readiness tools plus approval-gated scan and report mutations, while public production availability remains unclaimed

### FAQ decision

Include four FAQs: whether local stdio needs authorization, whether OAuth alone provides application authorization, whether tool annotations are trusted, and when a human approval is necessary.

### Image concept

A remote tool path entering an isolation chamber through an audience-bound access plane, with downstream tokens on a visibly separate route. No protocol logo or generated labels.

### Sources and claim guardrails

Use B5-S05, B5-S06, B5-S07, and B5-S08. The versioned 2025-11-25 authorization specification is the normative anchor. Do not say that MCP itself enforces least privilege or safe tools. Do not present prompt filtering as a complete authorization control.

## Topic 71: Secure an AI SaaS With Stripe

- Program index: 71
- Slug: `ai-saas-stripe-security`
- Primary query: `ai saas stripe security`
- Search intent: stack-specific implementation guide
- Target length: 1,500 words
- Tags: `vibe-coding-security`, `web-security`, `access-control`, `verification`

### Reader and problem

The reader has a generated checkout and subscription flow that works in a happy-path test, but the browser may still decide plan access, retries may duplicate work, webhook delivery may be reordered, or secret keys may have leaked into client code.

### Unique angle

Cover the full payment-to-entitlement state machine without duplicating topic 24 on signature verification or topic 25 on server-owned entitlements. The article should show how signature verification, event deduplication, idempotent API calls, authoritative server state, least-privilege keys, and safe test-to-live promotion fit together.

### Direct-answer target and outline

Open with a 40 to 80 word answer: keep Stripe secret keys server-side, verify webhook signatures against the raw request, process events idempotently without depending on delivery order, derive access from server-owned payment or entitlement state, and test failure, retry, downgrade, cancellation, refund, and delayed-event paths before live mode.

1. Map browser, application server, Stripe API, webhook endpoint, database, and entitlement checks.
2. Show the vulnerable pattern: trusting a success redirect or client plan flag.
3. Verify signatures before parsing business events and deduplicate by event or operation identity.
4. Use Stripe idempotency keys for retried writes and make fulfillment itself idempotent.
5. Store server-owned subscription or entitlement state and reconcile missing or reordered events.
6. Restrict and rotate keys; keep sandbox and live data separate.
7. Test owned sandbox scenarios and explain residual fraud, tax, and business-logic limits.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`, to record whether server-owned authorization, secret handling, testing, monitoring, and recovery controls have owners; state that it does not connect to Stripe or inspect billing state
- Relevant secondary tool: `/tools/secret-exposure-scanner`, limited to common credential patterns in selected text files and not Stripe configuration, webhook destinations, Git history, or access logs
- Related dependencies: `/blog/stripe-webhook-signature-security`, `/blog/payment-entitlement-server-source-truth`, and `/blog/idempotency-replay-protection`
- Do not add a passive public-surface conversion; it is unrelated to the private Stripe state machine

### FAQ decision

Include four FAQs: whether the success page can grant access, whether Stripe retries webhooks, whether events arrive in order, and whether publishable keys are secrets.

### Image concept

A payment event corridor with a signature plane, idempotency receipt, and a separate server-owned entitlement vault. No Stripe logo, card details, currency, or fake billing dashboard.

### Sources and claim guardrails

Use B5-S09 through B5-S14. Do not state that Stripe webhooks are exactly-once or ordered. Do not imply that a verified signature proves the business action is authorized. Do not publish draft LyraShield pricing or claim a LyraShield Stripe integration.

## Topic 72: AI App Pre-Launch Security Checklist

- Program index: 72
- Slug: `ai-app-prelaunch-security-checklist`
- Primary query: `ai app security checklist`
- Search intent: actionable checklist
- Target length: 1,400 words
- Tags: `vibe-coding-security`, `verification`, `access-control`, `web-security`, `supply-chain`, `agent-security`

### Reader and problem

The reader is close to launch and needs a bounded, evidence-producing pass across the app rather than a reassuring list of boxes. They need to know what must block release, what can be accepted with an owner and date, and what remains untested.

### Unique angle

This is the operational pre-launch checklist. The authority guide explains the full model, while topic 83 defines the decision gate. This article supplies the checks and evidence to bring to that gate: scope, accounts and authorization, secrets, inputs, sessions, dependencies, deployment, agents, monitoring, recovery, and retained limitations.

### Direct-answer target and outline

Open with a 40 to 80 word answer: define the target and data boundary, test authorization with separate accounts, inspect secrets and dependencies, exercise server-side validation and session controls, review agent and deployment permissions, prove monitoring and restore paths, retest fixes, and record anything not covered.

1. Freeze target, release commit, owner, environment, and authorized test scope.
2. Test access, tenant isolation, admin paths, and server-side authorization.
3. Inspect secrets, sessions, inputs, outputs, dependencies, and deployment settings.
4. Review agent, CI, and production permissions.
5. Exercise monitoring, incident contacts, backups, and rollback.
6. Record evidence, limitations, accepted risks, and retest status.
7. Hand the evidence to the go or no-go gate instead of treating completion as proof.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/human-review-threat-model-vibe-coding` and `/blog/security-monitoring-ai-apps`
- Contextual LyraShield links: `/methodology` and `/sample-report`, clearly labeling the sample as illustrative and the full product as in active development

### FAQ decision

Include four FAQs: how long the checklist takes, whether a clean scan is enough, which findings block launch, and how to handle an untestable control.

### Image concept

Six evidence planes converging on a controlled release aperture, with visible incomplete slots retained rather than hidden. No checkmark wall or fake score.

### Sources and claim guardrails

Use B5-S15 through B5-S19. Do not promise comprehensive coverage. Keep the Vibe Security 50 split at 43 machine-testable and 7 evidence-required controls when mentioned. A checked control is documentation, not independent verification.

## Topic 73: The Two-Account Test for Data Isolation

- Program index: 73
- Slug: `two-account-idor-test`
- Primary query: `test app authorization two accounts`
- Search intent: safe how-to
- Target length: 1,250 words
- Tags: `vibe-coding-security`, `access-control`, `verification`

### Reader and problem

The reader needs a small test that catches horizontal authorization failures without attacking another user or relying on guessable integer IDs. They may have authenticated routes but no proof that each server query is scoped to the current owner or tenant.

### Unique angle

Topic 3 explains how to find IDOR generally. This article is a repeatable test procedure: create synthetic records under account A, attempt the same read and mutation as account B, cover alternate methods and bulk paths, inspect server enforcement, then add the case as a regression test.

### Direct-answer target and outline

Open with a 40 to 80 word answer: in an owned test environment, create two ordinary accounts and separate records, capture account B's legitimate request, substitute only account A's object identifier, and confirm every read, update, delete, export, and nested-resource path is denied without leaking data.

1. Obtain authorization and use an isolated staging or local environment.
2. Create accounts A and B with synthetic objects and equal roles.
3. Build a request matrix across read, write, delete, bulk, file, and nested paths.
4. Change only the object reference while preserving account B's valid session.
5. Distinguish a denial from a hidden data leak in timing, metadata, or related objects.
6. Fix with server-side relationship or tenant-scoped queries and deny-by-default checks.
7. Add negative integration tests and repeat for role boundaries separately.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/supabase-rls-checker` when the application uses Supabase; otherwise position `/tools/ai-app-security-checklist` as the general companion
- Related dependencies: `/blog/idor-ai-built-apps`, `/blog/server-side-authorization-ai-apis`, and `/blog/multi-tenant-data-isolation`
- Contextual LyraShield link: `/methodology` for explaining why the test produces bounded evidence rather than a universal pass

### FAQ decision

Include three FAQs: whether UUIDs prevent IDOR, whether `404` is required instead of `403`, and whether two accounts test administrator boundaries.

### Image concept

Two isolated account compartments separated by an ownership plane, with one synthetic object path stopped at the boundary. No user portraits or personal data.

### Sources and claim guardrails

Use B5-S20 through B5-S23. All steps must target an owned local or staging system. Do not include mass enumeration or exploitation automation. State that unpredictable IDs reduce guessing but do not replace authorization.

## Topic 74: Secret Scanning Before Every Commit

- Program index: 74
- Slug: `secret-scanning-before-commit`
- Primary query: `secret scanning git`
- Search intent: workflow how-to
- Target length: 1,300 words
- Tags: `vibe-coding-security`, `supply-chain`, `verification`

### Reader and problem

The reader wants immediate local feedback before a secret reaches shared history, while also needing a server-side control that cannot be bypassed by skipping a local hook.

### Unique angle

Focus on layered prevention: staged-content scanning for speed, pre-push or CI scanning for shared enforcement, provider push protection where available, test-fixture design, governed bypasses, and correct response when a real secret has already been committed.

### Direct-answer target and outline

Open with a 40 to 80 word answer: scan staged changes locally for fast feedback, enforce the same or stronger detection on the remote, protect supported provider tokens at push time, keep synthetic fixtures scanner-safe, and rotate a real exposed credential before considering history cleanup.

1. Explain working tree, staged diff, commit history, and remote push coverage.
2. Add a pinned Gitleaks pre-commit configuration and a server-side CI scan.
3. Show how bypasses are reviewed and logged rather than silently ignored.
4. Keep test fixtures inert and document custom patterns.
5. Triage a detection without printing the secret.
6. Rotate or revoke first, then decide whether coordinated history rewriting is warranted.
7. Explain pattern, scope, encoding, and custom-secret limitations.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/secret-exposure-scanner`, explicitly limited to selected local text files and not Git history
- Related dependencies: `/blog/api-keys-frontend-ai-apps` and `/blog/secrets-ai-coding-prompts`
- Do not add a separate public-surface conversion; keep the free-tool conversion on the browser-local secret scanner and its stated limits

### FAQ decision

Include four FAQs: whether `.gitignore` protects a committed secret, whether deleting a line is enough, whether pre-commit hooks can be bypassed, and how to handle false positives.

### Image concept

A credential-shaped signal stopped before it enters a sealed commit chain, with a second remote gate downstream. No real key format or readable token.

### Sources and claim guardrails

Use B5-S24 through B5-S29. Do not print realistic secret examples. Never advise history rewriting before rotation. Explain that GitHub push protection coverage and availability depend on account and repository settings.

## Topic 75: Dependency Scanning With OSV and Lockfiles

- Program index: 75
- Slug: `osv-dependency-scanning`
- Primary query: `osv dependency scanner`
- Search intent: tool-led how-to
- Target length: 1,350 words
- Tags: `vibe-coding-security`, `supply-chain`, `verification`

### Reader and problem

The reader needs to scan the versions actually resolved by the build, interpret aliases and affected ranges, and avoid turning a matching advisory into either panic or a false claim of exploitability.

### Unique angle

Topic 38 covers why to audit AI-suggested dependencies. This article teaches the OSV workflow: choose the right lockfiles or artifacts, run OSV Scanner v2 safely, understand direct and transitive coverage, record ignored findings with expiry and reason, update deliberately, then reinstall and retest.

### Direct-answer target and outline

Open with a 40 to 80 word answer: commit and scan the lockfiles that represent the resolved build, run OSV Scanner against the source tree or explicit lockfile, inspect the advisory's ecosystem and affected range, update or override deliberately, reinstall from a clean state, and rerun both the scanner and application tests.

1. Explain manifest versus lockfile versus installed artifact.
2. Run an inert OSV Scanner v2 source or lockfile example.
3. Interpret OSV IDs, aliases, ecosystem ranges, fixed events, and transitive paths.
4. Confirm the scanner actually supports the relevant artifact and lockfile.
5. Record temporary ignores with reason and expiry.
6. Apply an update in a branch, reinstall cleanly, run tests, and rescan.
7. Separate known-vulnerable version detection from code-path reachability and deployment exposure.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/ai-dependency-vulnerability-audit` and `/blog/install-script-supply-chain-security`
- Contextual LyraShield link: `/methodology`; describe SCA as one coverage layer and avoid claiming public full-scan availability

### FAQ decision

Include four FAQs: whether OSV scans source code, whether a manifest is enough, whether every match is exploitable, and whether ignored advisories disappear permanently.

### Image concept

A lockfile dependency lattice aligned against a separate advisory range plane, with one affected path marked and other paths left neutral. No package logos or advisory text.

### Sources and claim guardrails

Use B5-S30 through B5-S34. Follow current OSV Scanner v2 commands, not v1 syntax. State supported-artifact limitations. Do not tell readers to run experimental remediation on an untrusted repository without explaining package-script and registry risks.

## Topic 76: SAST vs DAST vs SCA for AI-Built Apps

- Program index: 76
- Slug: `sast-dast-sca-ai-apps`
- Primary query: `sast vs dast vs sca`
- Search intent: comparison
- Target length: 1,400 words
- Tags: `vibe-coding-security`, `verification`, `supply-chain`, `web-security`

### Reader and problem

The reader is choosing security checks and needs to know what evidence each category can produce, when it runs, what target it requires, and which blind spots remain.

### Unique angle

Compare evidence and coverage rather than vendors. SAST inspects code or compiled representations without running the application. DAST exercises a running target from the outside. SCA identifies third-party components and known advisories. Each answers a different question; none proves business-logic authorization, complete runtime coverage, or overall security alone.

### Direct-answer target and outline

Open with a 40 to 80 word answer that assigns one job to each category and recommends layering them with threat modeling, targeted manual tests, secrets checks, and retests. Avoid ranking one category as universally best.

1. Define target, timing, and output for SAST, DAST, and SCA.
2. Compare access-control, injection, configuration, dependency, and runtime-flow coverage.
3. Show one example issue each category is well-positioned to detect.
4. Show one important miss or false-positive path for each.
5. Build a small pipeline: pull-request SAST and SCA, controlled DAST in staging, and targeted manual checks.
6. Explain triage, evidence retention, and retesting by originating technique.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/ai-generated-tests-security` and `/blog/ai-dependency-vulnerability-audit`
- Contextual LyraShield link: `/methodology`, stating that SCA, secrets, URL checks, and repository review are layers rather than universal verification

### FAQ decision

Include four FAQs: whether SAST needs a running app, whether DAST sees source code, whether SCA finds application bugs, and which checks belong in pull requests versus staging.

### Image concept

Three distinct evidence planes viewing the same application structure from code, runtime, and dependency directions, with non-overlapping illuminated regions. No vendor logos or winner podium.

### Sources and claim guardrails

Use B5-S18, B5-S19, B5-S35, B5-S36, and B5-S37. Do not publish vendor detection-rate comparisons. Do not describe SCA as SBOM generation only, or DAST as proof of exploitability in every configuration.

## Topic 77: A Security Review Prompt That Does Not Replace Testing

- Program index: 77
- Slug: `ai-security-review-prompt`
- Primary query: `security review prompt for ai code`
- Search intent: reusable template with limitations
- Target length: 1,300 words
- Tags: `vibe-coding-security`, `verification`, `agent-security`

### Reader and problem

The reader wants a practical prompt to make an AI review more focused, but may otherwise accept plausible findings, fixes, or passing generated tests without independent validation.

### Unique angle

Provide a bounded review prompt that asks for architecture assumptions, changed trust boundaries, candidate findings, source locations, safe reproduction ideas, and explicit uncertainty. Then turn every output into a review queue. The value is better questions and traceability, not delegated proof.

### Direct-answer target and outline

Open with a 40 to 80 word answer: give the model the exact diff, architecture, data classifications, and security requirements; ask it to separate observations from hypotheses, cite code paths, propose safe tests, and state unknowns; then validate every result with tools, tests, or a qualified reviewer.

1. Explain why generic prompts produce generic or overconfident output.
2. Supply a compact template with scope, assets, trust boundaries, diff, required checks, output schema, and prohibitions.
3. Require candidate, evidence, confidence, safe verification, and limitation fields.
4. Run the prompt against a toy vulnerable handler.
5. Verify the output with code review and an owned test.
6. Reject invented files, APIs, runtime behavior, or claims based only on model confidence.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/ai-generated-tests-security` and `/blog/human-review-threat-model-vibe-coding`
- Contextual LyraShield link: `/methodology` for the detected versus independently verified distinction

### FAQ decision

Include three FAQs: whether a longer prompt is better, whether the model should generate exploit code, and how to validate a model-reported finding.

### Image concept

A translucent prompt plane feeding candidate signals into a separate evidence and test chamber, with uncertain output visibly held before the gate. No chat interface or generated text.

### Sources and claim guardrails

Use B5-S16, B5-S38, B5-S39, and B5-S40. Do not claim a prompt finds all vulnerabilities. Do not use model confidence as proof. Keep any vulnerable example local, minimal, and non-deployable.

## Topic 78: Threat Modeling for Non-Security Founders

- Program index: 78
- Slug: `threat-model-ai-startup`
- Primary query: `startup threat model template`
- Search intent: founder-friendly guide and template
- Target length: 1,400 words
- Tags: `vibe-coding-security`, `verification`, `agent-security`, `access-control`

### Reader and problem

The reader knows the product flow but not formal threat-modeling methods. They need a lightweight artifact that identifies what matters, where trust changes, what can go wrong, and which decision or test owns each risk.

### Unique angle

Use OWASP's methodology-neutral four questions rather than forcing a heavy framework. The deliverable is one system sketch, a small list of assets and trust boundaries, concrete abuse cases, mitigations, owners, tests, assumptions, and update triggers.

### Direct-answer target and outline

Open with a 40 to 80 word answer: sketch users, services, stores, agents, and data flows; mark every trust boundary; ask what can go wrong at each boundary; choose a mitigation or explicit risk decision; and attach an owner and verification step to each important threat.

1. Define the release, feature, or workflow in scope.
2. Sketch actors, data stores, services, third parties, agents, and flows.
3. Mark credentials, sensitive data, privilege changes, and production effects.
4. Generate misuse cases using the four questions, optionally using STRIDE as a prompt.
5. Record mitigation, owner, evidence, residual risk, and review trigger.
6. Revisit after a major feature, architecture change, incident, or new integration.
7. Explain what the model cannot establish without implementation testing.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/human-review-threat-model-vibe-coding` and `/blog/indirect-prompt-injection-coding-agents`
- Contextual LyraShield link: `/methodology`, connecting threats to scoped evidence without claiming automated threat-model verification

### FAQ decision

Include four FAQs: whether a diagram is required, whether STRIDE is mandatory, how long a first model should take, and when to update it.

### Image concept

A small system of graphite components connected across translucent trust boundaries, with one agent path and one data store highlighted. No sprawling enterprise diagram or labels.

### Sources and claim guardrails

Use B5-S16, B5-S17, B5-S41, and B5-S42. Do not present one method as the official OWASP methodology. Avoid fabricated startup incidents or universal time estimates.

## Topic 79: Why Every Security Fix Needs a Retest

- Program index: 79
- Slug: `security-fix-retest-workflow`
- Primary query: `security retesting`
- Search intent: explainer and workflow
- Target length: 1,350 words
- Tags: `vibe-coding-security`, `verification`

### Reader and problem

The reader has merged a plausible security fix and is tempted to close the finding because the code looks right or the original scanner no longer reports it in an incomplete run.

### Unique angle

This article begins after a finding has already been accepted as real. It explains how to retest the original condition with a fresh build or server-owned scan, preserve equivalent scope and coverage, add regression checks, and keep an inconclusive result open. Topic 80 addresses whether the initial finding is real.

### Direct-answer target and outline

Open with a 40 to 80 word answer: rerun the original safe reproduction or originating deterministic check against the fixed build, confirm the relevant coverage completed, test adjacent abuse paths and regressions, and record the result. If the check could not run or the original evidence cannot be recreated, mark the retest inconclusive rather than fixed.

1. Preserve the original finding, target version, evidence, and reproduction conditions.
2. Review the fix for bypasses and affected trust boundaries.
3. Create a fresh build or scan target rather than reusing stale output.
4. Rerun the originating check with complete applicable coverage.
5. Test adjacent variants and normal behavior.
6. Record retest-confirmed, detected-again, or inconclusive with limitations.
7. Add a regression test and retain the original evidence.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/placeholder-logic-silent-failures` and `/blog/ai-generated-tests-security`
- Contextual LyraShield links: `/methodology` and `/sample-report`; state that the repository retest contract validates a clean deterministic retest only when originating coverage is complete, while engine-only absence remains inconclusive

### FAQ decision

Include four FAQs: whether code review is a retest, whether a clean scan closes a finding, who should perform the retest, and what an inconclusive retest means.

### Image concept

A repaired path returning through a fresh retest ring, with one incomplete coverage segment preventing the final receipt from closing. No success badge.

### Sources and claim guardrails

Use B5-S18, B5-S43, B5-S44, and B5-P05. Keep retest-confirmed distinct from independently verified. Do not claim that scanner absence proves the underlying condition is gone when coverage was incomplete.

## Topic 80: How to Verify a Security Finding

- Program index: 80
- Slug: `verify-security-finding`
- Primary query: `verify vulnerability finding`
- Search intent: evidence-validation guide
- Target length: 1,400 words
- Tags: `vibe-coding-security`, `verification`

### Reader and problem

The reader has a scanner, AI, or reviewer report and needs to decide whether the evidence supports a real vulnerability, a weakness needing more context, a duplicate, an accepted risk, or a false positive.

### Unique angle

This article stops before remediation. It validates the initial claim by checking scope, target version, source location, data flow, preconditions, safe reproduction, impact, and independent evidence. It does not treat severity or model confidence as proof.

### Direct-answer target and outline

Open with a 40 to 80 word answer: confirm the finding refers to the tested version and in-scope component, inspect the exact code or request path, reproduce the condition safely in an owned environment, verify prerequisites and impact, and retain evidence from a method independent of the original assertion before labeling it verified.

1. Normalize the claim: weakness, location, target version, prerequisites, and asserted impact.
2. Check whether the reported code or runtime path exists.
3. Identify the original detector and its evidence.
4. Reproduce safely with synthetic data and minimum effect.
5. Seek independent evidence or reviewer confirmation.
6. Separate confidence, severity, exploitability, and environmental risk.
7. Record verified, detected but unverified, blocked, duplicate, or false positive with rationale.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/ai-generated-tests-security` and `/blog/human-review-threat-model-vibe-coding`
- Contextual LyraShield link: `/methodology`; use the exact detected and independently verified definitions

### FAQ decision

Include four FAQs: whether scanner confidence proves a finding, whether reproduction requires an exploit, whether severity equals risk, and when a finding should remain unverified.

### Image concept

A detected signal passing through a separate evidence plane before receiving a verification receipt, with rejected and unresolved paths still visible. No bug icon or fake severity chart.

### Sources and claim guardrails

Use B5-S43 through B5-S47 and B5-P05. No live-target exploit steps. Label inferred impact. Do not set verified from confidence, a second model opinion, or the same scanner rerun.

## Topic 81: SARIF for AI Coding Workflows

- Program index: 81
- Slug: `sarif-ai-coding-workflow`
- Primary query: `sarif security results`
- Search intent: format and integration guide
- Target length: 1,350 words
- Tags: `vibe-coding-security`, `verification`, `supply-chain`

### Reader and problem

The reader has output from several security checks and wants one machine-readable result format that can preserve rules, locations, messages, fingerprints, and workflow context without pretending that normalization verifies the findings.

### Unique angle

Explain SARIF as a transport and interchange format. Show the minimum useful 2.1.0 structure, stable rule IDs, repository-relative locations, fingerprints for deduplication, redaction, categories for separate analyses, validation, artifact retention, and GitHub upload behavior.

### Direct-answer target and outline

Open with a 40 to 80 word answer: emit SARIF 2.1.0 with a stable tool identity, rules, results, repository-relative locations, and fingerprints; validate the file; retain it as a build artifact; and upload it to a compatible code-scanning surface. Treat every result as a reported observation until separately verified.

1. Define what SARIF standardizes and what it does not.
2. Show a minimal inert `runs`, `tool.driver`, `rules`, and `results` example.
3. Use stable IDs, levels, messages, artifact locations, regions, and fingerprints.
4. Remove secrets and personal data from messages and properties.
5. Validate JSON and SARIF schema before upload.
6. Upload with a stable category and explain pull-request diff display limits.
7. Preserve raw scanner evidence separately where SARIF cannot carry enough context.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/ai-dependency-vulnerability-audit` and `/blog/cicd-agent-confused-deputy`
- Contextual LyraShield link: `/methodology`; describe the repository workflow's generated SARIF artifact and optional GitHub upload accurately, without implying hosted product availability

### FAQ decision

Include four FAQs: whether SARIF is only for SAST, whether SARIF verifies a finding, why duplicate alerts appear, and whether SARIF files can contain secrets.

### Image concept

Several scanner receipts entering a normalized evidence envelope with stable locations, then branching to an artifact store and review surface. No JSON text or GitHub logo.

### Sources and claim guardrails

Use B5-S48 through B5-S51. GitHub supports a subset of SARIF 2.1.0. Explain that missing fingerprint data may produce duplicate alerts. Do not claim all SARIF properties are displayed or supported.

## Topic 82: Add a Security Diff Gate to Pull Requests

- Program index: 82
- Slug: `security-diff-gate-pull-requests`
- Primary query: `pull request security gate`
- Search intent: implementation how-to
- Target length: 1,400 words
- Tags: `vibe-coding-security`, `verification`, `supply-chain`

### Reader and problem

The reader has security jobs in CI, but the wrong commit may be scanned, a skipped job may look green, an optional upload failure may mask the gate, or a broad baseline backlog may make every pull request unusable.

### Unique angle

Focus on the exact base-to-head boundary and the decision contract. The article should compute immutable SHAs, enumerate changed paths, run relevant secrets, dependency, and code checks, report every finding, gate only configured severity, fail closed on scanner infrastructure errors, and require the final decision check on the protected branch.

### Direct-answer target and outline

Open with a 40 to 80 word answer: resolve the pull request's immutable base and head SHAs, scan only the intended change with explicit coverage rules, distinguish findings from scanner failures, publish reviewable results, and make one always-running decision job a required check against the latest commit.

1. Define gate inputs: base SHA, head SHA, modes, path scope, severity policy, and required scanners.
2. Resolve and verify refs rather than trusting ambiguous branch names.
3. Detect secrets, changed dependencies, and changed-code patterns or analysis results.
4. Keep reporting separate from the final gate decision.
5. Fail closed on missing required scanners while allowing optional result publication to fail independently.
6. Make the decision job required and prevent bypass or path-filter deadlocks.
7. Test clean, finding, scanner-error, skipped-job, and updated-head scenarios.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/secret-exposure-scanner`
- Related dependencies: `/blog/cicd-agent-confused-deputy` and `/blog/ai-dependency-vulnerability-audit`
- Contextual LyraShield link: `/methodology`; the repository diff-gate can be described as exact base-to-head code with SARIF output, but not as a hosted public product

### FAQ decision

Include four FAQs: whether to scan only changed lines, how to handle existing findings, what happens when a scanner crashes, and whether a skipped required check can merge.

### Image concept

An exact code-diff corridor between two immutable commit blocks, passing through a narrow decision gate while full-history context remains visible behind it. No repository logo or code text.

### Sources and claim guardrails

Use B5-S01, B5-S04, B5-S49, B5-S52, and B5-S53. Do not claim a diff gate replaces a baseline scan. Note that GitHub can treat `neutral` and `skipped` conclusions as success in status-check contexts, so the dedicated decision job must encode the intended policy.

## Topic 83: Build a Go / No-Go Security Launch Gate

- Program index: 83
- Slug: `security-launch-readiness-gate`
- Primary query: `security launch readiness checklist`
- Search intent: decision framework
- Target length: 1,400 words
- Tags: `vibe-coding-security`, `verification`, `access-control`, `web-security`

### Reader and problem

The reader has findings and checklist results but no explicit release policy. Decisions are vulnerable to last-minute optimism, missing scans, undocumented accepted risk, or a score that hides incomplete evidence.

### Unique angle

Topic 72 gathers the evidence. This article converts that evidence into an accountable release decision. It defines not evaluated, go, go with conditions, and no-go; mandatory evidence; blocker classes; exception owners and expiry; rollback readiness; and a signed decision record.

### Direct-answer target and outline

Open with a 40 to 80 word answer: block release when required checks did not complete, critical trust boundaries lack evidence, unresolved high-impact findings exceed policy, or rollback and incident ownership are absent. Permit conditional release only with named owners, compensating controls, deadlines, retained limitations, and approval from the accountable decision maker.

1. Define the release candidate, decision owner, scope, and evidence cutoff.
2. Require completed checks and record coverage limitations before scoring findings.
3. Define non-negotiable blockers and contextual conditions.
4. Separate technical severity from application-specific risk and exposure.
5. Record accepted risk, owner, expiry, monitoring, rollback, and follow-up retest.
6. Produce one decision record: not evaluated, go, go with conditions, or no-go.
7. Reopen the gate when the candidate, environment, evidence, or assumptions change.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/ai-app-prelaunch-security-checklist` as a same-batch dependency and `/blog/security-monitoring-ai-apps` as a prior-release dependency
- Contextual LyraShield links: `/methodology` and `/sample-report`; describe the repository launch-readiness implementation as code that returns NOT_EVALUATED, GO, GO_WITH_CONDITIONS, or NO_GO, not a security guarantee or a public hosted feature

### FAQ decision

Include four FAQs: who owns the decision, which findings always block launch, whether a score can decide automatically, and when a conditional launch is defensible.

### Image concept

A release candidate held before a controlled aperture with separate go, conditional, and blocked evidence paths, plus visible rollback and owner receipts. No traffic-light cliché or numeric score.

### Sources and claim guardrails

Use B5-S15 through B5-S19, B5-S45, and B5-P04. Do not convert the current LyraShield score thresholds into universal industry policy. State that the current implementation remains NOT_EVALUATED without a completed scan. No launch decision is a warranty.

## Topic 84: Create a Security Report for a Client Handoff

- Program index: 84
- Slug: `client-security-report-handoff`
- Primary query: `client security report template`
- Search intent: guide and template
- Target length: 1,350 words
- Tags: `vibe-coding-security`, `verification`

### Reader and problem

The reader is an agency or builder handing an application to a client. They need a report that lets an executive understand the decision and lets an engineer reproduce and fix issues, without exposing credentials, personal data, target coordinates, or unsupported claims.

### Unique angle

Build a two-layer handoff: a concise decision summary and a technical appendix. Preserve target and version, authorized scope, timeline, methodology, coverage, limitations, finding states, evidence references, remediation and retest status, residual risk, owners, and next actions. Protect the report as sensitive data.

### Direct-answer target and outline

Open with a 40 to 80 word answer: identify the exact release and scope, summarize the decision and material risks, list every finding with evidence and status, show what was not tested, record fixes and retests, assign owners and dates, redact sensitive data, and deliver the report through an access-controlled channel.

1. Record client, target, commit or release, dates, authorization, scope, and limitations.
2. Write an executive summary in business context without guarantees.
3. Provide a coverage matrix that distinguishes completed, limited, not applicable, and not tested.
4. Give each finding a stable ID, state, evidence reference, impact, remediation, owner, and retest result.
5. Separate detected, independently verified, retest-confirmed, accepted risk, and inconclusive outcomes.
6. Mask sensitive details, restrict access, version the report, and define correction handling.
7. End with decision, residual risks, next checks, incident contacts, and ownership transfer.

### Required links and conversion

- Authority link: `/blog/vibe-coding-security-guide`
- Free tool: `/tools/ai-app-security-checklist`
- Related dependencies: `/blog/security-audit-log-design` and `/blog/security-fix-retest-workflow` as a same-batch dependency
- Contextual LyraShield link: `/sample-report`, explicitly describing it as a sanitized mock in active development rather than a real customer assessment

### FAQ decision

Include four FAQs: whether raw scanner output is enough, whether the client report should include proof-of-concept details, how to show retest status, and how the report should be shared.

### Image concept

Scope, coverage, finding, limitation, and retest receipts assembling into a protected report structure, with sensitive coordinates sealed in a separate compartment. No client logo, PDF mockup, or fake dashboard.

### Sources and claim guardrails

Use B5-S43, B5-S44, B5-S54, B5-S55, and B5-P06. Do not call the report a certificate, warranty, compliance attestation, or complete penetration test unless the underlying engagement actually meets that contract. Do not invent customers or qualifications.

## Batch linking rules

- Topic 72 may link forward to topic 83 only if both pages publish in the same Batch 5 release candidate.
- Topic 79 may link to topic 80 for finding verification, and topic 80 may link back to topic 79 for post-fix retesting.
- Topic 81 may link to topic 82 for enforcement, but topic 82 should not require SARIF because a gate can consume other check outputs.
- Topic 84 may link to topic 79 for retest status. All other required related links point to earlier releases.
- Drafts must not link to a same-batch slug unless the validator confirms that dependency is present and publishable in the same release.

## Batch review checklist

- [ ] Every introduction answers its own query in 40 to 80 words.
- [ ] Topics 69 and 82 remain distinct: workflow privilege versus merge policy.
- [ ] Topics 72 and 83 remain distinct: evidence collection versus decision.
- [ ] Topics 79 and 80 remain distinct: post-fix retest versus initial finding validation.
- [ ] Topic 81 says SARIF transports results and does not verify them.
- [ ] Every external technical claim maps to `batch-5.md` research IDs.
- [ ] Every article includes at least three authoritative sources and two primary or official sources.
- [ ] All safe verification steps use local, sandbox, or explicitly owned environments.
- [ ] Product copy reflects current public availability and does not imply automatic fix-PR execution.
- [ ] Humanizer audit removes vague attribution, generic signposting, repetitive list cadence, sales filler, manufactured conclusions, and prohibited dash characters.
- [ ] Image assignments are semantically distinct and satisfy the shared-library reuse rules.
- [ ] Individual and batch publication approval remain pending until rendered review is complete.
