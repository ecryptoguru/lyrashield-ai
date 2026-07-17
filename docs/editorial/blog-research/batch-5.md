# Batch 5 research and claim map

Research date: 2026-07-17
Status: primary-source review complete, article audits pending
Owner: LyraShield Team
Coverage: topics 69 through 84

## Research method

The research used official standards, government publications, official protocol and vendor documentation, and current LyraShield repository code. Search results were used to locate canonical pages, then the canonical pages were reviewed for the claims recorded below. Living documentation without a visible publication date is labeled with the access date instead of an invented update date.

Each future article must re-open its sources before publication. A citation supports only the mapped claim, not every sentence in the surrounding section. Where the article draws a conclusion from more than one source, the conclusion must be labeled as editorial synthesis.

## External source library

| ID     | Owner and source                                                             | Date or version                                     | Canonical URL                                                                                                                                                             | Primary use                                                                                            |
| ------ | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| B5-S01 | GitHub Docs, Secure use reference                                            | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/actions/reference/security/secure-use                                                                                                          | Full-SHA pinning, untrusted workflow input, privileged-trigger risks                                   |
| B5-S02 | GitHub Docs, Use `GITHUB_TOKEN` for authentication in workflows              | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/actions/tutorials/authenticate-with-github_token                                                                                               | Job-level least-privilege token permissions                                                            |
| B5-S03 | GitHub Docs, OpenID Connect reference                                        | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/actions/reference/security/oidc                                                                                                                | OIDC claims and cloud trust conditions                                                                 |
| B5-S04 | OWASP Cheat Sheet Series, CI/CD Security Cheat Sheet                         | Living documentation; accessed 2026-07-17           | https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html                                                                                            | Pipeline identities, flow control, credentials, artifact integrity, logging                            |
| B5-S05 | Model Context Protocol, Security Best Practices                              | Living documentation; accessed 2026-07-17           | https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices                                                                                           | Confused deputy, token passthrough, session hijacking, local server and sandbox risks                  |
| B5-S06 | Model Context Protocol, Authorization specification                          | Protocol version 2025-11-25; accessed 2026-07-17    | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization                                                                                              | Protected-resource metadata, audience binding, token validation, PKCE, HTTPS                           |
| B5-S07 | Model Context Protocol, Understanding Authorization in MCP                   | Living documentation; accessed 2026-07-17           | https://modelcontextprotocol.io/docs/tutorials/security/authorization                                                                                                     | Least-privilege scopes, token storage, logging, and server-side validation                             |
| B5-S08 | Model Context Protocol, Specification                                        | Protocol version 2025-11-25; accessed 2026-07-17    | https://modelcontextprotocol.io/specification/2025-11-25                                                                                                                  | User consent, data privacy, tool safety, and untrusted tool metadata                                   |
| B5-S09 | Stripe Docs, Receive Stripe events in your webhook endpoint                  | Living documentation; accessed 2026-07-17           | https://docs.stripe.com/webhooks                                                                                                                                          | Signature verification, duplicate delivery, retries, ordering, API-version behavior                    |
| B5-S10 | Stripe API Reference, Idempotent requests                                    | Living documentation; accessed 2026-07-17           | https://docs.stripe.com/api/idempotent_requests                                                                                                                           | Safe retry behavior and idempotency-key semantics                                                      |
| B5-S11 | Stripe Docs, API keys                                                        | Living documentation; accessed 2026-07-17           | https://docs.stripe.com/keys                                                                                                                                              | Publishable, secret, restricted, sandbox, and live key boundaries                                      |
| B5-S12 | Stripe Docs, Fulfill orders                                                  | Living documentation; accessed 2026-07-17           | https://docs.stripe.com/checkout/fulfillment                                                                                                                              | Server-side fulfillment from payment events                                                            |
| B5-S13 | Stripe Docs, Entitlements                                                    | Living documentation; accessed 2026-07-17           | https://docs.stripe.com/billing/entitlements                                                                                                                              | Server-managed feature access and entitlement-change events                                            |
| B5-S14 | Stripe Docs, Using webhooks with subscriptions                               | Living documentation; accessed 2026-07-17           | https://docs.stripe.com/billing/subscriptions/webhooks                                                                                                                    | Asynchronous subscription state and webhook failure behavior                                           |
| B5-S15 | OWASP Foundation, Application Security Verification Standard                 | ASVS 5.0.0 released 2025-05-30; accessed 2026-07-17 | https://owasp.org/www-project-application-security-verification-standard/                                                                                                 | Testable web application control requirements and version-qualified IDs                                |
| B5-S16 | NIST, Guidelines on Minimum Standards for Developer Verification of Software | NISTIR 8397 published 2021-10-06                    | https://www.nist.gov/publications/guidelines-minimum-standards-developer-verification-software                                                                            | Threat modeling, static scanning, secret checks, black-box tests, fuzzing, web scanning, included code |
| B5-S17 | NIST, Secure Software Development Framework Version 1.1                      | SP 800-218 final 2022-02-03                         | https://csrc.nist.gov/pubs/sp/800/218/final                                                                                                                               | Secure development practices integrated into the SDLC                                                  |
| B5-S18 | NIST, Technical Guide to Information Security Testing and Assessment         | SP 800-115 final 2008-09-30                         | https://csrc.nist.gov/pubs/sp/800/115/final                                                                                                                               | Planning tests, combining techniques, analyzing findings, limitations, and mitigation                  |
| B5-S19 | OWASP Foundation, Web Security Testing Guide v4.2                            | Version 4.2; accessed 2026-07-17                    | https://owasp.org/www-project-web-security-testing-guide/v42/                                                                                                             | Versioned web testing scenarios and lifecycle testing framework                                        |
| B5-S20 | OWASP API Security Top 10, API1:2023 Broken Object Level Authorization       | 2023 edition                                        | https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/                                                                                   | Object-level authorization and server-side permission checks                                           |
| B5-S21 | MITRE CWE, CWE-639 Authorization Bypass Through User-Controlled Key          | CWE 4.20 released 2026-04-30                        | https://cwe.mitre.org/data/definitions/639.html                                                                                                                           | Horizontal authorization failure through attacker-controlled object keys                               |
| B5-S22 | OWASP Cheat Sheet Series, Authorization Cheat Sheet                          | Living documentation; accessed 2026-07-17           | https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html                                                                                             | Deny by default, least privilege, and permission checks on every request                               |
| B5-S23 | OWASP WSTG, API Broken Object Level Authorization                            | Latest working draft; accessed 2026-07-17           | https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/12-API_Testing/02-API_Broken_Object_Level_Authorization                | Two-account BOLA test method and method coverage                                                       |
| B5-S24 | GitHub Docs, Push protection                                                 | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/code-security/concepts/secret-security/push-protection                                                                                         | Push-time blocking, bypasses, alerts, and supported paths                                              |
| B5-S25 | GitHub Docs, Removing sensitive data from a repository                       | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository                                                  | Rotate first, then weigh coordinated history rewriting and its limitations                             |
| B5-S26 | GitHub Docs, Secret scanning detection scope                                 | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/code-security/reference/secret-security/secret-scanning-scope                                                                                  | Pattern, pair, and scan-timeout coverage limits                                                        |
| B5-S27 | Gitleaks official repository, README                                         | Living project documentation; accessed 2026-07-17   | https://github.com/gitleaks/gitleaks                                                                                                                                      | Local, pre-commit, CI, history, and custom-rule scanning                                               |
| B5-S28 | OWASP Cheat Sheet Series, Secrets Management Cheat Sheet                     | Living documentation; accessed 2026-07-17           | https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html                                                                                        | Secret lifecycle, least privilege, rotation, revocation, audit, and detection                          |
| B5-S29 | Git project, `git-hook` documentation                                        | Living documentation; accessed 2026-07-17           | https://git-scm.com/docs/git-hook                                                                                                                                         | Local hook events and shared hook configuration                                                        |
| B5-S30 | OSV-Scanner, Supported Artifacts and Manifests                               | OSV-Scanner v2 documentation; accessed 2026-07-17   | https://google.github.io/osv-scanner/supported-languages-and-lockfiles/                                                                                                   | Supported source lockfiles, image artifacts, transitive coverage, and limitations                      |
| B5-S31 | OSV-Scanner, Usage                                                           | OSV-Scanner v2 documentation; accessed 2026-07-17   | https://google.github.io/osv-scanner/usage/                                                                                                                               | Source, lockfile, image, pre-commit, output, and offline scanning commands                             |
| B5-S32 | OSV, API                                                                     | API 1.0 documentation; accessed 2026-07-17          | https://google.github.io/osv.dev/api/                                                                                                                                     | Version, package, commit, and batch queries                                                            |
| B5-S33 | OpenSSF, Open Source Vulnerability schema                                    | Schema version 1.2.0 shown; accessed 2026-07-17     | https://ossf.github.io/osv-schema/                                                                                                                                        | Affected packages, ranges, versions, fixed events, and aliases                                         |
| B5-S34 | OSV-Scanner, Configuration                                                   | OSV-Scanner v2 documentation; accessed 2026-07-17   | https://google.github.io/osv-scanner/configuration/                                                                                                                       | Ignore records with reason and expiry                                                                  |
| B5-S35 | OWASP DevSecOps Guideline, Dynamic Application Security Testing              | Guideline v0.2; accessed 2026-07-17                 | https://owasp.org/www-project-devsecops-guideline/latest/02b-Dynamic-Application-Security-Testing                                                                         | DAST against a running application and black-box coverage                                              |
| B5-S36 | OWASP Developer Guide, Secure development and integration                    | Living documentation; accessed 2026-07-17           | https://devguide.owasp.org/en/02-foundations/02-secure-development/                                                                                                       | SAST, DAST, IAST, SCA, and SDLC integration                                                            |
| B5-S37 | NIST CSRC Glossary, static code analyzer                                     | Living glossary; accessed 2026-07-17                | https://csrc.nist.gov/glossary/term/static_code_analyzer                                                                                                                  | Static analysis without executing code                                                                 |
| B5-S38 | GitHub Docs, Application card for GitHub Copilot Agents                      | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/enterprise-cloud@latest/copilot/responsible-use/agents                                                                                         | Missed issues, false positives, insecure suggestions, and required human validation                    |
| B5-S39 | OWASP Cheat Sheet Series, Secure Code Review                                 | Living documentation; accessed 2026-07-17           | https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html                                                                                        | Manual review, diff review, data flow, business logic, and automation limits                           |
| B5-S40 | GitHub Docs, Best practices for using GitHub Copilot                         | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/copilot/get-started/best-practices                                                                                                             | Understand, review, test, and scan generated code                                                      |
| B5-S41 | OWASP Threat Modeling Project                                                | Maintained project guidance; accessed 2026-07-17    | https://owasp.org/www-project-threat-modeling/                                                                                                                            | Methodology-neutral four-question framework and model choice                                           |
| B5-S42 | OWASP Cheat Sheet Series, Threat Modeling Cheat Sheet                        | Living documentation; accessed 2026-07-17           | https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html                                                                                           | System modeling, threats, mitigations, validation, and lifecycle updates                               |
| B5-S43 | OWASP WSTG v4.2, Reporting                                                   | Version 4.2; accessed 2026-07-17                    | https://owasp.org/www-project-web-security-testing-guide/v42/5-Reporting/README                                                                                           | Scope, limitations, executive summary, findings, remediation, retest, and report protection            |
| B5-S44 | OWASP WSTG v4.2, Introduction                                                | Version 4.2; accessed 2026-07-17                    | https://owasp.org/www-project-web-security-testing-guide/v42/2-Introduction/README                                                                                        | Versioned scenario references, reporting fields, and balanced testing                                  |
| B5-S45 | FIRST, CVSS v4.0 Frequently Asked Questions                                  | CVSS 4.0; accessed 2026-07-17                       | https://www.first.org/cvss/faq                                                                                                                                            | Base score measures severity and does not alone establish organizational risk                          |
| B5-S46 | MITRE CWE, Frequently Asked Questions                                        | CWE 4.20 context; accessed 2026-07-17               | https://cwe.mitre.org/about/faq.html                                                                                                                                      | Weakness versus product-specific vulnerability and CWE's role                                          |
| B5-S47 | OWASP Cheat Sheet Series, Vulnerability Disclosure                           | Living documentation; accessed 2026-07-17           | https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html                                                                                  | Reproduction detail, evidence, redaction, impact, and clear reporting                                  |
| B5-S48 | OASIS, Static Analysis Results Interchange Format Version 2.1.0              | OASIS Standard approved 2020-03-27                  | https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html                                                                                                    | Normative SARIF object model and semantics                                                             |
| B5-S49 | GitHub Docs, SARIF support for code scanning                                 | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support                                                                                | Supported SARIF subset, locations, fingerprints, deduplication, and PR display                         |
| B5-S50 | GitHub Docs, About SARIF files for code scanning                             | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/code-security/concepts/code-scanning/sarif-files                                                                                               | SARIF purpose, version requirement, and upload paths                                                   |
| B5-S51 | GitHub Docs, Uploading a SARIF file to GitHub                                | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file                                        | Upload methods, categories, and configuration boundaries                                               |
| B5-S52 | GitHub Docs, Available rules for rulesets                                    | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets                                 | Required status checks, code-scanning results, bypass, and branch policy                               |
| B5-S53 | GitHub Docs, Troubleshooting required status checks                          | Living documentation; accessed 2026-07-17           | https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks | Latest-SHA requirement, skipped workflows, job dependencies, and pending checks                        |
| B5-S54 | NIST, Digital Evidence Preservation: Considerations for Evidence Handlers    | NISTIR 8387 published 2022-09-08                    | https://www.nist.gov/publications/digital-evidence-preservation-considerations-evidence-handlers                                                                          | Evidence preservation and integrity considerations                                                     |
| B5-S55 | OWASP Autonomous Penetration Testing Standard, Reporting                     | Living project standard; accessed 2026-07-17        | https://owasp.org/APTS/standard/8_Reporting/                                                                                                                              | Evidence provenance, coverage disclosure, finding states, limitations, and human review                |

