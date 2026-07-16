# Batch 1 source and claim review

Date: 2026-07-17
Status: source review complete, article-level technical review pending
Owner: LyraShield Team
Scope: topics 2 through 18

## Review method

Sources were checked against their official URLs on 2026-07-17. A source marked "living" has no stable publication date on the rendered page, so the access date is the exact review date and writers must recheck it before publication. RFC, OpenID, NIST, CWE, WSTG, and AWS whitepaper dates below use the version or publication date shown by the issuing body.

Community posts and search summaries are excluded from the claim maps. The maps identify the minimum evidence for each article, not every citation the final article may need. A writer must not turn OWASP risk language into a prevalence statistic or turn a vendor configuration statement into proof that a deployed application is safe.

## Source register

### Access control and secrets

- S01. Supabase, "Row Level Security." Living documentation, accessed 2026-07-17. https://supabase.com/docs/guides/database/postgres/row-level-security
- S02. Supabase, "Securing your API." Living documentation, accessed 2026-07-17. https://supabase.com/docs/guides/api/securing-your-api
- S03. PostgreSQL Global Development Group, "Row Security Policies." Current-version documentation, accessed 2026-07-17. https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- S04. OWASP API Security Project, "API1:2023 Broken Object Level Authorization." 2023 edition, accessed 2026-07-17. https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/
- S05. MITRE, "CWE-639: Authorization Bypass Through User-Controlled Key." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/639.html
- S06. OWASP Web Security Testing Guide, "Testing for Insecure Direct Object References." Stable WSTG v4.2, accessed 2026-07-17. https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/05-Authorization_Testing/04-Testing_for_Insecure_Direct_Object_References
- S07. OWASP Cheat Sheet Series, "Secrets Management Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- S08. Vite, "Env Variables and Modes." Living official documentation, accessed 2026-07-17. https://vite.dev/guide/env-and-mode
- S09. Next.js, "Environment Variables." Official documentation, accessed 2026-07-17. https://nextjs.org/docs/pages/guides/environment-variables
- S10. GitHub, "Push protection." Living official documentation, accessed 2026-07-17. https://docs.github.com/en/code-security/concepts/secret-security/push-protection
- S11. MITRE, "CWE-602: Client-Side Enforcement of Server-Side Security." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/602.html
- S12. OWASP Cheat Sheet Series, "Authorization Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- S13. MDN, "Web Storage API." Last modified 2025-02-22, accessed 2026-07-17. https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API
- S14. OWASP API Security Project, "API5:2023 Broken Function Level Authorization." 2023 edition, accessed 2026-07-17. https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/
- S15. MITRE, "CWE-862: Missing Authorization." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/862.html
- S16. Amazon Web Services, "Tenant isolation," SaaS Architecture Fundamentals. Living official whitepaper page, accessed 2026-07-17. https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html
- S17. Amazon Web Services, "Multi-tenant SaaS authorization and API access control." Living Prescriptive Guidance, accessed 2026-07-17. https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/introduction.html
- S18. OWASP Web Security Testing Guide, "API Broken Function Level Authorization." Living latest guidance, accessed 2026-07-17. https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/12-API_Testing/04-API_Broken_Function_Level_Authorization

### Authentication and password handling

- S19. IETF, "RFC 8725: JSON Web Token Best Current Practices." Published 2020-02. https://www.rfc-editor.org/rfc/rfc8725.html
- S20. IETF, "RFC 7519: JSON Web Token (JWT)." Published 2015-05. https://www.rfc-editor.org/rfc/rfc7519.html
- S21. OpenID Foundation, "OpenID Connect Core 1.0 incorporating errata set 2." Published 2023-12-15. https://openid.net/specs/openid-connect-core-1_0.html
- S22. Supabase, "JSON Web Tokens." Living official documentation, accessed 2026-07-17. https://supabase.com/docs/guides/auth/jwts
- S23. OWASP Cheat Sheet Series, "Forgot Password Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- S24. OWASP Cheat Sheet Series, "Email Validation and Verification Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html
- S25. NIST, "SP 800-63B-4: Authentication and Authenticator Management." Published 2025-07; HTML updated 2025-08-26. https://pages.nist.gov/800-63-4/sp800-63b.html
- S26. OWASP Cheat Sheet Series, "Authentication Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- S27. OWASP Cheat Sheet Series, "Password Storage Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- S28. IRTF, "RFC 9106: Argon2 Memory-Hard Function for Password Hashing and Proof-of-Work Applications." Published 2021-09. https://www.rfc-editor.org/rfc/rfc9106.html
- S29. NIST, "SP 800-132: Recommendation for Password-Based Key Derivation." Published 2010-12. https://csrc.nist.gov/pubs/sp/800/132/final

