# Batch 1 editorial briefs

Date: 2026-07-17
Status: research-ready, not approved for publication
Owner: LyraShield Team
Release: topics 2 through 18

## Shared brief rules

- Use `/blog/vibe-coding-security-guide` as the authority link in the first third.
- Treat the related article below as a required release dependency. Do not publish an article while that link is unresolved.
- Use the exact primary query and target range from the approved program map.
- Keep each article focused on its declared intent. The cannibalization notes are binding.
- Use only safe local examples and two-account or test-environment verification. Do not provide instructions against a real unpatched target.
- Explain what source review, static checks, and local tests cannot establish.
- The image concept is an editorial direction, not an approved image assignment.

## Topic 2: Supabase RLS for Vibe-Coded Apps

- Slug: `supabase-rls-vibe-coded-apps`
- Primary query: `supabase rls security - fix`
- Intent and target: Access, 1,400 words, Pillar plus RLS Checker
- Reader problem: A builder has a Supabase-backed app but cannot tell whether exposed tables, grants, and policies prevent one signed-in user from reading or changing another user's rows.
- Unique angle: Show the full enforcement chain of Data API grants, enabled RLS, command-specific `USING` and `WITH CHECK` policies, and negative tests with two accounts. Do not present RLS as a checkbox.
- Required entities: Supabase Data API, PostgreSQL row security, `anon`, `authenticated`, publishable key, secret key, `service_role`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, `USING`, `WITH CHECK`, permissive policies.
- Cannibalization check: Owns Supabase policy mechanics and local SQL review. `/blog/multi-tenant-data-isolation` owns stack-wide tenant context and non-database boundaries. Future `/blog/supabase-security-guide` owns the broader Supabase Auth, storage, keys, and deployment checklist.
- Required research: S01, S02, S03, S04. Four authoritative sources, all official or primary.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/supabase-rls-checker`, described as a local heuristic review that does not inspect deployed policies or grants.
- Related dependency: `/blog/multi-tenant-data-isolation`
- FAQ decision: Yes, three questions on whether RLS is required, whether the publishable key is a secret, and why `service_role` bypasses policy enforcement.
- Image cluster concept: Access-control image showing row-shaped compartments behind a policy gate, with one scoped cyan path and an isolated red bypass path.

## Topic 3: How to Find IDOR in an AI-Built App

- Slug: `idor-ai-built-apps`
- Primary query: `idor vulnerability test - how-to`
- Intent and target: Access, 1,350 words, Pillar plus Launch Checklist
- Reader problem: A builder sees record IDs in requests and needs a safe way to check whether the server authorizes each requested object.
- Unique angle: Use a two-account test fixture to separate object-level authorization from authentication, route-level authorization, and unguessable identifiers. The fix scopes the lookup itself, not just a later comparison.
- Required entities: IDOR, BOLA, object identifier, current principal, ownership predicate, tenant predicate, horizontal privilege escalation, negative authorization test, UUID.
- Cannibalization check: Owns object-reference testing and object-scoped queries. `/blog/server-side-authorization-ai-apis` owns reusable endpoint authorization architecture. Future `/blog/two-account-idor-test` owns the generalized release-gate procedure across several object types.
- Required research: S04, S05, S06, S12. Four authoritative sources, including OWASP API Security and stable WSTG guidance.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, with an explicit note that the checklist cannot test object authorization.
- Related dependency: `/blog/server-side-authorization-ai-apis`
- FAQ decision: Yes, three questions on UUIDs, 404 versus 403 responses, and whether automated scanners can prove ownership rules.
- Image cluster concept: Access-control image with two object capsules and a request path stopped at the wrong ownership boundary.

## Topic 4: Stop Exposing API Keys in Frontend Code

- Slug: `api-keys-frontend-ai-apps`
- Primary query: `exposed api key frontend - fix`
- Intent and target: Secrets, 1,300 words, Pillar plus Secret Scanner
- Reader problem: A builder has placed provider credentials in client environment variables or a browser bundle and needs to distinguish public identifiers from privileged secrets.
- Unique angle: Explain that browser-delivered values are recoverable by design, then move privileged provider calls behind a server boundary with scoped credentials. Detection is followed by revocation and replacement, not deletion alone.
- Required entities: Vite `VITE_`, Next.js `NEXT_PUBLIC_`, browser bundle, source map, network inspector, publishable key, secret key, revocation, rotation, least privilege, Git history.
- Cannibalization check: Owns client-bundle exposure and architectural remediation. Future `/blog/secret-scanning-before-commit` owns repository prevention. Future `/blog/exposed-api-key-incident-response` owns full incident containment and recovery.
- Required research: S07, S08, S09, S10, S11. Five official or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/secret-exposure-scanner`, limited to selected local text files and not Git history or deployed bundles.
- Related dependency: `/blog/supabase-rls-vibe-coded-apps`
- FAQ decision: Yes, four questions on public Supabase keys, environment files, source maps, and whether deleting a leaked key from Git is enough.
- Image cluster concept: Access-control image with a bright credential fragment escaping from a browser-facing plane while a sealed server compartment remains opaque.

