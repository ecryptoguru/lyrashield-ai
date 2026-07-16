# Batch 2 blog briefs

Date: 2026-07-17
Release: topics 19 to 35
Status: research complete, drafting not started

These briefs use the exact program queries and target lengths in `apps/marketing/src/content/blog-program.json`. The authority link for every article is `https://lyrashieldai.com/blog/vibe-coding-security-guide` and must appear contextually in the first third. Tool CTAs describe only the current browser-local tool or passive Lite Check. They do not imply that a free tool proves the application is secure.

## 19. Prevent Path Traversal in Generated File Code

- Slug: `path-traversal-generated-code`
- Primary query: `path traversal prevention - fix`
- Target length: 1,300 words
- Reader problem: A developer joins an upload, archive, export, or download filename to a trusted directory and needs to know whether the final filesystem path can escape that directory.
- Unique angle: Make canonical containment the central test. Cover absolute paths, both path separators, encoded input, symlinks, archive entries, and platform differences rather than presenting a `../` denylist as a fix.
- Required entities: CWE-22, canonical path, `path.resolve`, `path.relative`, basename, real path, symlink, archive extraction, allowlisted identifier.
- Cannibalization check: This article owns filesystem path containment. It may link to `secure-file-uploads-ai-apps`, but that article owns file type, size, storage, and serving controls. It must not drift into command execution, which belongs to topic 20.
- Required sources: MITRE CWE-22, OWASP Path Traversal, Node.js `path` documentation. Research file contains exact URLs and claim mapping.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, framed as a browser-local review prompt that cannot exercise server filesystem behavior.
- Related dependency: `https://lyrashieldai.com/blog/secure-file-uploads-ai-apps`
- FAQ decision: Yes. Answer whether basename is sufficient, whether `path.normalize` is sufficient, and how symlinks change the check.
- Image cluster concept: Web and execution. A graphite file corridor whose resolved path remains inside a translucent root boundary while alternate routes terminate at the boundary.

## 20. Command Injection in Agentic App Workflows

- Slug: `command-injection-agentic-apps`
- Primary query: `command injection prevention - fix`
- Target length: 1,400 words
- Reader problem: A builder passes user or model output into a shell, package script, build step, or subprocess and needs a safer execution boundary.
- Unique angle: Start with removing the shell. Compare direct library calls, executable plus argument arrays, shell parsing, argument injection, environment control, working directories, timeouts, output limits, and least-privilege isolation.
- Required entities: CWE-78, OS command injection, argument injection, shell metacharacters, `execFile`, `spawn`, allowlist, environment, working directory, sandbox, timeout.
- Cannibalization check: This article owns process construction and shell boundaries. Topic 19 owns filesystem path containment. Later agent-permission articles own whether an agent may invoke a tool at all, not how an allowed process call is constructed.
- Required sources: OWASP OS Command Injection Defense, MITRE CWE-78, Node.js `child_process` documentation.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, explicitly a planning checklist rather than a command-injection scanner.
- Related dependency: `https://lyrashieldai.com/blog/input-validation-ai-generated-api`
- FAQ decision: Yes. Answer whether escaping is enough, whether argument arrays remove every risk, and when a sandbox is still required.
- Image cluster concept: Agent security. A constrained tool path enters a sealed execution chamber through an approval gate, with shell-like side paths blocked.

## 21. Secure OAuth Redirects and Callbacks

- Slug: `oauth-redirect-callback-security`
- Primary query: `oauth redirect uri security - how-to`
- Target length: 1,350 words
- Reader problem: A developer has a social login callback that works locally but is unsure how to validate redirect URIs, transaction state, authorization codes, issuer identity, and PKCE in production.
- Unique angle: Treat redirect registration, callback transaction binding, and code exchange as three separate checks. Use RFC 9700 current guidance, including exact redirect URI matching and no open redirectors.
- Required entities: OAuth 2.0, RFC 9700, redirect URI, authorization code, `state`, nonce, PKCE, issuer, mix-up attack, open redirector, callback session.
- Cannibalization check: This article owns OAuth redirect and callback transaction integrity. `jwt-validation-mistakes` owns downstream token signature, issuer, audience, and expiry validation. `csrf-cookie-auth-ai-apps` owns ordinary cookie-authenticated state changes.
- Required sources: RFC 9700, RFC 6749, RFC 8252. Research file contains the current normative boundaries.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, used to document callback allowlists and production-only settings.
- Related dependency: `https://lyrashieldai.com/blog/jwt-validation-mistakes`
- FAQ decision: Yes. Answer exact matching versus wildcards, whether `state` replaces PKCE, and how localhost callbacks differ for native apps.
- Image cluster concept: Access control. One registered redirect corridor returns through a bound callback gate while wildcard branches fade outside the permitted boundary.

