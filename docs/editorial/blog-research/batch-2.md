# Batch 2 claim and source research

Date: 2026-07-17
Release: topics 19 to 35
Status: source review complete, public drafts not started

## Method

All links were reviewed on 2026-07-17. A source marked **primary or official** is a standards body, government publication, weakness owner, or vendor documenting its own behavior. A source marked **authoritative guidance** is maintained security guidance from OWASP. Rolling documents without a stated publication date are recorded with the exact access date rather than an inferred publication date.

Each article has three authoritative sources and at least two primary or official sources. Source count is a floor, not permission to make an unlisted claim. Draft authors must keep examples local or confined to owned test environments. They must not turn taxonomy examples into prevalence claims.

Coverage: 52 article-to-source placements across 49 distinct URLs. Sixteen articles use three sources. Topic 26 uses four because a current framework implementation source is needed in addition to the weakness taxonomy and OWASP guidance.

## 19. `path-traversal-generated-code`

### Sources

1. **Primary or official:** MITRE, [CWE-22: Improper Limitation of a Pathname to a Restricted Directory](https://cwe.mitre.org/data/definitions/22.html), CWE 4.20, accessed 2026-07-17.
2. **Authoritative guidance:** OWASP, [Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal), rolling document, accessed 2026-07-17.
3. **Primary or official:** Node.js, [Path API](https://nodejs.org/api/path.html), current Node.js API documentation, accessed 2026-07-17.

### Claim-to-source map

- Path traversal occurs when externally influenced path components allow access outside the intended restricted directory: source 1.
- Absolute paths, encoded separators, Windows backslashes, and repeated decoding make substring denylists incomplete: sources 1 and 2.
- `path.resolve()` produces an absolute resolved path and `path.relative()` describes the path from one location to another, but the application must still enforce containment and account for platform-specific behavior: source 3, with the security conclusion bounded by sources 1 and 2.
- Prefer a server-side identifier-to-file mapping. If a path must be accepted, resolve it against a trusted root, reject any relative result that escapes, and evaluate symlinks before the final open where the threat model permits them: sources 1 and 2. The symlink race limitation must be presented as an implementation caveat, not as something the Node path helpers solve.

### Draft guardrails

- Do not publish a real target path or a working exfiltration procedure.
- State that normalization alone is not authorization and that a clean static result cannot prove runtime symlink behavior.

## 20. `command-injection-agentic-apps`

### Sources

1. **Authoritative guidance:** OWASP, [OS Command Injection Defense Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html), rolling document, accessed 2026-07-17.
2. **Primary or official:** MITRE, [CWE-78: Improper Neutralization of Special Elements used in an OS Command](https://cwe.mitre.org/data/definitions/78.html), CWE 4.20, accessed 2026-07-17.
3. **Primary or official:** Node.js, [Child process API](https://nodejs.org/api/child_process.html), current Node.js API documentation, accessed 2026-07-17.

### Claim-to-source map

- The strongest design is to avoid OS commands and call a library or constrained API directly: sources 1 and 2.
- When an external process is necessary, separate the executable from an argument array and avoid a shell. Node documents that `exec()` uses a shell while `execFile()` runs the command directly by default on Unix-like systems: source 3.
- Argument arrays reduce shell metacharacter interpretation but do not make every argument safe. The invoked program may interpret options or nested syntax, so allowlists and end-of-options handling can still matter: sources 1 and 2.
- Least privilege, a fixed working directory, a minimal environment, output and time limits, and a sandbox reduce impact but do not repair unsafe command construction: source 2.

### Draft guardrails

- Do not include a copy-paste payload that targets a named service.
- Separate command injection, argument injection, authorization to invoke a tool, and sandbox escape. No one control proves all four.

## 21. `oauth-redirect-callback-security`

### Sources

1. **Primary standard:** IETF, [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html), January 2025.
2. **Primary standard:** IETF, [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html), October 2012.
3. **Primary standard:** IETF, [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html), October 2017.

### Claim-to-source map

- Authorization servers must use exact string matching for registered redirect URIs, except the native-app localhost port exception described by RFC 8252: sources 1 and 3.
- Clients and authorization servers must not expose open redirectors in redirect-based flows: source 1.
- The authorization code is bound to the client identifier and redirect URI, must expire shortly, and must not be used more than once: source 2.
- Current guidance requires public clients to use PKCE and requires callback transaction binding against CSRF or code injection. `state`, PKCE, nonce, and issuer checks have overlapping but not interchangeable roles: source 1.

### Draft guardrails

- Do not reduce callback security to checking that a URL starts with the expected domain.
- Do not say `state` always replaces PKCE. Explain the provider and client contract.

## 22. `rate-limiting-ai-apps`

### Sources

1. **Authoritative guidance:** OWASP, [API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/), 2023 edition, accessed 2026-07-17.
2. **Primary standard:** IETF, [RFC 6585: Additional HTTP Status Codes](https://www.rfc-editor.org/rfc/rfc6585.html), April 2012.
3. **Primary or official:** Cloudflare, [Rate limiting best practices](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/), rolling vendor documentation, accessed 2026-07-17.

### Claim-to-source map

- APIs need limits for request frequency and for resource-consuming inputs, operations, and downstream services: source 1.
- HTTP 429 means too many requests in a given time and may include `Retry-After`; the RFC does not dictate how a server identifies or counts a client: source 2.
- Different endpoints need different characteristics, thresholds, and mitigation behavior. A login route, file upload, webhook, and costly generation route should not inherit one generic rule: sources 1 and 3.
- An IP address alone can represent many users or be rotated by one actor. Prefer an authenticated principal or other trusted key where available, and combine rate, concurrency, payload, cost, and queue controls based on the resource at risk: source 1, with implementation patterns informed by source 3.

### Draft guardrails

- Keep this article about resource and abuse budgets. Move response consistency, MFA, and account lockout to topic 23.
- Do not prescribe one universal number. Limits require measured capacity, acceptable abuse risk, and endpoint behavior.

## 23. `brute-force-account-enumeration`

### Sources

1. **Primary or official:** NIST, [SP 800-63B-4: Digital Identity Guidelines, Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html), finalized 2025-07-31.
2. **Authoritative guidance:** OWASP, [Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), rolling document, accessed 2026-07-17.
3. **Primary or official:** MITRE, [CWE-204: Observable Response Discrepancy](https://cwe.mitre.org/data/definitions/204.html), CWE 4.20, accessed 2026-07-17.

### Claim-to-source map

- NIST requires a mechanism that limits failed authentication attempts and describes increasing delays, bot mitigation, and risk-based controls as additional techniques: source 1.
- Brute force, credential stuffing, and password spraying are distinct patterns. Layered controls can include MFA, throttling, monitoring, and careful lockout behavior: source 2.
- Account existence can leak through message text, HTTP status, response timing, or another observable difference: sources 2 and 3.
- A generic message is necessary but not sufficient. The handler should follow a comparable code path and external response while preserving internal security telemetry: sources 2 and 3.

### Draft guardrails

- Do not cite the NIST maximum as a recommended default. It is an upper bound within a defined authenticator policy, and lower limits may be appropriate.
- Safe verification uses two owned test identities plus one synthetic nonexistent identity. Never enumerate third-party accounts.

## 24. `stripe-webhook-signature-security`

### Sources

1. **Primary or official:** Stripe, [Receive Stripe events in your webhook endpoint](https://docs.stripe.com/webhooks), rolling vendor documentation, accessed 2026-07-17.
2. **Primary or official:** Stripe, [Resolve webhook signature verification errors](https://docs.stripe.com/webhooks/signature), rolling vendor documentation, accessed 2026-07-17.
3. **Primary or official:** Stripe, [Stripe CLI webhook testing in the Webhooks guide](https://docs.stripe.com/webhooks#test-webhook), rolling vendor documentation, accessed 2026-07-17.

### Claim-to-source map

- Verify the event payload, `Stripe-Signature` header, and endpoint secret using Stripe's official library before executing business logic: source 1.
- Signature verification requires the unmodified raw request body. JSON parsing, whitespace changes, reserialization, or middleware order can break verification: sources 1 and 2.
- Stripe CLI forwarding uses a signing secret emitted by `stripe listen`; that secret is not interchangeable with a Dashboard-managed endpoint secret: sources 2 and 3.
- A valid signature establishes that Stripe signed the body under the endpoint secret. It does not prove that the event is new, in order, mapped to the correct internal account, or sufficient to grant access: source 1 establishes the signature boundary; topics 25 and 27 own the remaining claims.

### Draft guardrails

- Use Stripe's placeholder values only. Never publish a real endpoint secret.
- Keep signature authenticity separate from entitlement authorization and idempotency.

## 25. `payment-entitlement-server-source-truth`

### Sources

1. **Primary or official:** Stripe, [Entitlements](https://docs.stripe.com/billing/entitlements), rolling vendor documentation, accessed 2026-07-17.
2. **Primary or official:** Stripe, [Using webhooks with subscriptions](https://docs.stripe.com/billing/subscriptions/webhooks), rolling vendor documentation, accessed 2026-07-17.
3. **Primary or official:** MITRE, [CWE-602: Client-Side Enforcement of Server-Side Security](https://cwe.mitre.org/data/definitions/602.html), CWE 4.20, accessed 2026-07-17.

### Claim-to-source map

- Stripe Entitlements maps product features to active customer entitlements and documents both webhook updates and the API for retrieving the full active list: source 1.
- Subscription state changes asynchronously, so applications must handle lifecycle events and reconcile provider state rather than trust the browser's checkout result: source 2.
- Client-side controls can be bypassed. The protected server operation must enforce the authorization decision from trusted server state: source 3.
- A local entitlement record can improve availability and latency, but it needs a stable customer-to-account mapping, durable update handling, revocation behavior, and reconciliation after missed or delayed events: sources 1 and 2.

### Draft guardrails

- Do not imply that Stripe is the only possible entitlement system or that every plan maps one-to-one to a feature.
- Do not state that a signed webhook automatically grants the correct local user access.

## 26. `mass-assignment-crud-api`

### Sources

1. **Authoritative guidance:** OWASP, [API3:2023 Broken Object Property Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/), 2023 edition, accessed 2026-07-17.
2. **Primary or official:** MITRE, [CWE-915: Improperly Controlled Modification of Dynamically-Determined Object Attributes](https://cwe.mitre.org/data/definitions/915.html), CWE 4.20, accessed 2026-07-17.
3. **Authoritative guidance:** OWASP, [Mass Assignment Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html), rolling document, accessed 2026-07-17.
4. **Primary or official:** NestJS, [Validation](https://docs.nestjs.com/techniques/validation), rolling framework documentation, accessed 2026-07-17.

### Claim-to-source map

- Mass assignment occurs when client input is automatically bound to internal object properties without controlling which fields may change: sources 1, 2, and 3.
- The preferred fix is an operation-specific allowlist or DTO plus explicit server-owned values, not a broad object spread followed by a small denylist: sources 1 and 3.
- NestJS documents runtime DTO validation, stripping or rejecting non-whitelisted properties, and the fact that erased TypeScript interfaces cannot supply the runtime metadata required by its validation pipe: source 4.
- Runtime input validation and property-level authorization are both necessary. A field may have the correct type and still be forbidden for that caller to change: sources 1 and 4.
- Response shape also matters because API3:2023 combines unauthorized reading and modification of object properties. Keep the article's main example writable-field focused and link out rather than collapsing both topics: source 1.

### Draft guardrails

- TypeScript interfaces disappear at runtime and do not validate an HTTP body by themselves.
- Do not claim that stripping unknown keys protects known but unauthorized fields.

## 27. `idempotency-replay-protection`

### Sources

1. **Primary or official:** Stripe, [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), rolling API reference, accessed 2026-07-17.
2. **Primary or official:** Stripe, [Receive Stripe events in your webhook endpoint](https://docs.stripe.com/webhooks), rolling vendor documentation, accessed 2026-07-17.
3. **Primary standard:** IETF, [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html), June 2022.

### Claim-to-source map

- Stripe's API uses an idempotency key to return the stored result of a prior create or update request and detects reused keys with mismatched parameters: source 1.
- Webhook endpoints can receive duplicate events, and consumers should record processed event identifiers or object and event-type pairs where appropriate: source 2.
- An HTTP method is idempotent when multiple identical requests have the same intended effect as one. This semantic property does not automatically make an application's database side effects atomic: source 3.
- A robust handler uses a durable uniqueness boundary and the business mutation in one transaction or equivalent atomic unit. It stores enough request identity to reject key reuse with different input and defines expiry based on the replay window: sources 1 and 3 support the contract; the storage pattern is an engineering inference that must be labeled as such.

### Draft guardrails

- Do not present an in-memory set as sufficient for distributed or restart-safe processing.
- Explain out-of-order events separately from duplicate events. Idempotency does not impose ordering.

## 28. `security-headers-ai-built-apps`

### Sources

1. **Authoritative guidance:** OWASP, [Secure Headers Project](https://owasp.org/www-project-secure-headers/index.html), rolling project, accessed 2026-07-17.
2. **Primary standard:** W3C, [Content Security Policy Level 3](https://www.w3.org/TR/CSP/), Working Draft dated 2026-05-05.
3. **Primary standard:** IETF, [RFC 6797: HTTP Strict Transport Security](https://www.rfc-editor.org/rfc/rfc6797.html), November 2012.

### Claim-to-source map

- Security headers direct browser behavior and are defense in depth, not proof that application authorization, validation, or output handling is correct: source 1.
- CSP can be delivered in an enforcing response header or a report-only response header. The report-only form supports staged policy observation before enforcement: source 2.
- HSTS tells a user agent to use secure transport for a host after receiving the policy over HTTPS; deployment needs deliberate scope and lifetime choices: source 3.
- CSP `frame-ancestors`, MIME sniffing controls, and referrer policy solve different browser risks. A scanner should inspect values and context rather than award security merely because a header name exists: sources 1 and 2.

### Draft guardrails

- The W3C CSP Level 3 source is a Working Draft. Label it accurately.
- Do not recommend a copy-paste CSP that breaks the reader's application or treat `unsafe-inline` removal as a one-step change.

## 29. `secure-session-cookie-settings`

### Sources

1. **Primary standard:** IETF, [RFC 6265: HTTP State Management Mechanism](https://www.rfc-editor.org/rfc/rfc6265.html), April 2011.
2. **Authoritative guidance:** OWASP, [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), rolling document, accessed 2026-07-17.
3. **Primary platform documentation:** MDN, [Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie), rolling web-platform reference, accessed 2026-07-17.

### Claim-to-source map

- `Secure` limits cookie transmission to secure channels and `HttpOnly` withholds the cookie from script APIs, but neither attribute is a complete session defense: source 1.
- Restrict Domain and Path scope, rotate identifiers after privilege changes, expire sessions, and provide server-side invalidation: source 2.
- `SameSite` controls cross-site cookie sending; `None` requires `Secure`. Cookie name prefixes add enforceable combinations such as the host-only constraints of `__Host-`: source 3.
- Cookie attributes cannot prove that a server validates, rotates, revokes, or securely stores the associated session. The local inspector can flag header attributes only: sources 1 and 2 define that limitation.

### Draft guardrails

- RFC 6265 predates SameSite. Attribute-specific SameSite claims must cite source 3, not the older RFC.
- Do not say `HttpOnly` prevents all XSS impact or that `SameSite` replaces CSRF defenses in every flow.

## 30. `tls-mobile-transport-security`

### Sources

1. **Primary or official:** Apple, [Preventing Insecure Network Connections](https://developer.apple.com/documentation/security/preventing-insecure-network-connections), rolling platform documentation, accessed 2026-07-17.
2. **Primary or official:** Android Developers, [Cleartext communications](https://developer.android.com/privacy-and-security/risks/cleartext-communications), last updated page accessed 2026-07-17.
3. **Primary or official:** NIST, [SP 800-52 Rev. 2: Guidelines for the Selection, Configuration, and Use of TLS Implementations](https://csrc.nist.gov/pubs/sp/800/52/r2/final), August 2019.

### Claim-to-source map

- Apple ATS requires secure connections for standard URL loading APIs and permits explicit exceptions, but lower-level networking interfaces may fall outside ATS enforcement: source 1.
- Android Network Security Configuration can disallow cleartext traffic and scope exceptions, while some third-party clients may not honor every platform control: source 2.
- TLS configuration must use supported protocol versions, certificates, and cryptographic settings appropriate to the server and client environment: source 3.
- Release verification should search the release configuration for broad exceptions, test redirects and owned endpoints, and exercise the actual networking library. A web header check cannot inspect native transport policy: sources 1 and 2.

### Draft guardrails

- Do not imply that certificate pinning is mandatory for every app. Describe its operational costs and failure modes if mentioned.
- Keep development bypasses scoped to debug builds and named test domains.

## 31. `public-by-default-ai-apps`

### Sources

1. **Primary or official:** AWS, [Blocking public access to your Amazon S3 storage](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html), rolling vendor documentation, accessed 2026-07-17.
2. **Primary or official:** Supabase, [Securing your data](https://supabase.com/docs/guides/database/secure-data), rolling vendor documentation, accessed 2026-07-17.
3. **Primary or official:** Vercel, [Deployment Protection](https://vercel.com/docs/deployment-protection), last updated 2026-01-07.

### Claim-to-source map

- S3 Block Public Access applies controls at organization, account, bucket, and access-point levels, with the most restrictive applicable combination enforced: source 1.
- Supabase's frontend Data API model relies on RLS and least-privilege grants. Secret or service-role keys must not be exposed because they bypass RLS: source 2.
- Vercel documents authentication and other protection methods for preview and deployment URLs, and protection scope differs by environment and plan: source 3.
- `noindex`, obscurity, and an unlinked URL address discoverability, not authorization. Verification requires a logged-out request, a second authorized account where relevant, and provider-level permission review: sources 1 to 3 support the access-control boundary.

### Draft guardrails

- Do not state that every platform is public by default. Explain the specific configuration and the reader's responsibility to verify it.
- Do not include real private URLs, bucket names, tokens, or screenshots containing identifiers.

## 32. `debug-routes-error-leaks`

### Sources

1. **Authoritative guidance:** OWASP, [Error Handling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html), rolling document, accessed 2026-07-17.
2. **Primary or official:** MITRE, [CWE-209: Generation of Error Message Containing Sensitive Information](https://cwe.mitre.org/data/definitions/209.html), CWE 4.20, accessed 2026-07-17.
3. **Primary or official:** Pallets, [Flask Debugging Application Errors](https://flask.palletsprojects.com/en/stable/debugging/), current Flask documentation, accessed 2026-07-17.

### Claim-to-source map

- Unhandled errors can reveal framework versions, stack traces, internal paths, and other details useful for reconnaissance: sources 1 and 2.
- Production applications should map internal exceptions to stable public responses and retain detailed diagnostics in protected logs, with redaction applied before export: source 1.
- Flask explicitly warns that the built-in debugger can execute arbitrary Python code from the browser and must not be used in production even though it has a PIN: source 3.
- A correlation ID can connect a generic public error to internal diagnostics if it is random or otherwise non-sensitive and does not encode user or infrastructure data: source 1 supports generic responses; the ID design is an implementation inference that needs a limitation note.

### Draft guardrails

- Do not imply that generic errors repair the underlying vulnerability or replace monitoring.
- Keep static `.map` and package leakage in topic 33, even if source maps can enrich stack traces.

## 33. `source-map-build-artifact-security`

### Sources

1. **Primary or official:** Next.js, [`productionBrowserSourceMaps`](https://nextjs.org/docs/pages/api-reference/config/next-config-js/productionBrowserSourceMaps), last updated 2026-02-27.
2. **Primary or official:** Vite, [Build options, `build.sourcemap`](https://vite.dev/config/build-options#build-sourcemap), rolling vendor documentation, accessed 2026-07-17.
3. **Primary or official:** npm, [`package.json`, `files`](https://docs.npmjs.com/files/package.json#files), rolling vendor documentation, accessed 2026-07-17.

### Claim-to-source map

- Next.js disables production browser source maps by default and warns that enabling them serves map files beside client JavaScript, which can expose source: source 1.
- Vite distinguishes separate, inline, and hidden production source maps. Hidden maps omit the mapping comment but still create the map file, so access control and publication behavior remain separate questions: source 2.
- npm's `files` field is an allowlist for package contents, while omitting it defaults broadly. `npm pack --dry-run` should be used to inspect the actual tarball before publication: source 3, with the dry-run command verified against npm CLI behavior during drafting.
- Artifact review must inspect generated output and upload rules. Repository secret scanning alone cannot prove that bundler substitution, source content, or packaging did not place sensitive material in the shipped artifact: sources 1 to 3 establish the artifact boundary.

### Draft guardrails

- Do not say all production source maps are inherently unsafe. Private upload to a trusted error service can be a valid design if the public origin does not serve them.
- Keep runtime debug endpoints and stack-trace responses in topic 32.

## 34. `sensitive-data-logging`

### Sources

1. **Authoritative guidance:** OWASP, [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), rolling document, accessed 2026-07-17.
2. **Primary or official:** NIST, [SP 800-92: Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final), September 2006.
3. **Primary or official:** OpenTelemetry, [Handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/), last modified 2026-01-14.

### Claim-to-source map

- Access tokens, session identifiers, passwords, keys, connection strings, payment data, and sensitive personal data should usually not be recorded directly; remove, mask, sanitize, hash, or encrypt only when appropriate to the risk: source 1.
- Log systems need controlled generation, transmission, storage, access, retention, and disposal because logs can contain sensitive data and are themselves security targets: sources 1 and 2.
- OpenTelemetry places responsibility on the implementer to identify sensitive attributes and supports deletion, filtering, transformation, and allowlist-based redaction processors: source 3.
- Hashing a predictable identifier may remain reversible in practice. Prefer minimization or a keyed, scoped pseudonym when correlation is necessary, and document retention and access: source 3, with broader management from source 2.

### Draft guardrails

- Do not describe hashing as anonymization without qualification.
- The LyraShield local secret scanner detects selected patterns in chosen text files. It is not a complete PII classifier and should be used only on safe local copies.

## 35. `security-audit-log-design`

### Sources

1. **Authoritative guidance:** OWASP, [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), rolling document, accessed 2026-07-17.
2. **Primary or official:** NIST, [SP 800-53 Rev. 5: Security and Privacy Controls for Information Systems and Organizations](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final), Release 5.2.0 dated 2025-08-27.
3. **Primary or official:** NIST, [SP 800-92: Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final), September 2006.

### Claim-to-source map

- Security-relevant application events include authentication and authorization failures, administrative actions, privilege changes, key rotation, sensitive data access, configuration changes, and other business-logic abuse signals: source 1.
- NIST AU controls cover event selection, record content, storage capacity, failure handling, review, time stamps, protection, and audit record generation. An audit design must include operations, not only an event schema: source 2.
- Protect logs from unauthorized access, modification, and deletion; define retention and disposal; and maintain reliable collection and review processes: sources 1 and 3.
- A useful application audit event identifies actor, action, subject, scoped tenant or workspace, outcome, source, correlation, and trustworthy time without copying secrets or full user content. Tamper evidence can reveal modification but does not prevent deletion or guarantee that every event was emitted: sources 1 to 3 support the fields and protection boundary.

### Draft guardrails

- Do not equate an application debug log with an audit trail.
- Describe fail-closed behavior only for actions whose threat and availability model justifies it. For other actions, durable buffering plus an alert may be safer. State the tradeoff.

## Cross-article truth table

| Question                                                                    | Owning article                            | What the neighboring article does not prove                                                |
| --------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| How should costly or high-volume endpoints be bounded?                      | `rate-limiting-ai-apps`                   | Authentication response uniformity does not protect every resource endpoint.               |
| How should login guessing and identity disclosure be resisted?              | `brute-force-account-enumeration`         | A generic API rate limit does not make login and recovery responses indistinguishable.     |
| Did Stripe sign this exact body?                                            | `stripe-webhook-signature-security`       | A valid signature does not prove entitlement, freshness, ordering, or one-time processing. |
| May this user perform the paid operation now?                               | `payment-entitlement-server-source-truth` | Browser state and an authentic event are not the authorization decision at use time.       |
| Will retrying or concurrently delivering this operation change state twice? | `idempotency-replay-protection`           | Idempotency does not authenticate the sender or decide entitlement.                        |
| Did a runtime route or response reveal internals?                           | `debug-routes-error-leaks`                | Generic runtime errors do not remove files already shipped with the build.                 |
| Did a static build, package, or map expose private material?                | `source-map-build-artifact-security`      | Removing public maps does not disable debug routes or redact errors.                       |
| What sensitive values must stay out of telemetry?                           | `sensitive-data-logging`                  | Redaction alone does not create accountable audit coverage.                                |
| Which sensitive actions need a protected, reviewable record?                | `security-audit-log-design`               | An audit event schema does not make every field safe to collect.                           |

## Research concerns to carry into drafting

- Node.js API pages are rolling documentation. Examples must match the repository's supported runtime at draft time and should not claim identical behavior across platforms without a platform check.
- CSP Level 3 is a W3C Working Draft dated 2026-05-05. Use it for current syntax and behavior while labeling its status.
- NIST SP 800-92 is still useful published guidance, but it is older. Pair it with the current NIST SP 800-53 Rev. 5 controls and current OpenTelemetry guidance rather than treating it as a modern implementation recipe.
- Provider settings and plan boundaries can change. Stripe, Vercel, Supabase, AWS, Cloudflare, Apple, Android, Next.js, Vite, npm, and OpenTelemetry claims need a final link and material-change check immediately before publication.
- All claims about what LyraShield checks must be confirmed against the current code and public tool copy. This research pack does not authorize a claim that the passive Lite Check exercises filesystem, shell, payment, mobile transport, storage policy, or audit-log behavior.