## Topic 5: Why Client-Side Auth Is Not Access Control

- Slug: `client-side-auth-not-security`
- Primary query: `client side authentication security - explainer`
- Intent and target: Access, 1,300 words, Pillar plus Launch Checklist
- Reader problem: A builder has hidden pages, buttons, or roles in the browser and assumes that an attacker cannot invoke the underlying action.
- Unique angle: Treat the frontend as a user-experience layer that may display authorization state but cannot be the decisive enforcement point. Demonstrate a harmless direct request against a local fixture.
- Required entities: authentication, authorization, client-side routing, localStorage, hidden controls, direct request, server-side policy, default deny, session principal.
- Cannibalization check: Owns the conceptual browser trust boundary. `/blog/server-side-authorization-ai-apis` owns implementation structure. Future `/blog/react-frontend-security-ai-code` owns React-specific frontend hardening beyond authorization.
- Required research: S11, S12, S13, S15. Four authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, framed as a prompt to document the real server boundary.
- Related dependency: `/blog/server-side-authorization-ai-apis`
- FAQ decision: Yes, three questions on route guards, localStorage sessions, and whether hiding an admin button has any security value.
- Image cluster concept: Access-control image with a thin translucent UI curtain in front of a separate graphite server gate.

## Topic 6: Server-Side Authorization for AI-Generated APIs

- Slug: `server-side-authorization-ai-apis`
- Primary query: `backend authorization - implementation`
- Intent and target: Access, 1,400 words, Pillar plus Launch Checklist
- Reader problem: An API authenticates users but repeats or omits permission checks across handlers, service methods, and data access.
- Unique angle: Build one deny-by-default authorization seam around the authenticated principal, action, resource, and tenant, then show negative tests for every sensitive operation.
- Required entities: principal, action, resource, policy decision, policy enforcement point, deny by default, least privilege, object-level authorization, function-level authorization, audit event.
- Cannibalization check: Owns the general implementation pattern. `/blog/idor-ai-built-apps` owns object-ID testing. `/blog/secure-admin-routes` owns privileged-route inventory and role escalation. `/blog/multi-tenant-data-isolation` owns tenant context propagation.
- Required research: S12, S14, S15, S18. Four authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, with no claim that it verifies authorization code.
- Related dependency: `/blog/idor-ai-built-apps`
- FAQ decision: Yes, three questions on middleware, role checks, and 401 versus 403.
- Image cluster concept: Access-control image with multiple request routes converging on one explicit policy gate before reaching resources.

## Topic 7: Prevent Cross-Tenant Data Leaks