## 22. Rate Limiting for AI Apps

- Slug: `rate-limiting-ai-apps`
- Primary query: `ai api rate limiting - how-to`
- Target length: 1,400 words
- Reader problem: A developer needs endpoint-specific limits for login, generation, upload, webhook, and expensive AI work without blocking normal users or trusting a spoofable identifier.
- Unique angle: Design limits from resource and abuse budgets. Separate concurrency, request rate, payload size, token or cost budgets, queue depth, and provider quotas, then define a trustworthy key and failure behavior for each endpoint.
- Required entities: OWASP API4:2023, HTTP 429, `Retry-After`, token bucket, concurrency, queue depth, cost budget, authenticated principal, trusted proxy, fail closed, distributed counter.
- Cannibalization check: This article owns general resource consumption and endpoint budgets. Topic 23 owns password guessing, account enumeration, login response consistency, MFA, and lockout tradeoffs. It should mention authentication only as one rate-limit profile.
- Required sources: OWASP API4:2023, RFC 6585, Cloudflare rate-limiting best practices.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, prompting the reader to document limits without claiming runtime verification.
- Related dependency: `https://lyrashieldai.com/blog/brute-force-account-enumeration`
- FAQ decision: Yes. Answer IP-only limits, 429 versus 503, and fail-open versus fail-closed behavior when the limiter is unavailable.
- Image cluster concept: Web and execution. Multiple request streams pass through endpoint-specific graphite apertures into a bounded compute reservoir.

## 23. Stop Brute Force and Account Enumeration

- Slug: `brute-force-account-enumeration`
- Primary query: `prevent account enumeration - fix`
- Target length: 1,300 words
- Reader problem: Login, signup, and recovery responses reveal whether an account exists while attackers can make repeated guesses or trigger denial of service through naive lockouts.
- Unique angle: Pair indistinguishable external responses with account-aware throttling, MFA, telemetry, and safe recovery. Include status, body, timing, reset flow, and support-channel discrepancies.
- Required entities: NIST SP 800-63B-4, CWE-204, generic authentication error, timing discrepancy, throttling, lockout, credential stuffing, password spraying, MFA, recovery.
- Cannibalization check: This article owns authentication guessing and enumeration. Topic 22 owns broad API and resource budgets. `password-reset-email-verification-security` owns token generation, expiry, storage, and one-time use, while this article covers enumeration through that flow.
- Required sources: NIST SP 800-63B-4, OWASP Authentication Cheat Sheet, MITRE CWE-204.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, framed as a checklist for owned test accounts and response paths.
- Related dependency: `https://lyrashieldai.com/blog/password-reset-email-verification-security`
- FAQ decision: Yes. Answer whether a generic message is enough, whether account lockout is safe, and how to test enumeration without targeting other people.
- Image cluster concept: Access control. Repeated signals reach a login gate that returns a uniform exterior state while internal counters remain compartmentalized.

## 24. Verify Stripe Webhook Signatures

- Slug: `stripe-webhook-signature-security`
- Primary query: `stripe webhook signature verification - how-to`
- Target length: 1,350 words
- Reader problem: A Stripe webhook endpoint parses JSON or trusts event fields before proving that Stripe signed the exact request body with the correct endpoint secret.
- Unique angle: Focus narrowly on authenticity. Preserve the raw body, select the right endpoint secret, use the official library, enforce timestamp tolerance, reject failures before side effects, and test with Stripe CLI secrets separately from Dashboard endpoint secrets.
- Required entities: Stripe webhook, `Stripe-Signature`, endpoint secret, raw request body, `constructEvent`, timestamp tolerance, Stripe CLI, HTTP 400.
- Cannibalization check: This article owns request authenticity only. Topic 25 owns server-side entitlement state after an authentic event. Topic 27 owns duplicate delivery, ordering, concurrency, and idempotent side effects. A valid signature proves origin and body integrity, not authorization to grant a feature.
- Required sources: Stripe Webhooks, Stripe signature troubleshooting, Stripe CLI webhook testing sections in the official Webhooks guide.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, used to record the raw-body and secret boundary.
- Related dependency: `https://lyrashieldai.com/blog/idempotency-replay-protection`
- FAQ decision: Yes. Answer why parsed JSON fails verification, whether the publishable key verifies webhooks, and whether a valid signature makes processing idempotent.
- Image cluster concept: Verification. A sealed payment event crosses a signature plane and produces a matched evidence receipt before reaching the application.