## LyraShield repository truth

| ID     | Verified implementation fact                                                                                                                                                                                                                                                                                          | Repository source reviewed 2026-07-17                                                                                                 | Public wording boundary                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| B5-P01 | The passive Lite Check and five browser-local tools are the currently public marketing capabilities. The full release-assurance loop is described as in active development.                                                                                                                                           | `apps/marketing/src/pages/index.astro`, `apps/marketing/src/pages/scan.astro`, `apps/marketing/src/lib/tools.ts`                      | Never imply that the authenticated full product, MCP integration, launch gate, full scan, or report creation is generally available in production.   |
| B5-P02 | The repository contains a GitHub Actions diff gate that verifies immutable base and head commits, checks changed files, runs secret and dependency checks, generates SARIF 2.1.0, optionally uploads SARIF, and makes a separate severity decision. Its `DEEP` workflow input currently has SAFE-equivalent coverage. | `.github/workflows/lyrashield-scan.yml`                                                                                               | Describe repository code, not a hosted public service. Do not claim deeper behavior for the current `DEEP` workflow input.                           |
| B5-P03 | The MCP package exposes scan target and create report as mutating tools, findings and launch readiness as read-only tools, applies a prompt-injection guard, and blocks mutations when no approval gate is configured unless an explicit trusted opt-out is set.                                                      | `packages/mcp/src/tools.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/server-approval.test.ts`                                 | Say implemented in code and fail-closed by default. Do not claim public production availability or universal MCP security.                           |
| B5-P04 | Launch readiness returns `NOT_EVALUATED`, `GO`, `GO_WITH_CONDITIONS`, or `NO_GO`. It returns `NOT_EVALUATED` and a null score when no completed scan exists. The current thresholds are LyraShield product logic, not an industry standard.                                                                           | `apps/web/src/lib/launch-readiness.ts`, `apps/web/src/lib/launch-readiness.test.ts`                                                   | Never present the score or verdict as a warranty, compliance result, or universal release policy.                                                    |
| B5-P05 | A queued retest that redetects the finding fails. Absence validates a finding only when the originating scanner is deterministic and its applicable coverage completed. Engine-only or incomplete absence remains inconclusive. A validated retest does not set independent verification.                             | `apps/worker/src/engine/result-integrity.ts`, `apps/worker/src/engine/result-integrity.test.ts`, `packages/db/src/finding-service.ts` | Keep detected, independently verified, retest-confirmed, and inconclusive separate. Never turn confidence or scanner absence into independent proof. |
| B5-P06 | New reports freeze creation-time snapshots and include findings, retest summary, methodology, and limitations. The public sample report is a sanitized mock labeled in active development and not a real assessment.                                                                                                  | `packages/db/src/report-generator.ts`, `packages/db/src/report-generator.test.ts`, `apps/marketing/src/pages/sample-report.astro`     | Link the sample as illustrative only. Do not claim customers, production assessments, benchmarks, or a complete engagement.                          |