- Slug: `multi-tenant-data-isolation`
- Primary query: `multi tenant data isolation - fix`
- Intent and target: Access, 1,450 words, Pillar plus RLS Checker
- Reader problem: A SaaS builder passes a workspace or organization ID through the UI but has no consistent proof that every storage and service operation is scoped to the active tenant.
- Unique angle: Separate identity and ordinary authorization from tenant isolation, then trace server-owned tenant context through APIs, jobs, caches, object storage, and database queries.
- Required entities: tenant context, workspace ID, pooled isolation, silo isolation, request context, background job, cache key, object-storage prefix, row-level security, two-tenant negative test.
- Cannibalization check: Owns system-wide tenant context and non-database surfaces. `/blog/supabase-rls-vibe-coded-apps` owns Supabase and PostgreSQL policy syntax. `/blog/idor-ai-built-apps` owns a single object-reference flaw.
- Required research: S16, S17, S03, S04. Four primary or official sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/supabase-rls-checker`, explicitly limited to pasted SQL and one database layer.
- Related dependency: `/blog/supabase-rls-vibe-coded-apps`
- FAQ decision: Yes, four questions on tenant IDs from clients, RLS sufficiency, shared databases, and background jobs.
- Image cluster concept: Access-control image with three sealed tenant compartments and one server-owned context beam selecting exactly one compartment.

## Topic 8: Secure Admin Routes in AI-Built Apps

- Slug: `secure-admin-routes`
- Primary query: `secure admin routes - how-to`
- Intent and target: Access, 1,300 words, Pillar plus Launch Checklist
- Reader problem: Admin, debug, maintenance, or internal endpoints exist, but their protection depends on a hidden link, route naming, or a client role flag.
- Unique angle: Inventory privileged functions by action rather than path, enforce role and resource policy on every method, and test with an ordinary authenticated account.
- Required entities: BFLA, admin controller, ordinary user, privileged action, HTTP method, debug route, maintenance endpoint, default deny, step-up authentication.
- Cannibalization check: Owns privileged function exposure. `/blog/server-side-authorization-ai-apis` owns the general policy seam. Future stack-specific guides own framework middleware syntax.
- Required research: S14, S18, S12, S15. Four authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, described as documentation support rather than route discovery.
- Related dependency: `/blog/server-side-authorization-ai-apis`
- FAQ decision: Yes, three questions on obscure URLs, VPN-only panels, and step-up authentication.
- Image cluster concept: Access-control image with an amber privileged route ending at a locked role gate above ordinary cyan paths.

## Topic 9: JWT Validation Mistakes AI Tools Generate

- Slug: `jwt-validation-mistakes`
- Primary query: `jwt security best practices - fix`
- Intent and target: Auth, 1,400 words, Pillar plus JWT Inspector
- Reader problem: An application decodes JWT claims but may not verify the signature, allowed algorithm, issuer, audience, time claims, or token type.
- Unique angle: Present validation as a deployment-specific allowlist and trust configuration, not a generic `decode()` call. Distinguish inspecting a token from accepting it.
- Required entities: JWT, JWS, signature verification, `alg`, issuer, audience, expiration, not-before, key set, token type, replay, OpenID Connect.
- Cannibalization check: Owns server acceptance rules and trust configuration. The JWT Inspector page owns local decoding and explicitly does not verify. Future stack guides may link here rather than repeat the full model.
- Required research: S19, S20, S21, S22. Four primary standards or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/jwt-session-inspector`, with an adjacent warning that decoding does not validate a signature or session.
- Related dependency: `/blog/client-side-auth-not-security`
- FAQ decision: Yes, four questions on decoding versus verification, `alg=none`, issuer and audience, and token storage.
- Image cluster concept: Access-control image with a signed token envelope passing through algorithm, issuer, audience, and time verification planes.

## Topic 10: Secure Password Reset and Email Verification