## 25. Keep Pricing and Entitlements Off the Client

- Slug: `payment-entitlement-server-source-truth`
- Primary query: `saas entitlement security - explainer`
- Target length: 1,400 words
- Reader problem: A SaaS UI stores plan, price, credits, or feature access in client state and the server accepts those values when granting access.
- Unique angle: Define a server-owned entitlement record that is derived from trusted provider state and internal policy. Explain stale state, revocation, reconciliation, customer and subscription mapping, cache invalidation, and authorization at the protected operation.
- Required entities: Stripe Entitlements, active entitlement, subscription, customer mapping, price identifier, server authorization, webhook, reconciliation, cache, revocation, CWE-602.
- Cannibalization check: This article owns the authorization decision and source of truth. Topic 24 proves webhook authenticity. Topic 27 makes updates repeatable under retries. It must not imply that a verified webhook alone grants the correct user access.
- Required sources: Stripe Entitlements, Stripe subscription webhook guidance, MITRE CWE-602.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, used to identify where paid operations recheck server-owned state.
- Related dependency: `https://lyrashieldai.com/blog/stripe-webhook-signature-security`
- FAQ decision: Yes. Answer whether JWT plan claims are sufficient, whether webhooks should update a local entitlement table, and how to handle delayed or missed events.
- Image cluster concept: Access control. A server-owned entitlement core controls feature compartments while a translucent client display remains outside the decision boundary.

## 26. Prevent Mass Assignment in CRUD APIs

- Slug: `mass-assignment-crud-api`
- Primary query: `mass assignment vulnerability - fix`
- Target length: 1,300 words
- Reader problem: A CRUD handler spreads or binds the entire request body into an ORM update, allowing extra fields to change role, owner, price, status, or approval state.
- Unique angle: Use operation-specific input schemas and explicit server-owned fields. Distinguish input validation from property-level authorization and from response overexposure.
- Required entities: OWASP API3:2023, CWE-915, mass assignment, allowlist, DTO, schema validation, ORM update, role, ownership, server-owned field.
- Cannibalization check: This article owns unauthorized writable properties. `input-validation-ai-generated-api` owns types, formats, size, and unknown-field rejection generally. `server-side-authorization-ai-apis` owns whether the caller may perform the operation. All three checks are required.
- Required sources: OWASP API3:2023, MITRE CWE-915, OWASP Mass Assignment Cheat Sheet.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, prompting review of server-owned fields.
- Related dependency: `https://lyrashieldai.com/blog/input-validation-ai-generated-api`
- FAQ decision: Yes. Answer whether stripping unknown keys is enough, whether TypeScript types validate runtime input, and how PATCH differs from PUT.
- Image cluster concept: Access control. A property allowlist lets ordinary fields through while role, price, owner, and status shapes remain behind separate gates, without text labels.

## 27. Idempotency and Replay Protection for SaaS

- Slug: `idempotency-replay-protection`
- Primary query: `webhook idempotency security - how-to`
- Target length: 1,400 words
- Reader problem: Duplicate deliveries, repeated clicks, retries, and concurrent workers can apply a charge, credit, reward, or entitlement change more than once.
- Unique angle: Bind an operation key to a canonical request, enforce uniqueness in durable storage, perform the state change atomically, return the stored result, and distinguish transport retries from malicious replay and out-of-order events.
- Required entities: idempotency key, Stripe event ID, unique constraint, transaction, atomicity, replay window, duplicate event, ordering, canonical request hash, stored response.
- Cannibalization check: This article owns repeatability and concurrency. Topic 24 owns Stripe signature validation. Topic 25 owns entitlement authorization. It must explain that signatures, idempotency, and server-owned business rules solve different problems.
- Required sources: Stripe idempotent requests, Stripe webhook duplicate-event guidance, RFC 9110 idempotent methods.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, used to inventory non-repeatable side effects.
- Related dependency: `https://lyrashieldai.com/blog/stripe-webhook-signature-security`
- FAQ decision: Yes. Answer key storage duration, whether GET semantics solve webhook duplicates, and how to prevent one key from being reused with different input.
- Image cluster concept: Verification. Duplicate evidence receipts converge on one atomic retest ring and leave as a single committed state.