## Topic 69 claim map

| Claim                                                                                                                              | Evidence | Drafting note                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| Pinning a third-party action to a full-length commit SHA is GitHub's immutable-reference recommendation.                           | B5-S01   | Say this reduces reference-mutation risk, not all action or maintainer risk.            |
| A workflow should give `GITHUB_TOKEN` only the permissions each job needs.                                                         | B5-S02   | Show explicit job-level `permissions`; do not rely on repository defaults.              |
| Privileged triggers combined with checkout or execution of untrusted pull-request content can compromise a repository.             | B5-S01   | The unsafe example must be inert and clearly labeled.                                   |
| OIDC trust must restrict claims so an untrusted repository or workflow cannot obtain cloud credentials.                            | B5-S03   | OIDC removes a stored long-lived cloud secret but does not remove authorization design. |
| CI/CD systems are high-impact targets because pipeline identities, flow controls, dependencies, artifacts, and logs can be abused. | B5-S04   | Use as architecture context, not a prevalence statistic.                                |
| LyraShield's current diff-gate code scans exact SHAs but its `DEEP` input is not deeper than SAFE.                                 | B5-P02   | This limitation must survive editorial review.                                          |

Source count: 5 external official sources, plus first-party repository truth.

## Topic 70 claim map

| Claim                                                                                                                                                      | Evidence       | Drafting note                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| HTTP MCP authorization uses protected-resource metadata, OAuth authorization-server metadata, audience-bound tokens, and token validation on each request. | B5-S06         | Use the versioned 2025-11-25 specification.                |
| An MCP server must not accept a client token for the wrong audience or pass that token through to a downstream API.                                        | B5-S05, B5-S06 | Explain the distinct downstream OAuth client role.         |
| Per-client consent, state validation, short expiration, and session-to-user binding mitigate confused-deputy and session-hijacking paths.                  | B5-S05         | Do not imply cookies alone authenticate MCP requests.      |
| Remote servers need authenticated HTTPS; local stdio narrows reach but the process still inherits client privileges and should be sandboxed.               | B5-S05, B5-S07 | Separate transport exposure from tool authorization.       |
| Hosts should treat tool descriptions and outputs as untrusted and obtain consent for consequential operations.                                             | B5-S08         | Protocol guidance does not make an arbitrary tool safe.    |
| LyraShield's MCP mutations are approval-gated in code and fail closed without a gate.                                                                      | B5-P03         | State that general production availability is not claimed. |