- Slug: `password-reset-email-verification-security`
- Primary query: `password reset security - how-to`
- Intent and target: Auth, 1,400 words, Pillar plus Launch Checklist
- Reader problem: Reset and email-verification flows work on the happy path but may leak account existence, accept reusable tokens, trust the Host header, or leave old sessions active.
- Unique angle: Model reset and verification as security-sensitive state transitions with uniform requests, single-use token records, fixed trusted origins, atomic consumption, and session invalidation decisions.
- Required entities: account enumeration, reset token, verification token, CSPRNG, single use, expiry, token hash, trusted origin, Referrer-Policy, session invalidation, email change.
- Cannibalization check: Owns recovery and verification workflows. `/blog/password-hashing-vibe-coders` owns password verifier storage. Future incident-response content owns post-compromise recovery.
- Required research: S23, S24, S25, S26. Four primary or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, noting that the checklist cannot exercise token reuse or enumeration behavior.
- Related dependency: `/blog/password-hashing-vibe-coders`
- FAQ decision: Yes, four questions on token storage, expiry, automatic login, and email verification versus authentication strength.
- Image cluster concept: Access-control image showing a one-time amber recovery token moving through an expiry ring into a sealed account state.

## Topic 11: Password Hashing for Vibe Coders

- Slug: `password-hashing-vibe-coders`
- Primary query: `how to store passwords securely - explainer`
- Intent and target: Auth, 1,300 words, Pillar plus Launch Checklist
- Reader problem: A builder is choosing between plaintext, reversible encryption, fast hashes, and password-specific hashing libraries without understanding salts, work factors, or migration.
- Unique angle: Use maintained password-hashing libraries and calibrate a memory-hard verifier for the deployment. Cover transparent rehashing and legacy migration without inventing one universal parameter set.
- Required entities: Argon2id, scrypt, bcrypt, PBKDF2, salt, pepper, work factor, memory hardness, password verifier, hash migration, NIST SP 800-63B-4.
- Cannibalization check: Owns storage of password verifiers. `/blog/password-reset-email-verification-security` owns recovery tokens and account flows. It does not become a general password-policy article.
- Required research: S27, S28, S29, S25. Four primary or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, framed as a reminder to document the verifier and migration policy.
- Related dependency: `/blog/password-reset-email-verification-security`
- FAQ decision: Yes, four questions on encryption versus hashing, salts, bcrypt, and when to rehash.
- Image cluster concept: Access-control image with a password signal entering a dense memory-hard graphite lattice and emerging as a sealed verifier.

## Topic 12: SQL Injection in AI-Generated Code

- Slug: `sql-injection-ai-generated-code`
- Primary query: `ai generated sql injection - fix`
- Intent and target: Input, 1,400 words, Pillar plus Launch Checklist
- Reader problem: Generated code falls back to string interpolation for a raw query, sort field, table name, or search filter even when an ORM is present.
- Unique angle: Separate values that can be bound from SQL identifiers that require a strict mapping. Show parameterization, least-privilege database roles, and safe tests without supplying a real-target exploit.
- Required entities: SQL injection, prepared statement, parameterized query, bind value, dynamic identifier, allowlist mapping, ORM raw query, database role, second-order injection.
- Cannibalization check: Owns the SQL interpreter boundary. `/blog/input-validation-ai-generated-api` owns request shape and business rules. Input validation is not presented as a replacement for parameterization.
- Required research: S30, S31, S32, S33. Four official or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, with a note that it does not inspect query construction.
- Related dependency: `/blog/input-validation-ai-generated-api`
- FAQ decision: Yes, three questions on ORMs, stored procedures, and dynamic sort or column names.
- Image cluster concept: Web-and-execution image with data tokens entering a bound parameter tunnel while an unbound red fragment is rejected.

## Topic 13: XSS in AI Apps That Render Markdown or Model Output