### Injection, output, and request validation

- S30. OWASP Cheat Sheet Series, "SQL Injection Prevention Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
- S31. MITRE, "CWE-89: Improper Neutralization of Special Elements used in an SQL Command." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/89.html
- S32. PostgreSQL Global Development Group, "Parameterized Statements." Current libpq documentation, accessed 2026-07-17. https://www.postgresql.org/docs/current/libpq-exec.html#LIBPQ-PQEXECPARAMS
- S33. OWASP Cheat Sheet Series, "Query Parameterization Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Query_Parameterization_Cheat_Sheet.html
- S34. OWASP Cheat Sheet Series, "Cross Site Scripting Prevention Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- S35. OWASP Cheat Sheet Series, "DOM based XSS Prevention Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
- S36. MDN, "Element: innerHTML property." Living documentation, accessed 2026-07-17. https://developer.mozilla.org/en-US/docs/Web/API/Element/innerHTML
- S37. MITRE, "CWE-79: Improper Neutralization of Input During Web Page Generation." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/79.html
- S38. OWASP Cheat Sheet Series, "Input Validation Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- S39. MITRE, "CWE-20: Improper Input Validation." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/20.html
- S40. JSON Schema, "A Media Type for Describing JSON Documents." Draft 2020-12 specification, accessed 2026-07-17. https://json-schema.org/draft/2020-12/json-schema-core

### Browser request controls

- S41. WHATWG, "Fetch Standard," CORS protocol and credentials. Living standard, accessed 2026-07-17. https://fetch.spec.whatwg.org/#http-cors-protocol
- S42. MDN, "Cross-Origin Resource Sharing (CORS)." Living documentation, accessed 2026-07-17. https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
- S43. OWASP Cheat Sheet Series, "HTML5 Security Cheat Sheet," Cross Origin Resource Sharing. Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#cross-origin-resource-sharing
- S44. OWASP Web Security Testing Guide, "Testing Cross Origin Resource Sharing." Living latest guidance, accessed 2026-07-17. https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/07-Testing_Cross_Origin_Resource_Sharing
- S45. OWASP Cheat Sheet Series, "Cross-Site Request Forgery Prevention Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- S46. W3C, "Fetch Metadata Request Headers." Working Draft, published 2025-04-01. https://www.w3.org/TR/fetch-metadata/
- S47. MDN, "Set-Cookie header." Living documentation, accessed 2026-07-17. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- S48. MITRE, "CWE-352: Cross-Site Request Forgery." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/352.html

### Network fetches and uploads

- S49. OWASP Cheat Sheet Series, "Server Side Request Forgery Prevention Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- S50. MITRE, "CWE-918: Server-Side Request Forgery." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/918.html
- S51. Node.js, "DNS." Current v26.5.0 documentation, accessed 2026-07-17. https://nodejs.org/api/dns.html
- S52. Amazon Web Services, "Use the Instance Metadata Service to access instance metadata." Living EC2 documentation, accessed 2026-07-17. https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html
- S53. OWASP Cheat Sheet Series, "File Upload Cheat Sheet." Living guidance, accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- S54. MITRE, "CWE-434: Unrestricted Upload of File with Dangerous Type." CWE 4.20, 2026-04-30. https://cwe.mitre.org/data/definitions/434.html
- S55. OWASP ASVS 5.0, "V5.2 File Upload and Content." ASVS 5.0 taxonomy, accessed 2026-07-17. https://cornucopia.owasp.org/taxonomy/asvs-5.0/05-file-handling/02-file-upload-and-content
- S56. MDN, "Content-Disposition header." Last modified 2026-06-22, accessed 2026-07-17. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition

## Claim-to-source maps

### Topic 2: `supabase-rls-vibe-coded-apps`

- Exposed Supabase Data API tables need grants and RLS; they are distinct layers. Evidence: S01, S02.
- With RLS enabled and no applicable policy, PostgreSQL applies default deny to normal row access. Table owners and roles with `BYPASSRLS` require separate attention. Evidence: S03.
- `USING` controls which existing rows can be seen or targeted, while `WITH CHECK` controls rows produced by inserts and updates. Evidence: S01, S03.
- A publishable or legacy `anon` key is designed for client use only when database policies enforce access. Supabase secret and `service_role` keys bypass RLS and stay on trusted servers. Evidence: S01, S02.
- Safe verification: use two dedicated test accounts and test select, insert, update, and delete on test rows. Do not infer deployed safety from pasted SQL. Evidence basis: S01, S04.
- Caution: do not claim `FORCE ROW LEVEL SECURITY` affects superusers or `BYPASSRLS` roles. S03 describes the exceptions.