Source count: 4 official MCP sources, plus first-party repository truth.

## Topic 71 claim map

| Claim                                                                                                                                         | Evidence       | Drafting note                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| Stripe webhook signatures verify origin and integrity only when checked using the endpoint secret and the expected raw payload.               | B5-S09         | Signature verification does not authorize the business transition by itself. |
| Stripe can retry events and does not guarantee delivery order.                                                                                | B5-S09, B5-S14 | Handlers must deduplicate and fetch authoritative objects when necessary.    |
| Idempotency keys allow retried Stripe writes to return the first operation result under the documented parameter rules.                       | B5-S10         | Application fulfillment must also be idempotent.                             |
| Server-side fulfillment should react to payment state, not trust a browser success redirect.                                                  | B5-S12         | The redirect may be a convenience trigger, not the only source of truth.     |
| Secret keys stay server-side; restricted keys and IP limits can reduce credential blast radius. Publishable keys are designed for client use. | B5-S11         | Never tell readers to hide a secret key through obfuscation.                 |
| Stripe entitlements can notify a server when feature access changes, but the application still owns correct authorization and persistence.    | B5-S13         | Do not require Stripe Entitlements for every SaaS architecture.              |

Source count: 6 official Stripe sources.

## Topic 72 claim map

| Claim                                                                                                                                                  | Evidence | Drafting note                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------- |
| A pre-launch review needs explicit, testable control requirements rather than an awareness list alone.                                                 | B5-S15   | Version ASVS requirement IDs if any are quoted.                           |
| Broad verification combines threat modeling, automated tests, static analysis, secret checks, black-box tests, web scanning, and included-code review. | B5-S16   | NISTIR 8397 says this is a minimum set, not the totality of verification. |
| Secure development practices belong inside the existing SDLC and include preparation, protection, production, and vulnerability response.              | B5-S17   | Use to organize ownership and lifecycle checks.                           |
| No individual assessment technique gives a comprehensive picture; objectives, risk, and constraints should determine the mix.                          | B5-S18   | This is the basis for retaining coverage limitations.                     |
| WSTG scenarios cover configuration, identity, authentication, authorization, session, and input testing but must be selected for the target.           | B5-S19   | Do not imply every WSTG scenario applies to every app.                    |
| LyraShield's free checklist documents controls but does not inspect code or prove implementation.                                                      | B5-P01   | Repeat the tool's actual limitation near the CTA.                         |