- Slug: `xss-ai-app-markdown-output`
- Primary query: `ai app xss markdown - fix`
- Intent and target: Input, 1,450 words, Pillar plus Launch Checklist
- Reader problem: An application turns user or model output into HTML and assumes Markdown rendering, a framework, or a Content Security Policy makes the result safe.
- Unique angle: Trace untrusted text through Markdown parsing, optional raw HTML, sanitization, DOM insertion, and browser context. Prefer text sinks when rich HTML is not required.
- Required entities: stored XSS, DOM XSS, Markdown renderer, raw HTML, HTML sanitizer, `innerHTML`, `textContent`, Trusted Types, output encoding, CSP.
- Cannibalization check: Owns the rendered-output and Markdown pipeline. `/blog/input-validation-ai-generated-api` owns request schemas. Future framework articles should link here for dangerous HTML sinks rather than duplicate the full treatment.
- Required research: S34, S35, S36, S37. Four authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, explicitly not an HTML sanitizer or runtime test.
- Related dependency: `/blog/input-validation-ai-generated-api`
- FAQ decision: Yes, four questions on Markdown safety, React escaping, CSP, and model output trust.
- Image cluster concept: Web-and-execution image with Markdown fragments passing through a translucent sanitizer plane before a browser surface.

## Topic 14: Input Validation for AI-Generated APIs

- Slug: `input-validation-ai-generated-api`
- Primary query: `api input validation - how-to`
- Intent and target: Input, 1,350 words, Pillar plus Launch Checklist
- Reader problem: An API accepts extra fields, wrong types, oversized values, inconsistent identifiers, or values that pass syntax but violate business rules.
- Unique angle: Validate at the server boundary, reject unknown or oversized input, and keep syntax validation separate from authorization, output encoding, and interpreter-safe APIs.
- Required entities: schema validation, type, length, range, unknown fields, canonicalization, business invariant, allowlist, error response, request body limit, mass assignment.
- Cannibalization check: Owns API request contracts and business invariants. `/blog/sql-injection-ai-generated-code` owns SQL parameterization. `/blog/xss-ai-app-markdown-output` owns output handling. `/blog/secure-file-uploads-ai-apps` owns binary content validation.
- Required research: S38, S39, S40, S11. Four authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, framed as an inventory aid, not input fuzzing.
- Related dependency: `/blog/sql-injection-ai-generated-code`
- FAQ decision: Yes, three questions on client validation, unknown fields, and validation versus sanitization.
- Image cluster concept: Web-and-execution image with typed request shapes passing a size and schema gate while malformed shapes fall away.

## Topic 15: CORS for Vibe-Coded Apps

- Slug: `cors-vibe-coded-apps`
- Primary query: `cors configuration security - fix`
- Intent and target: Web, 1,300 words, Pillar plus Headers Checker
- Reader problem: A development wildcard or reflected Origin remains in production, and the builder is unclear about preflights, credentials, caches, and server-side authorization.
- Unique angle: Derive a minimal exact-origin policy from the real browser clients. Explain that CORS controls browser response sharing and does not authenticate callers or replace CSRF and authorization controls.
- Required entities: origin, same-origin policy, preflight, `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, `Vary: Origin`, allowlist, wildcard, reflected origin, credentialed request.
- Cannibalization check: Owns CORS response policy. The Headers Checker owns local header observations. `/blog/csrf-cookie-auth-ai-apps` owns forged state-changing requests with ambient cookies.
- Required research: S41, S42, S43, S44. Four standards or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/security-headers-checker`, limited to pasted headers from one observed response.
- Related dependency: `/blog/csrf-cookie-auth-ai-apps`
- FAQ decision: Yes, four questions on wildcard origins, credentials, non-browser clients, and whether CORS prevents CSRF.
- Image cluster concept: Web-and-execution image with an exact browser origin corridor and rejected reflected or wildcard paths.

## Topic 16: CSRF Protection for Cookie-Based AI Apps