### Topic 3: `idor-ai-built-apps`

- IDOR or BOLA occurs when a request-controlled object reference reaches a resource without an object-level permission decision. Evidence: S04, S05, S06.
- Authentication and endpoint access do not establish permission for the requested object. Evidence: S04, S12.
- Random identifiers can reduce guessing but are not an authorization control. Evidence: S04.
- Safe verification: create two owned test objects under two test accounts, replay only against the local or authorized test environment, and test read and mutation paths. Evidence: S06.
- Corrected pattern: include the current user or tenant predicate in the resource lookup and return no object outside that scope. Evidence: S04, S05.
- Automation limit: a scanner can observe identifier changes and response differences, but custom ownership and delegation rules require application context. Evidence: S04, S06.

### Topic 4: `api-keys-frontend-ai-apps`

- Vite `VITE_` variables and Next.js `NEXT_PUBLIC_` variables are compiled into browser-delivered code. Evidence: S08, S09.
- Browser-side values cannot be made secret by minification, environment files, or obscured UI. This is an architecture fact, not a claim that every public identifier is dangerous. Evidence: S08, S09.
- Supabase publishable keys are public component identifiers, while secret and `service_role` keys are privileged and must not be used in browsers. Evidence: S01, S02.
- A detected privileged credential must be revoked or rotated; removing it from the current file does not invalidate it or remove prior copies. Evidence: S07, S10.
- Prevention includes server-side provider calls, least-privilege credentials, secret scanning, and controlled rotation. Evidence: S07, S10.
- Caution: distinguish a provider's intentionally publishable client key from a secret. Do not tell readers to hide all Supabase publishable keys.

### Topic 5: `client-side-auth-not-security`

- Client-side access checks are bypassable and must not be decisive for resource access. Evidence: S11, S12.
- Browser storage belongs to the origin and is readable by scripts in that origin; its contents are state, not a trustworthy server authorization decision. Evidence: S13, S11.
- Hiding routes and buttons can improve user experience but does not protect the underlying server operation. Evidence: S12, S15.
- Safe verification: use an ordinary test account and call the authorized test endpoint directly without altering production data. Evidence basis: S11, S12.
- Corrected pattern: resolve the server-side principal and enforce the action and resource policy before the operation. Evidence: S12, S15.
- Caution: do not reduce this article to token storage. Its primary issue is enforcement location.

### Topic 6: `server-side-authorization-ai-apis`

- Authentication answers who the caller is; authorization still decides whether that caller may perform this action on this resource. Evidence: S12, S15.
- Sensitive API functions should deny by default and invoke consistent authorization checks across business functions. Evidence: S12, S14.
- Object-level and function-level authorization are different failure modes and both require tests. Evidence: S04, S14.
- Corrected pattern: pass the authenticated principal and server-resolved tenant into one policy function, then constrain data access or the business action. Evidence basis: S12, S15.
- Safe verification: maintain a role-action-resource matrix and negative tests for anonymous, ordinary, wrong-tenant, and privileged test identities. Evidence: S12, S18.
- Automation limit: tools can detect missing common middleware patterns, but custom business permission correctness requires manual and negative-test review. Evidence: S15.

### Topic 7: `multi-tenant-data-isolation`

- Tenant isolation is an explicit boundary beyond ordinary authentication and authorization; an authenticated user can still be routed to another tenant's resource. Evidence: S16, S17.
- Pooled and siloed resources need isolation appropriate to each storage and execution surface. Evidence: S16.
- Server-owned tenant context must scope APIs, database queries, jobs, caches, and object stores. Evidence basis: S16, S17.
- PostgreSQL RLS can enforce database row boundaries but does not cover caches, queues, file stores, or server code that bypasses RLS. Evidence: S03, S16.
- Safe verification: use two authorized test tenants and exercise synchronous plus background operations, including cache and export paths. Evidence basis: S16, S17.
- Caution: do not claim one `workspaceId` predicate proves system-wide isolation.

### Topic 8: `secure-admin-routes`

- A normal user reaching an administrative function is broken function-level authorization even if the route name is obscure. Evidence: S14, S18.
- Changing the HTTP method or guessing an endpoint must not change the policy result. Evidence: S14.
- A shared authorization module and default-deny role checks reduce scattered route-specific omissions. Evidence: S12, S14.
- Safe verification: inventory privileged actions and invoke them using an ordinary test account in an authorized environment. Evidence: S18.
- Corrected pattern: bind privileged routes and services to the same server-side policy, with step-up authentication only where the risk model requires it. Evidence basis: S12, S15.
- Caution: VPN placement and hidden navigation are defense layers, not proof of application authorization.