Source count: 5 authoritative sources, all official or standards-body publications, plus first-party product truth.

## Topic 73 claim map

| Claim                                                                                                            | Evidence       | Drafting note                                               |
| ---------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------- |
| BOLA occurs when a server accepts an object identifier without checking the caller's permission for that object. | B5-S20, B5-S21 | Distinguish object-level from function-level authorization. |
| Authorization should deny by default and validate permission on every request.                                   | B5-S22         | Client controls and unguessable IDs are not sufficient.     |
| A safe two-account test creates an object for account A and tries the same object operation as account B.        | B5-S23         | Cover read and mutation methods without bulk enumeration.   |
| UUIDs can reduce guessing but do not replace object authorization.                                               | B5-S20, B5-S21 | State as defense-in-depth only.                             |
| The test must use owned accounts and synthetic data in an authorized environment.                                | B5-S18         | This is the safe testing boundary.                          |

Source count: 5 official or authoritative sources.

## Topic 74 claim map

| Claim                                                                                                                         | Evidence       | Drafting note                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| GitHub push protection can block supported secrets before they reach a protected repository and can record governed bypasses. | B5-S24         | Availability and coverage depend on settings and token types.      |
| Pattern pairing, file scope, and timeouts can limit secret detection.                                                         | B5-S26         | A clear scan is not proof that no secret exists.                   |
| Gitleaks supports local, pre-commit, and CI use plus custom configuration.                                                    | B5-S27         | Pin the tool or hook revision used in the example.                 |
| Local hooks provide fast feedback but shared enforcement must also run remotely because local hooks can be skipped or absent. | B5-S29, B5-S04 | Editorial synthesis; label it as a layered-control recommendation. |
| A real exposed credential should be rotated or revoked before optional history cleanup.                                       | B5-S25, B5-S28 | Do not lead with deleting the line or rewriting Git history.       |
| LyraShield's free secret tool scans only selected local text files and not repository history.                                | B5-P01         | State the scope beside the link.                                   |

Source count: 6 official or first-party project sources, plus first-party product truth.

## Topic 75 claim map