- Slug: `csrf-cookie-auth-ai-apps`
- Primary query: `csrf protection cookie auth - how-to`
- Intent and target: Web, 1,350 words, Pillar plus Launch Checklist
- Reader problem: A cookie-authenticated app accepts state-changing requests without a CSRF token, origin policy, or Fetch Metadata rule because the session is valid.
- Unique angle: Choose a framework control or token pattern based on the session model, then layer SameSite and Fetch Metadata without treating either as a universal replacement.
- Required entities: ambient credential, synchronizer token, signed double-submit cookie, Origin, Referer, `Sec-Fetch-Site`, SameSite, state-changing method, custom header, CORS.
- Cannibalization check: Owns request intent for cookie-authenticated state changes. `/blog/cors-vibe-coded-apps` owns cross-origin response sharing. Future session articles own cookie lifetime and rotation.
- Required research: S45, S46, S47, S48. Four primary or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, noting that it cannot submit cross-site test requests.
- Related dependency: `/blog/cors-vibe-coded-apps`
- FAQ decision: Yes, four questions on SameSite, bearer tokens, GET requests, and XSS interaction.
- Image cluster concept: Web-and-execution image with a state-change request passing matching session and anti-forgery receipts at one gate.

## Topic 17: SSRF Protection That Resolves DNS

- Slug: `ssrf-protection-dns-redirects`
- Primary query: `ssrf prevention dns rebinding - technical`
- Intent and target: Input, 1,500 words, Pillar plus full app scan CTA
- Reader problem: A URL fetcher validates a string once but can still resolve to private addresses, follow redirects, or reach cloud metadata and internal services.
- Unique angle: Treat validation and connection as one pinned transport decision. Resolve all A and AAAA answers, classify every address, control redirects and protocols, and add network egress restrictions.
- Required entities: SSRF, DNS rebinding, DNS pinning, A record, AAAA record, private address, link-local address, loopback, redirect, cloud metadata, IMDSv2, egress policy.
- Cannibalization check: Owns URL-to-network transport validation. `/blog/input-validation-ai-generated-api` owns ordinary request schemas. Future stack guides should link here rather than offer framework-only URL regexes.
- Required research: S49, S50, S51, S52. Four official or authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: Primary CTA `/scan` for a passive public-surface check, with an explicit statement that it cannot prove internal egress controls. Secondary free tool `/tools/ai-app-security-checklist` for documenting the control.
- Related dependency: `/blog/input-validation-ai-generated-api`
- FAQ decision: Yes, four questions on URL allowlists, DNS rebinding, redirects, and IMDSv2.
- Image cluster concept: Web-and-execution image with a hostname resolving through A and AAAA planes into a pinned public route while private and redirect routes are blocked.

## Topic 18: Secure File Uploads in AI-Built Apps

- Slug: `secure-file-uploads-ai-apps`
- Primary query: `secure file upload - how-to`
- Intent and target: Input, 1,400 words, Pillar plus Launch Checklist
- Reader problem: An upload endpoint trusts the extension or browser MIME type and stores user filenames in a public executable location without strict size or content controls.
- Unique angle: Build a staged acceptance pipeline: size limits before parsing, server-generated names, extension and content agreement, content-specific rewriting or scanning, quarantine, private storage, and safe delivery headers.
- Required entities: multipart form data, extension, MIME type, magic bytes, size limit, quarantine, content disarm, object storage, server-generated filename, web root, `Content-Disposition`.
- Cannibalization check: Owns binary and document acceptance. `/blog/input-validation-ai-generated-api` owns structured API fields. The next batch path-traversal article will own filesystem containment and archive extraction paths.
- Required research: S53, S54, S55, S56. Four authoritative sources.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`, described as a launch-control inventory rather than a file analyzer.
- Related dependency: `/blog/input-validation-ai-generated-api`
- FAQ decision: Yes, four questions on MIME type, antivirus, public object storage, and images.
- Image cluster concept: Web-and-execution image showing an uploaded object moving through size, type, quarantine, and private-storage chambers.

## Batch cannibalization result

All 17 intents are distinct when the boundaries above are preserved. The main collision risks are RLS versus tenant isolation, IDOR versus general authorization, CORS versus CSRF, and input validation versus interpreter-specific defenses. Each pair has a defined owner and a required cross-link. No brief targets the broader stack, workflow, verification, or incident-response intents reserved for later batches.