### Topic 9: `jwt-validation-mistakes`

- Base64URL decoding reveals claims but does not verify token integrity or acceptability. Evidence: S20.
- JWT consumers need an explicit algorithm allowlist and must validate cryptographic operations. Evidence: S19.
- Issuer and audience validation prevent accepting a valid token minted for the wrong trust domain or recipient. Evidence: S19, S21.
- Token-type-specific rules and separate validation profiles reduce cross-JWT confusion. Evidence: S19.
- Expiration and other time claims are part of validation but do not replace signature, issuer, audience, and application session decisions. Evidence: S19, S20, S21.
- Tool boundary: the local JWT Inspector only decodes and reports claim signals. It does not possess the signing key or validate revocation. Evidence basis: S19, S22.

### Topic 10: `password-reset-email-verification-security`

- Reset requests should use consistent messages and processing behavior to reduce account enumeration. Evidence: S23, S26.
- Reset and verification tokens must be random, time-limited, single-use, securely stored, and invalidated after use. Evidence: S23, S24.
- Reset URLs should use a configured trusted origin rather than an untrusted Host header and should avoid referrer leakage. Evidence: S23.
- A completed reset should notify the user and make an explicit decision about existing sessions; automatic login adds session complexity. Evidence: S23.
- Email ownership verification does not make email a strong authentication factor. Evidence: S24, S25.
- Caution: do not prescribe one universal token lifetime. The final article should state the risk and operational basis for choosing it.

### Topic 11: `password-hashing-vibe-coders`

- Passwords should be stored with a password-specific, adaptive hashing scheme rather than plaintext, reversible encryption, or a fast general hash. Evidence: S27, S25.
- OWASP currently recommends Argon2id for new applications where available and provides deployment baselines; RFC 9106 specifies Argon2 and test vectors. Evidence: S27, S28.
- Each password verifier needs a salt; maintained libraries normally manage salt encoding and verification. Evidence: S27.
- A pepper is separate defense-in-depth key material and needs its own storage and rotation plan. Evidence: S27.
- Work factors must be measured against the deployment and upgraded over time; successful login can trigger rehash. Evidence: S27, S25.
- Caution: NIST SP 800-63B-4 points to approved password hashing guidance. It does not mandate the exact OWASP Argon2id parameters for every service.

### Topic 12: `sql-injection-ai-generated-code`

- String concatenation that mixes untrusted data with SQL syntax enables the database to reinterpret data as code. Evidence: S30, S31.
- Prepared statements with bound values separate SQL structure from values. Evidence: S30, S32, S33.
- SQL identifiers such as table names, columns, and sort directions usually cannot be treated as ordinary bound values; map them from a fixed allowlist. Evidence basis: S30.
- Stored procedures are not automatically safe if they construct dynamic SQL internally. Evidence: S30, S31.
- Safe verification: unit-test the query-building function and use an isolated test database with harmless boundary strings. Do not provide payloads for a named target. Evidence basis: S30, S33.
- Caution: input validation and least-privilege roles add layers but do not replace parameterization.

### Topic 13: `xss-ai-app-markdown-output`

- Model output and Markdown are untrusted data when they can contain user-influenced content. The renderer's output context determines the XSS risk. Evidence basis: S34, S37.
- `innerHTML` is an injection sink; `textContent` is appropriate when rich HTML is not required. Evidence: S36.
- Output encoding is context-specific, while rich HTML requires a maintained sanitizer and restricted renderer configuration. Evidence: S34, S35.
- Trusted Types can constrain dangerous DOM sinks where supported, but it still depends on a trustworthy policy and sanitizer. Evidence: S34, S36.
- CSP is defense in depth and should not be described as the primary fix for unsafe rendering. Evidence: S34.
- Safe verification: use inert local test strings that prove whether tags or event attributes survive the pipeline, without publishing a deployable payload against a real application.

### Topic 14: `input-validation-ai-generated-api`

- Server-side validation should cover type, length, range, syntax, unknown fields, and business consistency before application processing. Evidence: S38, S39.
- Client validation improves feedback but is bypassable and must not be the security boundary. Evidence: S38, S11.
- Allowlist validation defines expected input; denylists alone are incomplete. Evidence: S38, S39.
- JSON Schema can describe structural constraints, but application-specific invariants and authorization still require separate code. Evidence: S40, S39.
- Input validation, output encoding, and interpreter-safe parameterization solve different problems. Evidence: S39, S30, S34.
- Caution: CWE-20 warns against using "input validation" as a catch-all when a more specific root cause such as output encoding or query construction applies.