| Claim                                                                                                                                           | Evidence       | Drafting note                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| OSV Scanner v2 extracts packages from supported source lockfiles, manifests, images, and artifacts, then matches them to known vulnerabilities. | B5-S30, B5-S31 | Use v2 commands and list only currently supported formats.      |
| OSV can query by package and version or commit, including batch requests.                                                                       | B5-S32         | API matches still need application context.                     |
| OSV affected ranges distinguish introduced, fixed, last-affected, and limit events by ecosystem semantics.                                      | B5-S33         | Do not treat every version string as SemVer.                    |
| Scanner ignores should include a reason and can include an expiry.                                                                              | B5-S34         | An ignore is a risk decision, not deletion of the advisory.     |
| A matched advisory detects an affected dependency version; it does not alone prove that the application reaches the vulnerable code path.       | B5-S30, B5-S33 | Explicit editorial inference from the data the sources provide. |
| LyraShield's repository includes SCA as one scan layer, not a public guarantee of complete dependency coverage.                                 | B5-P01         | Keep public availability precise.                               |

Source count: 5 official OpenSSF or OSV project sources, plus first-party product truth.

## Topic 76 claim map

| Claim                                                                                                      | Evidence       | Drafting note                                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| Static analysis examines source or compiled code without running it.                                       | B5-S37         | Do not say SAST is only regex matching.                       |
| DAST exercises a running application externally and can surface runtime behavior and configuration issues. | B5-S35         | Authentication and workflow coverage depend on scanner setup. |
| SCA identifies third-party components and known vulnerability records, often from lockfiles or artifacts.  | B5-S30, B5-S33 | SCA does not inspect first-party business logic.              |
| Secure pipelines can combine SAST, DAST, SCA, and other methods at different lifecycle points.             | B5-S36, B5-S19 | Do not prescribe one universal schedule.                      |
| NIST recommends a broader verification set because no single technique is complete.                        | B5-S16, B5-S18 | Use to explain the layered recommendation.                    |
| LyraShield publicly describes SCA, secret, URL, and repository review as layers inside a wider method.     | B5-P01         | Avoid positioning against unnamed competitors or point tools. |

Source count: 7 authoritative sources, including NIST, OWASP, and OpenSSF, plus first-party product truth.

## Topic 77 claim map

| Claim                                                                                                                        | Evidence       | Drafting note                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| AI code review can miss issues, produce false positives, and suggest insecure or incorrect changes.                          | B5-S38         | This is GitHub's stated limitation, not a measured rate.           |
| Generated output should be understood, reviewed, tested, and checked with automated tools.                                   | B5-S40         | Do not imply GitHub's advice validates another vendor's model.     |
| Manual secure review adds context for data flow, business logic, trust boundaries, and complex controls that tools may miss. | B5-S39         | Manual review also has coverage limits.                            |
| A useful review output should separate candidate claims, locations, evidence, safe verification, and unknowns.               | B5-S39, B5-S16 | Editorial synthesis grounded in review and verification practices. |
| A prompt is an aid to candidate generation, not independent evidence.                                                        | B5-S38, B5-S18 | State explicitly in the direct answer and conclusion.              |
| LyraShield does not set verified state from confidence alone.                                                                | B5-P05         | Keep product-specific language scoped.                             |

Source count: 5 authoritative sources, including two official GitHub sources, OWASP, and NIST, plus first-party product truth.

## Topic 78 claim map

| Claim                                                                                                                                 | Evidence | Drafting note                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| OWASP's maintained project uses four questions: what are we working on, what can go wrong, what will we do, and did we do a good job. | B5-S41   | Do not call STRIDE the single OWASP method.       |
| Threat modeling is methodology-neutral and should fit the system, team, and decision context.                                         | B5-S41   | Present STRIDE only as an optional prompt.        |
| A practical model covers the system, threats, mitigations, review, and validation, and should evolve with the product.                | B5-S42   | Include explicit update triggers.                 |
| NIST's minimum verification guidance includes threat modeling for design-level issues.                                                | B5-S16   | Threat modeling complements implementation tests. |
| Secure development integrates these practices into the SDLC rather than treating them as a one-time document.                         | B5-S17   | Avoid a static compliance-artifact tone.          |

Source count: 4 official OWASP and NIST sources.

## Topic 79 claim map

| Claim                                                                                                                                                         | Evidence       | Drafting note                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| Reports and assessment records should include remediation and enough detail to reproduce or re-evaluate a finding.                                            | B5-S43, B5-S44 | Use as the basis for preserving original conditions.            |
| Testing programs should analyze findings and choose methods based on objectives, benefits, and limitations.                                                   | B5-S18         | Retest with the method that can observe the original condition. |
| A retest must run against the changed target and record coverage, result, and limitations.                                                                    | B5-S18, B5-S43 | Editorial synthesis from assessment and reporting guidance.     |
| Absence in an incomplete check does not establish remediation.                                                                                                | B5-S18         | State as an evidence-quality principle.                         |
| LyraShield validates a clean deterministic retest only with complete applicable originating coverage; incomplete or engine-only absence remains inconclusive. | B5-P05         | This is first-party behavior, not a universal industry label.   |