## 28. Security Headers Every AI-Built App Needs

- Slug: `security-headers-ai-built-apps`
- Primary query: `security headers checker - tool-led`
- Target length: 1,300 words
- Reader problem: A developer sees missing-header warnings but needs to know which browser control applies to the app, how to roll it out, and what the header cannot fix.
- Unique angle: Build a minimum policy by behavior, not a copy-paste score. Prioritize CSP, HSTS, framing control, MIME sniffing, and referrer policy, with report-only rollout and route-specific verification.
- Required entities: Content-Security-Policy, CSP Report-Only, HSTS, `frame-ancestors`, `X-Content-Type-Options`, Referrer-Policy, nonce, security header.
- Cannibalization check: This article owns browser response policy. `cors-vibe-coded-apps` owns which origins may read API responses. `xss-ai-app-markdown-output` owns output handling and sanitization. Headers are defense in depth rather than substitutes.
- Required sources: OWASP Secure Headers Project, W3C CSP Level 3, RFC 6797.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/security-headers-checker`, accurately described as a browser-local pasted-header review.
- Related dependency: `https://lyrashieldai.com/blog/cors-vibe-coded-apps`
- FAQ decision: Yes. Answer CSP meta versus response header, HSTS rollout risk, and why a high header score is not security proof.
- Image cluster concept: Web and execution. Layered translucent response planes form a browser boundary around a matte application core.

## 29. Secure Session Cookies

- Slug: `secure-session-cookie-settings`
- Primary query: `secure cookie settings - how-to`
- Target length: 1,300 words
- Reader problem: A session cookie works but has unclear `Secure`, `HttpOnly`, `SameSite`, domain, path, expiry, prefix, and rotation settings.
- Unique angle: Configure the cookie from the session threat model. Cover host-only scope, `__Host-` constraints, cross-site flows, server-side invalidation, rotation, and the fact that attributes do not protect a stolen server-side session record.
- Required entities: RFC 6265, `Secure`, `HttpOnly`, `SameSite`, Domain, Path, `__Host-`, Max-Age, session ID, rotation, invalidation.
- Cannibalization check: This article owns cookie transport and scope. `csrf-cookie-auth-ai-apps` owns cross-site state-changing request defenses. `jwt-validation-mistakes` owns token validation. Topic 23 owns login throttling and enumeration.
- Required sources: RFC 6265, OWASP Session Management Cheat Sheet, MDN Set-Cookie reference.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/jwt-session-inspector`, described as a local decoder and Set-Cookie attribute check that does not verify server invalidation.
- Related dependency: `https://lyrashieldai.com/blog/csrf-cookie-auth-ai-apps`
- FAQ decision: Yes. Answer `SameSite=Lax` versus `Strict`, domain omission, and whether JWTs in cookies remove the need for server-side session controls.
- Image cluster concept: Access control. A sealed session token sits in a host-scoped compartment with a narrow secure transport channel.

## 30. TLS and Mobile Transport Security

- Slug: `tls-mobile-transport-security`
- Primary query: `mobile app transport security - explainer`
- Target length: 1,350 words
- Reader problem: Development exceptions or custom networking code allow cleartext traffic, weak certificate checks, or broad trust settings to survive into a mobile release.
- Unique angle: Compare Apple ATS and Android Network Security Configuration, explain their scope limits, and give a release test for cleartext exceptions, certificate validation, redirects, custom stacks, and backend TLS configuration.
- Required entities: TLS, HTTPS, App Transport Security, Network Security Configuration, cleartext traffic, certificate validation, hostname validation, trust anchor, debug override.
- Cannibalization check: This article owns network transport and platform policy. Topic 29 owns cookies. Topic 28 owns browser response headers, including HSTS. It must not claim that HSTS configures native transport or that ATS covers every low-level API.
- Required sources: Apple ATS documentation, Android cleartext communications guidance, NIST SP 800-52 Rev. 2.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/security-headers-checker`, limited to checking a pasted web response and paired with a warning that it cannot inspect native app configuration.
- Related dependency: `https://lyrashieldai.com/blog/security-headers-ai-built-apps`
- FAQ decision: Yes. Answer whether certificate pinning is always required, whether ATS covers all network libraries, and how to keep debug exceptions out of release builds.
- Image cluster concept: Web and execution. A mobile-shaped graphite endpoint connects through a certificate-checked cyan corridor while cleartext branches terminate.