### Topic 15: `cors-vibe-coded-apps`

- CORS is a browser protocol for deciding whether script can read a cross-origin response. It is not server authentication. Evidence: S41, S42.
- Credentialed responses cannot use wildcard `Access-Control-Allow-Origin`; use an exact allowed origin and the corresponding credentials policy. Evidence: S41, S42.
- Dynamically selected origins require an explicit allowlist and `Vary: Origin` to keep caches from mixing policies. Evidence: S42.
- Blindly reflecting the request Origin or applying CORS to every route can expose sensitive browser-readable responses. Evidence: S43, S44.
- Safe verification: inspect preflight and actual responses from allowed and disallowed test origins. The local Headers Checker observes only pasted responses and cannot exercise the full matrix. Evidence: S42, S44.
- Caution: non-browser clients can send Origin-like headers, so application authorization must remain independent.

### Topic 16: `csrf-cookie-auth-ai-apps`

- A valid ambient session cookie does not show that the user intended a state-changing request. Evidence: S45, S48.
- Framework CSRF protection or a correct synchronizer or signed double-submit token pattern should protect state-changing requests. Evidence: S45.
- SameSite cookies reduce some cross-site sends but are defense in depth, with behavior depending on the selected value and request context. Evidence: S47, S45.
- Fetch Metadata can help reject cross-site requests based on browser-supplied context, with rollout and compatibility considerations. Evidence: S46, S45.
- GET, HEAD, and OPTIONS should not perform state changes. Evidence: S45, S48.
- Caution: XSS can undermine CSRF defenses, and bearer-token APIs have a different ambient-credential threat model.

### Topic 17: `ssrf-protection-dns-redirects`

- SSRF occurs when attacker-influenced network destinations cause a server to reach unintended resources. Evidence: S49, S50.
- String validation alone is insufficient when DNS answers, IPv4 and IPv6 forms, and redirects can change the effective destination. Evidence: S49, S50.
- A robust design resolves and classifies all candidate addresses, constrains protocols and ports, controls redirects, and binds the approved result to the connection. Evidence basis: S49, S51.
- Network egress controls limit impact when application checks fail. Evidence: S49.
- IMDSv2 is a cloud defense layer and can be required on EC2, but it does not make arbitrary outbound fetches safe. Evidence: S52.
- Safe verification: use local fixtures that resolve to controlled public and private test addresses. Do not scan private networks or cloud metadata in a real environment without authorization.

### Topic 18: `secure-file-uploads-ai-apps`

- Browser-supplied filenames, extensions, and MIME declarations are untrusted metadata. Evidence: S53, S54, S56.
- Safe acceptance combines an extension allowlist with content validation, size limits, and content-specific handling such as image rewriting where appropriate. Evidence: S53, S55.
- Generate storage names on the server and keep uploads outside an executable web root or behind a controlled delivery path. Evidence: S53, S54.
- Quarantine and malware scanning can reduce risk but do not prove a file is harmless or suitable for every downstream parser. Evidence basis: S53, S55.
- `Content-Disposition` filenames need path stripping and must not control server storage paths. Evidence: S56.
- Safe verification: use tiny inert fixtures with mismatched extension, declared type, magic bytes, and size boundaries. Do not include executable web shells or destructive archives.

## Cross-article research risks

1. Supabase key terminology is changing. Current documentation distinguishes publishable and secret keys from legacy `anon` and `service_role` JWT keys. Writers must use both names carefully and recheck S01 and S02 before publication.
2. Browser and framework documentation is living guidance. Vite, Next.js, MDN, and WHATWG claims must be rechecked during final citation review.
3. PostgreSQL RLS has important bypass cases, policy-combination rules, and race considerations. Short examples must not imply that one ownership policy covers privileged roles or every command.
4. Password recommendations evolve. Preserve the NIST publication version and recheck OWASP's current parameter guidance instead of presenting a timeless universal setting.
5. SSRF guidance is transport-specific. A generic URL regex is not an acceptable corrected pattern, and app-layer validation cannot replace egress control.
6. Automated checks remain bounded. The final articles must not call a static observation independently verified, retest-confirmed, or proof of application security.

## Completeness summary

- Articles covered: 17 of 17.
- Source records: 56.
- Minimum sources per article: 4.
- Articles with at least two primary or official sources: 17 of 17.
- Authority links fixed: 17 of 17.
- Tool or scan CTAs fixed: 17 of 17.
- Related release dependencies fixed: 17 of 17.
- FAQ decisions fixed: 17 of 17.
- Image cluster concepts fixed: 17 of 17.