Source count: 3 authoritative external sources, including NIST and two versioned OWASP pages, plus first-party product truth.

## Topic 80 claim map

| Claim                                                                                                                              | Evidence       | Drafting note                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| A finding should state the target, type, root cause, test method, remediation, and severity with enough evidence to understand it. | B5-S43, B5-S44 | Evidence should support the claim and be redacted where necessary.           |
| Reproduction details and supporting evidence should allow a recipient to understand and validate a vulnerability report.           | B5-S47         | Do not require harmful exploitation.                                         |
| CWE describes weakness classes, while a vulnerability is a specific exploitable instance in a product.                             | B5-S46         | Use to stop broad weakness labels becoming proof of a product vulnerability. |
| CVSS base score measures technical severity and should not alone determine environmental risk or proof.                            | B5-S45         | Keep severity, confidence, exploitability, and risk separate.                |
| Independent validation should use evidence or a method not identical to the original assertion.                                    | B5-S18, B5-S47 | Editorial synthesis. A second model restatement is not independent evidence. |
| LyraShield keeps confidence as triage metadata and requires a separate verification receipt for independently verified state.      | B5-P05         | Exact product terminology only.                                              |

Source count: 6 authoritative sources, including NIST, OWASP, FIRST, and MITRE, plus first-party product truth.

## Topic 81 claim map

| Claim                                                                                                                                               | Evidence       | Drafting note                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| SARIF 2.1.0 is a standardized JSON object model for static analysis results.                                                                        | B5-S48         | Do not imply every consumer supports every property.                                 |
| GitHub code scanning supports a subset of SARIF 2.1.0 and uses rule, location, and result data to display alerts.                                   | B5-S49, B5-S50 | Use repository-relative paths.                                                       |
| Missing stable fingerprints can cause duplicate alerts across uploads.                                                                              | B5-S49         | Show a stable identity strategy without inventing a universal fingerprint algorithm. |
| Pull-request display is limited to results whose reported lines are in the diff.                                                                    | B5-S49         | A missing PR annotation does not mean no baseline alert exists.                      |
| SARIF uploads can use separate categories for analyses and must be validated and protected from sensitive output.                                   | B5-S51, B5-S48 | Redaction is an application responsibility.                                          |
| LyraShield's repository workflow emits a SARIF 2.1.0 artifact and treats Code Scanning upload as optional while the diff decision remains separate. | B5-P02         | Do not claim the upload itself is the gate.                                          |

Source count: 4 official OASIS and GitHub sources, plus first-party repository truth.

## Topic 82 claim map

| Claim                                                                                                                                                                            | Evidence       | Drafting note                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------- |
| Required checks must pass against the latest commit SHA used for the merge decision.                                                                                             | B5-S53         | Explain head and test-merge distinctions carefully.                        |
| Skipped workflows and skipped jobs can produce different required-check behavior.                                                                                                | B5-S53         | The final decision job should always report the intended policy.           |
| Rulesets can require status checks or code-scanning results and can define bypass actors.                                                                                        | B5-S52         | Availability depends on repository and plan features.                      |
| Code-scanning merge protection can block on configured findings, analysis in progress, or missing required tools, but PR display is diff-bound.                                  | B5-S49, B5-S52 | Do not imply it handles baseline backlog automatically.                    |
| The workflow that enforces the gate must itself follow least-privilege and untrusted-input guidance.                                                                             | B5-S01, B5-S04 | Cross-link topic 69.                                                       |
| LyraShield's repository implementation resolves exact commits, reports findings separately, fails required scanner infrastructure errors, and then applies a threshold decision. | B5-P02         | Mention the current SAFE-equivalent `DEEP` limitation if discussing modes. |

Source count: 5 official GitHub and OWASP sources, plus first-party repository truth.

## Topic 83 claim map

| Claim                                                                                                                                         | Evidence       | Drafting note                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| A release decision needs an explicit control and verification basis, not a generic checklist label.                                           | B5-S15, B5-S16 | Use target-specific evidence.                                      |
| Secure development and vulnerability response are lifecycle activities with named practices and owners.                                       | B5-S17         | Conditions need owners and due dates.                              |
| No single test supplies a complete security picture; incomplete assessment scope must remain visible.                                         | B5-S18, B5-S19 | Missing required evidence should produce not evaluated or a block. |
| CVSS severity is one technical input and should not alone decide business risk or release.                                                    | B5-S45         | Do not invent a universal severity threshold.                      |
| A release gate should retain scope, findings, conditions, limitations, and mitigation decisions in a reviewable record.                       | B5-S43         | Editorial synthesis from reporting and assessment guidance.        |
| LyraShield's current code returns NOT_EVALUATED without a completed scan and otherwise applies product-specific thresholds for four verdicts. | B5-P04         | Do not export those thresholds as industry guidance.               |

Source count: 6 authoritative sources, including NIST, OWASP, and FIRST, plus first-party product truth.