## 31. Public-by-Default Deployments and Storage

- Slug: `public-by-default-ai-apps`
- Primary query: `ai app exposed data - prevention`
- Target length: 1,400 words
- Reader problem: A preview, internal app, database API, bucket, or generated deployment URL is reachable without the access boundary the team assumed existed.
- Unique angle: Inventory every origin and storage surface, then prove access from a logged-out browser and a second account. Separate discoverability controls such as `noindex` from actual authorization.
- Required entities: deployment protection, preview URL, public bucket, S3 Block Public Access, Supabase RLS, Data API, service role, `noindex`, authentication, least privilege.
- Cannibalization check: This article owns unintended public exposure across deployment and storage configuration. `supabase-rls-vibe-coded-apps` owns row policy design. `secure-admin-routes` owns application route authorization. Topic 33 owns static build-artifact contents.
- Required sources: AWS S3 Block Public Access, Supabase Securing Your Data, Vercel Deployment Protection.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, used to inventory public URLs and access proofs.
- Related dependency: `https://lyrashieldai.com/blog/supabase-rls-vibe-coded-apps`
- FAQ decision: Yes. Answer whether `noindex` makes an app private, whether an unguessable preview URL is access control, and how to test a bucket without exposing private data.
- Image cluster concept: Access control. Private compartments remain behind a deployment boundary while one intentionally public surface is clearly separated.

## 32. Remove Debug Routes and Verbose Errors

- Slug: `debug-routes-error-leaks`
- Primary query: `stack trace information disclosure - fix`
- Target length: 1,300 words
- Reader problem: Production responses expose stack traces, internal paths, SQL details, environment values, framework diagnostics, or convenience routes.
- Unique angle: Remove or authenticate debug surfaces, centralize exception mapping, return a stable public error with a correlation ID, and keep detailed diagnostics only in access-controlled logs after redaction.
- Required entities: CWE-209, stack trace, debug route, error boundary, correlation ID, production mode, exception mapping, redaction, Flask debugger.
- Cannibalization check: This article owns runtime response and route leakage. Topic 33 owns source maps and files shipped in build or package artifacts even when every runtime error is generic. Topic 34 owns secrets and PII written to telemetry.
- Required sources: OWASP Error Handling Cheat Sheet, MITRE CWE-209, Flask Debugging documentation.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, prompting a production-only route and error review.
- Related dependency: `https://lyrashieldai.com/blog/source-map-build-artifact-security`
- FAQ decision: Yes. Answer whether a correlation ID is safe, whether hiding stack traces fixes the root error, and how to retain useful production diagnostics.
- Image cluster concept: Web and execution. A runtime error route ends at an opaque public response plane while detailed evidence continues into a sealed internal channel.

## 33. Stop Shipping Source Maps and Private Build Artifacts

- Slug: `source-map-build-artifact-security`
- Primary query: `source map security production - fix`
- Target length: 1,350 words
- Reader problem: Production bundles, source maps, package tarballs, or CI artifacts contain source, routes, comments, environment substitutions, or private files that were never intended for public delivery.
- Unique angle: Inspect the built artifact, not only the repository. Explain public, hidden, and uploaded source maps; package allowlists; deterministic secret scans; and why deleting a mapping comment does not make an accessible `.map` private.
- Required entities: source map, `productionBrowserSourceMaps`, Vite `build.sourcemap`, npm `files`, package tarball, CI artifact, asset manifest, secret scan.
- Cannibalization check: This article owns static build and package outputs. Topic 32 owns runtime debug routes and verbose errors. `api-keys-frontend-ai-apps` owns frontend secret placement. Here, secrets are one possible artifact leak, not the only reason to inspect outputs.
- Required sources: Next.js production browser source maps, Vite build options, npm `package.json` files field.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/secret-exposure-scanner`, used on selected local text artifacts with its 1 MB per-file and pattern-based limitations stated.
- Related dependency: `https://lyrashieldai.com/blog/api-keys-frontend-ai-apps`
- FAQ decision: Yes. Answer hidden source maps, maps uploaded only to an error service, and how to inspect an npm tarball before publishing.
- Image cluster concept: Supply chain. A sealed build artifact passes through a provenance frame while map-like layers remain in a private chamber.