## Topic 84 claim map

| Claim                                                                                                                                             | Evidence | Drafting note                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| A useful security report records scope, limitations, timeline, executive context, findings, remediation, and retest status.                       | B5-S43   | Tailor detail to executive and technical readers.                                    |
| Findings should include type, threat, root cause, test technique, countermeasure, and severity.                                                   | B5-S44   | Mask credentials, personal data, and unnecessary exploit detail.                     |
| Reproduction and evidence should be sufficient for the recipient to understand and act, while sensitive data is redacted.                         | B5-S47   | Safe evidence can be request and response fragments, screenshots, or code locations. |
| Evidence preservation requires integrity, provenance, and handling decisions appropriate to the evidence.                                         | B5-S54   | Do not overstate formal chain-of-custody when the engagement lacks it.               |
| Current autonomous-testing guidance emphasizes evidence-backed findings, coverage disclosure, limitations, and human review.                      | B5-S55   | Treat this as current OWASP project guidance, not a claim of LyraShield conformance. |
| LyraShield's sample report is a sanitized mock, while repository reports freeze creation-time data and retain retest and methodology information. | B5-P06   | No customer or production assessment claims.                                         |

Source count: 5 authoritative external sources, including NIST and OWASP, plus first-party product truth.

## Cross-topic factual boundaries

1. A scanner result is a detected candidate until evidence supports a stronger state.
2. Model confidence, scanner confidence, severity, exploitability, and application-specific risk are different facts.
3. A fresh deterministic retest with complete applicable coverage can confirm that the original condition is absent. It is not independent verification of the original finding.
4. A report records scope, evidence, decisions, and limitations. It is not a security guarantee.
5. SARIF transports and normalizes results. It does not validate their truth.
6. SAST, DAST, SCA, secret scanning, manual review, and threat modeling have overlapping but non-identical coverage.
7. GitHub Actions, MCP, and Stripe integrations must be tested with platform-specific documentation current at publication time.
8. A local hook improves feedback but cannot be the only shared enforcement point.
9. Two-account authorization tests use owned accounts and synthetic data. They never authorize probing another user's production data.
10. LyraShield's authenticated app, MCP surface, launch gate, full scan, retest, and report pipeline are implemented in code but are not represented as a generally available public production service.

## Claims rejected or narrowed

- Reject claims that coding agents make GitHub Actions unsafe by default. The article addresses concrete privilege and untrusted-input configurations.
- Reject claims that OAuth makes an MCP server secure. It supplies transport authorization primitives; the server still needs object, resource, and tool authorization.
- Reject claims that a signed Stripe webhook is automatically a valid entitlement transition.
- Reject claims that one pre-launch checklist or clean scan proves security.
- Reject claims that UUID object identifiers prevent IDOR.
- Reject claims that deleting a committed secret neutralizes it.
- Reject claims that an OSV match proves reachable exploitability, or that no OSV match proves a dependency is safe.
- Reject universal SAST, DAST, or SCA superiority claims and unsourced detection-rate comparisons.
- Reject claims that an AI review prompt or generated test supplies independent verification.
- Reject claims that threat modeling is a one-time diagram or that OWASP mandates one methodology.
- Reject claims that a code change is fixed before a fresh, adequately covered retest.
- Reject claims that a finding is verified because two AI systems agree.
- Reject claims that SARIF is an alert-verification format.
- Reject claims that a diff gate replaces baseline or release testing.
- Reject claims that a score automatically decides launch readiness.
- Reject claims that a client report is a warranty, certificate, compliance attestation, or complete penetration test without the matching engagement contract and evidence.
- Reject public claims of automatic LyraShield fix-PR execution, complete Vibe Security 50 detection, customers, pricing, benchmarks, or general availability of the authenticated full product.

## Pre-draft and pre-publication checks

- [ ] Re-open every source URL and record any version or material change.
- [ ] Confirm MCP's current protocol version and preserve a versioned authorization citation.
- [ ] Confirm GitHub plan and repository-feature qualifiers before describing rulesets, push protection, or code scanning.
- [ ] Confirm Stripe's current webhook retry, ordering, API-version, and entitlement documentation.
- [ ] Confirm OSV Scanner commands remain v2 syntax and supported lockfiles match the examples.
- [ ] Confirm ASVS 5.0.0 remains the latest stable version and use version-qualified requirement IDs.
- [ ] Recheck `.github/workflows/lyrashield-scan.yml`, `packages/mcp`, result-integrity, launch-readiness, and report code before making first-party claims.
- [ ] Verify every same-batch related link exists in the release candidate.
- [ ] Check code examples for inert values, safe local targets, no realistic credentials, and no deployable exploit against a named system.
- [ ] Complete the Humanizer audit after each article draft and preserve factual qualifiers while removing repetitive or synthetic prose patterns.
- [ ] Record source verification, technical review, product-claim review, and individual publication approval before changing draft state.