## 34. Keep PII and Secrets Out of Logs

- Slug: `sensitive-data-logging`
- Primary query: `pii in logs security - prevention`
- Target length: 1,350 words
- Reader problem: Request bodies, prompts, tokens, headers, query strings, user details, or exception objects flow into logs and third-party telemetry.
- Unique angle: Minimize at the source, allowlist fields, redact before export, test processors with seeded fake secrets, constrain access and retention, and treat correlation needs separately from raw identity.
- Required entities: PII, access token, session identifier, request body, prompt, telemetry, redaction, data minimization, pseudonymization, retention, OpenTelemetry.
- Cannibalization check: This article owns log content and privacy. Topic 35 owns event accountability, integrity, and audit design. Topic 32 owns what a user sees in an error response. An audit log can still be unsafe if it records sensitive values.
- Required sources: OWASP Logging Cheat Sheet, NIST SP 800-92, OpenTelemetry Handling Sensitive Data.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/secret-exposure-scanner`, limited to a local, sanitized sample or exported test file and never positioned as a complete PII detector.
- Related dependency: `https://lyrashieldai.com/blog/security-audit-log-design`
- FAQ decision: Yes. Answer whether hashing an email anonymizes it, whether stack traces are safe, and where redaction should occur.
- Image cluster concept: Decision and operations. Sensitive signal fragments are removed before a structured evidence stream enters a restrained telemetry channel.

## 35. Audit Logs for Security-Sensitive Actions

- Slug: `security-audit-log-design`
- Primary query: `security audit log best practices - how-to`
- Target length: 1,400 words
- Reader problem: A team cannot reconstruct who changed access, started a scan, revoked sharing, approved an action, or changed security configuration.
- Unique angle: Design an append-oriented event record around actor, action, subject, workspace, outcome, request correlation, trustworthy time, source, and reason, then protect access, retention, integrity, and tenant boundaries.
- Required entities: audit event, actor, subject, action, outcome, timestamp, correlation ID, workspace, append-only, tamper evidence, retention, NIST AU controls.
- Cannibalization check: This article owns accountable security events and audit-record integrity. Topic 34 owns sensitive-data minimization in all logs. Topic 36 will own monitoring and alerting over operational signals. Audit events should be usable by monitoring but are not themselves an alerting system.
- Required sources: OWASP Logging Cheat Sheet, NIST SP 800-53 Rev. 5 AU controls, NIST SP 800-92.
- Authority link: `https://lyrashieldai.com/blog/vibe-coding-security-guide`
- Tool CTA: `https://lyrashieldai.com/tools/ai-app-security-checklist`, used to identify actions that need evidence and review.
- Related dependency: `https://lyrashieldai.com/blog/sensitive-data-logging`
- FAQ decision: Yes. Answer audit versus application logs, whether administrators may edit records, and what to do when the audit sink is unavailable.
- Image cluster concept: Decision and operations. An immutable chain of evidence planes records controlled actions across scoped compartments.

## Batch cannibalization summary

- `rate-limiting-ai-apps` answers how to bound resource use per endpoint and principal. `brute-force-account-enumeration` answers how to resist guessing and avoid identity disclosure across authentication flows.
- `stripe-webhook-signature-security` answers whether Stripe signed the exact request. `payment-entitlement-server-source-truth` answers whether a user is entitled at the protected operation. `idempotency-replay-protection` answers whether repeated or concurrent delivery changes state more than once.
- `debug-routes-error-leaks` covers dynamic routes and runtime responses. `source-map-build-artifact-security` covers static files and published artifacts that remain exposed even with generic runtime errors.
- `sensitive-data-logging` covers which data must not enter telemetry. `security-audit-log-design` covers which security events need accountable, protected records.

No brief targets a ranking, benchmark, customer, pricing, automatic fix, or universal-security claim. All 17 topics remain distinct from the authority guide, which provides the broad six-layer model and routes readers to these implementation articles.
