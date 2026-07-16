# Batch 4 claim-to-source research

Research date: 2026-07-17
Research status: complete for briefing, re-verification required during drafting
Scope: topics 53 through 68

## Source standard

Vendor behavior comes from official product or framework documentation. OWASP material is used for platform-independent security reasoning. Vendor marketing claims, plan availability, UI labels, and automatically applied controls are not treated as proof that a particular application is secure. Every article must open each linked source again on its material-update date and record any changed behavior.

## Shared authoritative sources

- `OWASP-AUTHZ`: [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html). Use for deny-by-default, least privilege, and per-request authorization.
- `OWASP-SECRETS`: [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html). Use for storage, rotation, scope, and exposure response.
- `OWASP-PROMPT`: [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html). Use for untrusted repository content and tool-capable agents.
- `OWASP-XSS`: [OWASP Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html). Use for output context, sanitization, and unsafe DOM sinks.
- `OWASP-SSRF`: [OWASP Server Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). Use for outbound URL validation and redirect policy.
- `OWASP-API`: [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/). Use for object authorization, resource consumption, and unsafe API consumption.

## 53. `claude-code-security-workflow`

### Official sources

1. `CLAUDE-SEC`: [Claude Code security](https://code.claude.com/docs/en/security), accessed 2026-07-17.
2. `CLAUDE-PERM`: [Configure permissions](https://code.claude.com/docs/en/permissions), accessed 2026-07-17.
3. `CLAUDE-CLI`: [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), accessed 2026-07-17. This legacy Anthropic URL remained live in the research pass.
4. `OWASP-PROMPT`: shared source above.

Source count: 4, including 3 official product sources.

### Claim map

- Claim: Claude Code separates model instructions from enforced permissions. Permission rules are enforced by Claude Code, and prompt files do not grant or revoke access. Source: `CLAUDE-PERM`.
- Claim: Read operations within the working directory are available by default, while Bash and file modifications have different approval behavior. Saved Bash approvals can persist per repository. Source: `CLAUDE-PERM`.
- Claim: The supported modes include manual/default, accept edits, plan, auto, dontAsk, and bypassPermissions, with bypass use intended only for isolated environments. Source: `CLAUDE-PERM`. Recheck exact mode names and version notes during drafting.
- Claim: Claude Code documents workspace boundaries, Bash sandboxing, network approval, first-use trust checks, and explicit user responsibility for reviewing proposed commands and code. Source: `CLAUDE-SEC`.
- Claim: New MCP servers and untrusted content introduce tool and prompt-injection risk. Anthropic does not security-audit or manage every MCP server. Sources: `CLAUDE-SEC`, `OWASP-PROMPT`.
- Claim: `--dangerously-skip-permissions` exists and should not be presented as an ordinary developer default. Source: `CLAUDE-CLI`.

### Safe example and verification direction

Use a fictitious repository with no real credentials. Show a reviewed project settings fragment that denies deployment and credential commands, then demonstrate a plan-only pass, diff review, unit tests, and a separate human deployment step. Do not provide a bypass-permissions recipe connected to a real cloud account.

### Limits and recheck notes

The product's sandbox and mode behavior is changing quickly. Recheck permission mode names, saved-rule scope, workspace read behavior, sandbox enablement, and cloud versus local execution on the final review date. A passing test suite does not prove that every authorization path or deployed configuration is secure.

## 54. `codex-security-workflow`

### Official sources

1. `CODEX-APPROVALS`: [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security), accessed 2026-07-17.
2. `CODEX-CONFIG`: [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), accessed 2026-07-17.
3. `CODEX-MCP`: [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), accessed 2026-07-17.
4. `CODEX-NET`: [Agent internet access for Codex cloud](https://learn.chatgpt.com/docs/cloud/internet-access), accessed 2026-07-17.

Source count: 4, all official OpenAI documentation.

### Claim map

- Claim: Codex uses two distinct controls, sandbox capability and approval policy. One controls what can be done technically, and the other controls when execution pauses for review. Source: `CODEX-APPROVALS`.
- Claim: Local execution uses an OS-enforced sandbox and network access is off by default in the documented secure operation model. Source: `CODEX-APPROVALS`. Recheck defaults by surface because desktop, CLI, IDE, and cloud may differ.
- Claim: `sandbox_mode` currently supports read-only, workspace-write, and danger-full-access, while outbound network access can be configured for workspace-write. Source: `CODEX-CONFIG`.
- Claim: `approval_policy` supports interactive and non-interactive behaviors, including granular categories, and does not itself narrow the sandbox. Source: `CODEX-CONFIG`.
- Claim: Project trust can skip project-scoped configuration for untrusted repositories. Shell environment inheritance and exclusions can reduce credential exposure to subprocesses. Source: `CODEX-CONFIG`.
- Claim: MCP configuration supports per-server enabled and disabled tool lists, timeouts, approval modes, and environment-backed bearer tokens. Source: `CODEX-MCP`.
- Claim: Cloud internet access is a separate configuration surface and should be allowlisted for the task rather than enabled broadly. Source: `CODEX-NET`.

### Safe example and verification direction

Use a non-production repository and a minimal `config.toml` example with workspace-only writes, no outbound network, restricted environment inheritance, and one read-only MCP tool. Verify with `git diff`, focused tests, secret scanning, and an explicit release checklist. Do not claim a configuration excerpt matches every Codex surface.

### Limits and recheck notes

OpenAI moved Codex documentation to ChatGPT Learn during this research period, and configuration fields are evolving. Recheck accepted enum values, permission profiles, auto-review behavior, project trust, and network defaults before drafting. Do not equate Codex Security product output with independent verification of the application.

## 55. `windsurf-security-workflow`

### Official sources

1. `WINDSURF-MCP`: [Cascade Model Context Protocol integration](https://docs.devin.ai/desktop/cascade/mcp), accessed 2026-07-17. The old Windsurf URL redirected here.
2. `WINDSURF-ADMIN`: [Windsurf guide for admins](https://docs.devin.ai/windsurf/plugins/guide-for-admins), accessed 2026-07-17.
3. `OWASP-PROMPT`: shared source above.

Source count: 3, including 2 official product sources.

### Claim map

- Claim: Windsurf and Cascade documentation is now served within Devin Desktop documentation, so current product labels must be verified rather than copied from older Windsurf guides. Sources: `WINDSURF-MCP`, `WINDSURF-ADMIN`.
- Claim: Cascade can connect to stdio, HTTP, and SSE MCP servers, and teams can use registries or allowlists to constrain available servers. Source: `WINDSURF-MCP`.
- Claim: Users can enable or disable individual MCP tools, and MCP configuration can interpolate credentials from environment variables or files instead of hardcoding values. Source: `WINDSURF-MCP`.
- Claim: An official marketplace badge identifies the parent service company but is not stated to be a complete application security audit. Source: `WINDSURF-MCP`. Phrase this conservatively.
- Claim: Team controls include identity, roles, feature controls, and administrative policy. Source: `WINDSURF-ADMIN`.
- Claim: Repository instructions and tool output can carry untrusted instructions, so terminal or MCP capability should be bounded independently of the prompt. Source: `OWASP-PROMPT` plus the product control model.

### Safe example and verification direction

Show a threat inventory for terminal execution, MCP servers, and repository writes, followed by a branch-based review workflow. Use redacted placeholder environment variables. Avoid publishing a real token-bearing `mcp_config.json` or encouraging unrestricted terminal auto-execution.

### Limits and recheck notes

This is the fastest-changing topic in the batch. Recheck brand naming, documentation paths, terminal auto-execution levels, configuration filenames, MCP marketplace terminology, admin allowlist behavior, and product availability immediately before drafting and again before publication.

## 56. `lovable-app-security-checklist`

### Official sources

1. `LOVABLE-BEST`: [Security best practices for Lovable apps](https://docs.lovable.dev/tips-tricks/security-best-practices), accessed 2026-07-17.
2. `LOVABLE-SEC`: [Lovable security overview](https://docs.lovable.dev/features/security), accessed 2026-07-17.
3. `SUPABASE-RLS`: [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), accessed 2026-07-17.
4. `OWASP-AUTHZ`: shared source above.

Source count: 4, including 3 official vendor sources.

### Claim map

- Claim: Lovable describes the frontend as public and untrusted, Edge Functions as the server-side boundary for sensitive logic, and PostgreSQL RLS as the database access boundary. Source: `LOVABLE-BEST`.
- Claim: Secrets must not be stored in frontend code, and sensitive external API calls should run through server-side functions. Source: `LOVABLE-BEST`.
- Claim: Frontend validation improves UX but is not an access-control boundary. Authentication, authorization, input validation, and important business rules should be enforced server-side. Sources: `LOVABLE-BEST`, `OWASP-AUTHZ`.
- Claim: Lovable's Basic scan and Deep scan have different documented coverage, and the documentation explicitly says these tools do not replace a thorough review or guarantee complete security. Source: `LOVABLE-SEC`.
- Claim: Publishing can proceed with unresolved issues unless workspace policy blocks it, so the article must describe review and release decisions separately from scan execution. Source: `LOVABLE-SEC`. Recheck current publishing controls.
- Claim: RLS must be enabled for exposed Supabase tables and tested for each role and operation. Source: `SUPABASE-RLS`.

### Safe example and verification direction

Use a fictitious `projects` table and two test accounts. Show an ownership policy and negative test sequence without connecting to a real project. Clearly label any SQL as illustrative and include the limitation that the local RLS checker does not inspect deployed grants, schema, or policy semantics.

### Limits and recheck notes

Recheck scan names, scan coverage, automatic-fix eligibility, publishing blocks, workspace visibility controls, and database integration behavior. Never repeat the vendor's scan output as proof that an issue is exploitable or completely remediated.

## 57. `bolt-app-security-checklist`

### Official sources

1. `BOLT-SECRETS`: [Bolt database secrets settings](https://support.bolt.new/cloud/database/secrets), accessed 2026-07-17.
2. `BOLT-TABLES`: [Bolt database tables](https://support.bolt.new/cloud/database/tables), accessed 2026-07-17.
3. `BOLT-INTEGRATIONS`: [Bolt integration troubleshooting](https://support.bolt.new/troubleshooting/integrations-issues), accessed 2026-07-17.
4. `BOLT-DB`: [Bolt database overview](https://support.bolt.new/cloud/database), accessed 2026-07-17.
5. `SUPABASE-RLS`: Supabase source above.
6. `BOLT-RELEASES`: [Bolt release notes](https://support.bolt.new/release-notes), accessed 2026-07-17.

Source count: 6, all official vendor documentation.

### Claim map

- Claim: Bolt supports its own database surface and Supabase integration, so a secure review begins by identifying the actual backend and environment. Sources: `BOLT-DB`, `BOLT-INTEGRATIONS`.
- Claim: Secrets are intended for server functions and should not be stored in plain source. Source: `BOLT-SECRETS`.
- Claim: Bolt exposes table policy review and a Security Audit surface, but policy behavior still needs direct negative testing. Sources: `BOLT-TABLES`, `SUPABASE-RLS`.
- Claim: CORS, JWT expectations, webhook signatures, and external API secrets are separate controls at server-function boundaries. Source: `BOLT-INTEGRATIONS`.
- Claim: A third-party webhook without the app's JWT must not simply be left unauthenticated; it needs the provider's signature or another documented verification mechanism. Source: `BOLT-INTEGRATIONS`.
- Claim: Publish behavior, project sharing, site visibility, and automatic security review have changed recently. Source: `BOLT-RELEASES`, but final copy must verify the current dedicated docs rather than relying on changelog summaries.

### Safe example and verification direction

Use a fake webhook with a placeholder signature header and a two-account table test. Do not instruct readers to disable JWT verification without immediately adding provider-specific verification. Verify CORS at the actual deployed origin, not only in the editor preview.

### Limits and recheck notes

Recheck whether a project uses Bolt Database or Supabase, current site visibility options, publish-time review behavior, server-function terminology, and policy UI. The official troubleshooting page includes broad CORS examples; the article must not recommend wildcard CORS for credentialed production traffic.

## 58. `replit-app-security-checklist`

### Official sources

1. `REPLIT-SECRETS`: [Replit Secrets](https://docs.replit.com/core-concepts/project-editor/app-setup/secrets), accessed 2026-07-17.
2. `REPLIT-CHECK`: [Replit security checklist](https://docs.replit.com/learn/security-checklist), accessed 2026-07-17.
3. `REPLIT-PRIVACY`: [Enterprise privacy settings](https://docs.replit.com/teams/enterprise-privacy-settings), accessed 2026-07-17.
4. `REPLIT-PUBLISH`: [Publishing troubleshooting](https://docs.replit.com/build/troubleshooting), accessed 2026-07-17.

Source count: 4, all official Replit documentation.

### Claim map

- Claim: Replit Secrets are encrypted environment values, but application code and collaborators with execution capability may still cause a value to be printed or transmitted. Source: `REPLIT-SECRETS`.
- Claim: Static deployments do not support server-side behavior such as API routes, auth callbacks, or database calls from a server. Source: `REPLIT-PUBLISH`.
- Claim: Preview and publication can differ in secrets, callback URLs, ports, storage, and network behavior. Source: `REPLIT-PUBLISH`.
- Claim: Replit's own checklist recommends server-side endpoint authentication, authorization, input handling, secure cookies, headers, rate limits, and keeping secrets out of browser storage. Source: `REPLIT-CHECK`.
- Claim: Enterprise controls can require private development URLs, private deployments, and security scans, but feature availability and policy scope vary. Source: `REPLIT-PRIVACY`.

### Safe example and verification direction

Use a local or disposable Replit app with dummy secrets. Verify that no secret appears in HTML, JavaScript, logs, or API responses; test an API route without a session; inspect headers on the published URL; and compare Preview with production. Do not paste a production token into any example.

### Limits and recheck notes

Recheck deployment product names, how secrets sync between development and deployment, the visibility of `replit.dev` URLs, plan-specific private controls, and current security scan behavior. Stored secrets are not safe if the application returns them to the client.

## 59. `v0-app-security-checklist`

### Official sources

1. `V0-SEC`: [v0 security](https://v0.dev/docs/security), accessed 2026-07-17.
2. `V0-ENV`: [v0 environment variables](https://v0.app/docs/api/platform/guides/environment-variables), accessed 2026-07-17.
3. `V0-DEPLOY`: [v0 deployments](https://v0.app/docs/deployments), accessed 2026-07-17.
4. `NEXT-DATA`: [Next.js data security guide](https://nextjs.org/docs/app/guides/data-security), last updated 2026-02-27 and accessed 2026-07-17.

Source count: 4, all official vendor or framework documentation.

### Claim map

- Claim: v0 documents generated-code analysis and sandboxed preview execution, but these controls must not be described as proof of business authorization or production safety. Source: `V0-SEC` plus the design's prohibited-claim rule.
- Claim: v0 and Next.js distinguish server-only variables from browser-exposed variables, especially the `NEXT_PUBLIC_` prefix. Sources: `V0-SEC`, `NEXT-DATA`.
- Claim: Project environment variables may be available to linked chats, and development, preview, and production environments need separate review. Sources: `V0-ENV`, `V0-DEPLOY`.
- Claim: v0 deployments use Vercel and can use deployment protection, but current policies and availability are Vercel controls that require separate verification. Source: `V0-DEPLOY`.
- Claim: Server Actions and route handlers remain public server entry points that need input validation and authorization. Source: `NEXT-DATA`.

### Safe example and verification direction

Use a generated sample with a placeholder API key and a fake account-scoped record. Show how a secret moves to a server-only handler and how the handler rejects access to another user's record. Test preview protection and negative API calls separately.

### Limits and recheck notes

The official docs use both `v0.dev` and `v0.app` domains. Recheck canonical paths, environment-variable scope, security-analysis wording, Vercel deployment integration, and protection controls. Do not assert that warnings or automatic refactoring are enabled for every generated app.

## 60. `base44-app-security-checklist`

### Official sources

1. `BASE44-OVERVIEW`: [Base44 security overview](https://docs.base44.com/Setting-up-your-app/security-overview), accessed 2026-07-17.
2. `BASE44-PERM`: [Managing data permissions](https://docs.base44.com/Setting-up-your-app/Managing-security-settings), accessed 2026-07-17.
3. `BASE44-SCAN`: [Running a security scan](https://docs.base44.com/Setting-up-your-app/running-a-security-scan), accessed 2026-07-17.
4. `BASE44-ACCESS`: [Choosing who can access your app](https://docs.base44.com/Setting-up-your-app/Managing-access), accessed 2026-07-17.

Source count: 4, all official Base44 documentation.

### Claim map

- Claim: Base44 distinguishes app visibility from data access rules. Private, workspace, and public access settings do not replace record authorization. Sources: `BASE44-OVERVIEW`, `BASE44-ACCESS`.
- Claim: Data permissions are configured by table and CRUD operation, with owner, role, and entity-user comparison patterns. Source: `BASE44-PERM`.
- Claim: Field-level permissions were not available in the current documentation; sensitive fields may need separate tables or backend functions. Source: `BASE44-PERM`. Recheck before drafting.
- Claim: Base44 documents secrets, backend checks, dependency scanning, credential detection, login verification, and security headers, while also stating the builder remains responsible for app settings. Sources: `BASE44-OVERVIEW`, `BASE44-SCAN`.
- Claim: Scan results can become out of date when the app changes, so a fresh pre-launch scan and role-based negative tests are both required. Source: `BASE44-SCAN`.
- Claim: Being an app Admin or User is distinct from editor or dashboard collaboration access. Source: `BASE44-ACCESS`.

### Safe example and verification direction

Use three fictitious roles and a table containing non-sensitive sample rows. Test open, authenticated, owner, and cross-tenant access separately for create, read, update, and delete. If a record mixes public and private fields, demonstrate the safer separate-table design without using real personal data.

### Limits and recheck notes

Recheck role customization, field-level permission support, scan coverage, Fix All behavior, visibility options, plan availability, and whether permissions generated by AI require explicit approval. Do not claim that an automatic fix is independently verified.

## 61. `supabase-security-guide`

### Official sources

1. `SUPABASE-RLS`: [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), accessed 2026-07-17.
2. `SUPABASE-API`: [Securing the Supabase Data API](https://supabase.com/docs/guides/api/securing-your-api), accessed 2026-07-17.
3. `SUPABASE-SESSIONS`: [Supabase Auth sessions](https://supabase.com/docs/guides/auth/sessions), accessed 2026-07-17.
4. `OWASP-AUTHZ`: shared source above.

Source count: 4, including 3 official Supabase sources.

### Claim map

- Claim: Tables in an exposed schema need RLS, and tables created through raw SQL may not receive the same automatic enablement as dashboard-created tables. Source: `SUPABASE-RLS`.
- Claim: Database grants decide which roles can reach a table, view, or function; RLS then filters rows. Source: `SUPABASE-API`.
- Claim: `anon` and `authenticated` are Postgres roles, and a Firebase-like assumption that a public client key is a secret is incorrect. Authorization comes from grants and policies. Sources: `SUPABASE-RLS`, `SUPABASE-API`.
- Claim: Service credentials can bypass RLS and must never be exposed to browsers or customers. Source: `SUPABASE-RLS`.
- Claim: `raw_user_meta_data` is user-editable and should not be an authorization source; `raw_app_meta_data` has a different trust boundary, but JWT claims may remain stale until refresh. Source: `SUPABASE-RLS`.
- Claim: Views and `security definer` functions can alter RLS behavior. Use security-invoker views where supported and keep privileged functions out of exposed schemas. Source: `SUPABASE-RLS`.
- Claim: Authorization requires positive and negative tests per role, tenant, and operation. Source: `OWASP-AUTHZ` and the policy model.

### Safe example and verification direction

Show a minimal `projects` table with RLS, explicit role targeting, `using`, and `with check`. Use two disposable accounts to test select, insert, update, and delete. Include a view and service-key review checklist, but never include a real key.

### Limits and recheck notes

Recheck current key terminology, Data API schema controls, Auth session behavior, RLS defaults, Postgres version guidance, and view behavior. The local LyraShield RLS checker is pattern-based and cannot inspect deployed grants, roles, or semantics.

## 62. `firebase-security-guide`

### Official sources

1. `FIREBASE-CHECK`: [Firebase security checklist](https://firebase.google.com/support/guides/security-checklist), accessed 2026-07-17.
2. `FIREBASE-RULES`: [Basic Firebase Security Rules](https://firebase.google.com/docs/rules/basics), accessed 2026-07-17.
3. `FIREBASE-APP-CHECK`: [Firebase App Check](https://firebase.google.com/docs/app-check), accessed 2026-07-17.
4. `FIREBASE-STORAGE`: [Cloud Storage Security Rules](https://firebase.google.com/docs/storage/security), accessed 2026-07-17.

Source count: 4, all official Firebase documentation.

### Claim map

- Claim: Firebase API keys identify a project and are not the resource-authorization boundary. Authorization depends on IAM, Security Rules, and supported App Check controls. Source: `FIREBASE-CHECK`.
- Claim: New database and storage resources should begin in locked or production mode, with rules developed alongside new document and path structures. Sources: `FIREBASE-CHECK`, `FIREBASE-RULES`.
- Claim: App Check and Firebase Authentication are complementary. App Check attests the calling app; it does not identify a user or grant object access. Source: `FIREBASE-APP-CHECK`.
- Claim: Storage rules can inspect request and resource properties, so file type, size, ownership, and metadata requirements can be enforced at the resource boundary. Source: `FIREBASE-STORAGE`.
- Claim: Abuse controls also require quotas, alerts, defensive function design, and monitoring. Source: `FIREBASE-CHECK`.

### Safe example and verification direction

Use Emulator Suite examples with fake user IDs and inert files. Demonstrate deny-by-default, owner read and write, content-type and size constraints, and an unauthenticated negative test. Do not target a real bucket or recommend Test mode for production.

### Limits and recheck notes

Recheck current rule language versions, Emulator Suite commands, App Check provider support, API-key restriction defaults, and product-specific monitoring paths. App Check reduces unauthorized client traffic but does not prevent logic bugs in Security Rules.

## 63. `nextjs-ai-app-security`

### Official sources

1. `NEXT-DATA`: [How to think about data security in Next.js](https://nextjs.org/docs/app/guides/data-security), last updated 2026-02-27 and accessed 2026-07-17.
2. `NEXT-AUTH`: [Next.js authentication guide](https://nextjs.org/docs/app/guides/authentication), accessed 2026-07-17.
3. `REACT-SERVER`: [React `use server` directive](https://react.dev/reference/rsc/use-server), React 19.2 docs accessed 2026-07-17.
4. `NEXT-ENV`: [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables), Next.js 16.2.10 docs last updated 2026-03-03 and accessed 2026-07-17.

Source count: 4, all official framework documentation.

### Claim map

- Claim: Next.js recommends a server-only Data Access Layer that performs authorization and returns minimal DTOs. Source: `NEXT-DATA`.
- Claim: Server Actions create callable HTTP endpoints and must receive the same authentication, authorization, and input-validation treatment as other endpoints. Sources: `NEXT-DATA`, `REACT-SERVER`.
- Claim: Route-level or layout-level UI checks are not sufficient because the application has multiple server entry points. Authorization should occur near the data source. Source: `NEXT-AUTH`.
- Claim: `server-only` can cause a build error when privileged modules are imported into client code, but it does not replace authorization. Source: `NEXT-DATA`.
- Claim: Environment variables are server-only by default, while `NEXT_PUBLIC_` values are bundled for the browser. Sources: `NEXT-DATA`, `NEXT-ENV`.
- Claim: Experimental taint features are defense-in-depth and should not be the article's primary control. Source: `NEXT-DATA`.

### Safe example and verification direction

Use a fake invoice lookup. Show a vulnerable Server Action that trusts a client-provided ID and a corrected DAL function that obtains the session, checks tenant ownership, and returns a minimal DTO. Test by calling the action or route directly with a second test account.

### Limits and recheck notes

Recheck the current stable Next.js and React versions, Server Action IDs and caching details, middleware guidance, taint status, and environment-variable behavior. Do not imply that an action is private because the UI does not import or display it.

## 64. `react-frontend-security-ai-code`

### Official sources

1. `REACT-DOM`: [React common DOM components](https://react.dev/reference/react-dom/components/common), React 19.2 docs accessed 2026-07-17.
2. `REACT-SERVER`: [React `use server` directive](https://react.dev/reference/rsc/use-server), React 19.2 docs accessed 2026-07-17.
3. `OWASP-XSS`: shared source above.
4. `OWASP-AUTHZ`: shared source above.

Source count: 4, including 2 official React sources.

### Claim map

- Claim: `dangerouslySetInnerHTML` writes raw HTML and can create XSS when the input is untrusted. React requires a deliberately shaped object to make the hazard visible, but the API does not sanitize the string. Source: `REACT-DOM`.
- Claim: Normal component rendering is not a general authorization boundary. UI state, routes, and hidden controls are client-controlled. Source: `OWASP-AUTHZ` plus browser architecture.
- Claim: React Server Function arguments are fully client-controlled and require validation and authorization. Source: `REACT-SERVER`.
- Claim: Sanitization must follow the output context, and CSP is defense-in-depth rather than a replacement for safe rendering. Source: `OWASP-XSS`.
- Claim: A client-side environment value or browser storage entry is visible to users and must not contain server credentials. Use framework-specific documentation for the build system in the final article.

### Safe example and verification direction

Show inert markup such as an image with a harmless invalid event string, clearly labeled as a vulnerable pattern, without using a real target. The corrected pattern should prefer rendering structured data. If raw HTML is necessary, require a maintained sanitizer and a test corpus. Also call the API directly to prove server authorization does not depend on button visibility.

### Limits and recheck notes

React alone does not define the application's server, environment-variable prefix, session model, or CSP delivery. Keep framework-specific server advice in related articles. Recheck React version and any active Server Component security advisories before drafting.

## 65. `node-express-ai-api-security`

### Official sources

1. `EXPRESS-SEC`: [Express production security best practices](https://expressjs.com/en/advanced/best-practice-security/), Express 5.x docs accessed 2026-07-17.
2. `EXPRESS-PROXY`: [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/), Express 5.x docs accessed 2026-07-17.
3. `NODE-PERM`: [Node.js permissions](https://nodejs.org/api/permissions.html), Node.js 26.5.0 docs accessed 2026-07-17.
4. `OWASP-API`: shared source above.

Source count: 4, including 3 official runtime or framework sources.

### Claim map

- Claim: Express production guidance includes TLS, input validation, open-redirect protection, Helmet, secure cookies, brute-force controls, and current dependencies. Source: `EXPRESS-SEC`.
- Claim: `trust proxy` changes which forwarded values Express accepts. It must match the actual ingress topology because a broad setting may trust client-supplied forwarding headers. Source: `EXPRESS-PROXY`.
- Claim: The default in-memory Express session store is not designed for production. Cookies need Secure and HttpOnly settings, and SameSite policy must match the application's flows. Source: `EXPRESS-SEC` plus current session middleware docs during drafting.
- Claim: Object-level and function-level authorization must be applied per endpoint and resource. Source: `OWASP-API`.
- Claim: Node's permission model can limit runtime access to files or processes, but it does not implement user authentication or resource authorization. Source: `NODE-PERM` and the distinction between runtime and application layers.

### Safe example and verification direction

Use an inert `GET /projects/:id` example. First show a handler that loads by ID after authentication only; then add workspace-scoped lookup and a consistent not-found response. Include an exact ingress diagram before showing `trust proxy` configuration. Test unauthenticated, wrong-tenant, malformed, over-size, and rate-limited requests.

### Limits and recheck notes

Recheck the current maintained Express releases, security advisories, Helmet defaults, session middleware behavior, Node permission-model stability, and the deployed proxy chain. Do not copy an arbitrary `trust proxy` value into production guidance.

## 66. `fastapi-ai-generated-security`

### Official sources

1. `FASTAPI-SEC`: [FastAPI security tutorial](https://fastapi.tiangolo.com/tutorial/security/), accessed 2026-07-17.
2. `FASTAPI-CORS`: [FastAPI CORS](https://fastapi.tiangolo.com/tutorial/cors/), accessed 2026-07-17.
3. `FASTAPI-PROXY`: [FastAPI behind a proxy](https://fastapi.tiangolo.com/advanced/behind-a-proxy/), accessed 2026-07-17.
4. `STARLETTE-MW`: [Starlette middleware](https://www.starlette.io/middleware/), accessed 2026-07-17.
5. `FASTAPI-DEPLOY`: [FastAPI deployment concepts](https://fastapi.tiangolo.com/deployment/concepts/), accessed 2026-07-17.

Source count: 5, all official FastAPI or underlying Starlette documentation.

### Claim map

- Claim: FastAPI supplies authentication building blocks but application code still decides object and action authorization. Source: `FASTAPI-SEC` plus `OWASP-AUTHZ` reasoning.
- Claim: Pydantic request validation checks shape and constraints, not whether the current user owns the requested object. This is an architectural distinction to explain, not a vendor deficiency claim.
- Claim: Credentialed CORS cannot be safely combined with wildcard origins, methods, and headers. Use explicit trusted origins. Sources: `FASTAPI-CORS`, `STARLETTE-MW`.
- Claim: TrustedHostMiddleware can reject unexpected Host headers, and HTTPSRedirectMiddleware can enforce secure schemes when it matches the deployment architecture. Source: `STARLETTE-MW`.
- Claim: Forwarded headers and root paths depend on the real proxy configuration. Only trust known proxies. Source: `FASTAPI-PROXY`.
- Claim: TLS often terminates before Uvicorn, so application and ingress settings must agree about scheme, host, and client address. Source: `FASTAPI-DEPLOY`.

### Safe example and verification direction

Use a fake `Document` resource with a dependency that returns the authenticated principal and a service function that filters by both ID and tenant. Add explicit CORS origins and trusted hosts for placeholder domains. Test direct object access with a second account and forged forwarding headers in a local test client.

### Limits and recheck notes

Recheck FastAPI, Pydantic, Starlette, and Uvicorn versions together because middleware and proxy behavior can change below FastAPI. Verify current CORS defaults, trusted-host signatures, and OpenAPI documentation controls before drafting.

## 67. `vercel-deployment-security`

### Official sources

1. `VERCEL-PROTECT`: [Deployment Protection on Vercel](https://vercel.com/docs/deployment-protection), last updated 2026-01-07 and accessed 2026-07-17.
2. `VERCEL-ENV`: [Vercel environment variables](https://vercel.com/docs/environment-variables), last updated 2025-09-24 and accessed 2026-07-17.
3. `VERCEL-ENVIRONMENTS`: [Vercel environments](https://vercel.com/docs/deployments/environments), last updated 2025-12-01 and accessed 2026-07-17.
4. `VERCEL-BYPASS`: [Methods to bypass Deployment Protection](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection), last updated 2026-01-28 and accessed 2026-07-17.

Source count: 4, all official Vercel documentation.

### Claim map

- Claim: Standard Protection covers deployment and preview URLs while production-domain behavior depends on the selected protection scope. Source: `VERCEL-PROTECT`. Recheck exact plan and scope names before publication.
- Claim: A preview deployment is live and receives environment variables selected for Preview or a branch. It may reach real services if variables are not isolated. Sources: `VERCEL-ENV`, `VERCEL-ENVIRONMENTS`.
- Claim: Environment-variable changes affect new deployments, not deployments already built. Source: `VERCEL-ENV`.
- Claim: Shareable links and automation bypasses grant access around protection. They need narrow distribution, storage, rotation, and revocation. Source: `VERCEL-BYPASS`.
- Claim: The bypass header is preferable for test tooling when supported; query parameters are necessary for some webhooks but can leak through logs, history, or referrers and need extra care. Source: `VERCEL-BYPASS` plus `OWASP-SECRETS`.
- Claim: Protection does not authorize application resources after the user reaches the deployment. App authentication and data authorization remain separate.

### Safe example and verification direction

Use placeholder preview and production URLs. Inventory access, variables, databases, OAuth callbacks, webhooks, and bypass consumers. Verify an unauthenticated request is blocked, E2E uses the header form, and application authorization still denies a cross-account request after deployment access succeeds.

### Limits and recheck notes

Plan availability, protection scopes, legacy modes, and shareable-link behavior are fast-changing and commercially sensitive. Recheck them without including pricing. Confirm whether preview protection affects OAuth callbacks, webhooks, and same-origin server fetches for the selected application.

## 68. `cloudflare-workers-ai-security`

### Official sources

1. `CF-SECRETS`: [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/), last updated 2026-07-03 and accessed 2026-07-17.
2. `CF-BINDINGS`: [Cloudflare Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/), last updated 2026-06-22 and accessed 2026-07-17.
3. `CF-REQUEST`: [Cloudflare Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/), accessed 2026-07-17.
4. `CF-LIMITS`: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), accessed 2026-07-17.
5. `CF-MODEL`: [Cloudflare Workers security model](https://developers.cloudflare.com/workers/reference/security-model/), accessed 2026-07-17.
6. `OWASP-SSRF`: shared source above.

Source count: 6, including 5 official Cloudflare sources.

### Claim map

- Claim: Workers use V8 isolates plus defense-in-depth sandboxing, but runtime tenant isolation does not implement application authentication or validate business authorization. Source: `CF-MODEL`.
- Claim: A binding grants a capability to a Cloudflare resource and can avoid exposing underlying API credentials to Worker code. Bind only the resources the Worker needs. Source: `CF-BINDINGS`.
- Claim: Sensitive values should use secrets, not plain Wrangler `vars`; local `.dev.vars` or `.env` files must remain out of Git. Source: `CF-SECRETS`.
- Claim: A Worker-created outbound Request defaults to following redirects, and sensitive headers can be forwarded to a different host unless redirect handling is made explicit. Source: `CF-REQUEST`.
- Claim: Host allowlists must be resolved and revalidated carefully for outbound requests; redirects and DNS behavior are part of the SSRF boundary. Sources: `CF-REQUEST`, `OWASP-SSRF`.
- Claim: Memory and subrequest limits require bounded body handling and controlled redirect chains. Security-critical routes should not fail open on quota exhaustion. Source: `CF-LIMITS`.
- Claim: Bindings, service bindings, secrets, cache behavior, routes, and environment configuration must be tested using the production-shaped Wrangler configuration, not only a framework dev server.

### Safe example and verification direction

Use a fake upstream allowlist and an inert request. Show URL parsing, exact HTTPS host matching, manual redirect handling, removal of sensitive headers across origins, body-size limits, and a service binding instead of a broad API token where appropriate. Test disallowed hosts, redirect-to-disallowed-host, large body, missing auth, and limit behavior locally.

### Limits and recheck notes

Cloudflare documentation changes frequently. Recheck Workers compatibility date behavior, Node compatibility and `process.env`, required secret declarations, binding APIs, route fail modes, request redirect defaults, and plan limits. Do not claim that V8 isolation prevents SSRF, broken authorization, unsafe caching, or secret leakage in application responses.

## Cross-topic accuracy risks

1. Product and documentation naming: Windsurf and Cascade materials are moving into Devin Desktop documentation. OpenAI Codex documentation has moved to ChatGPT Learn. v0 uses both `v0.dev` and `v0.app` paths.
2. Plan-gated controls: Vercel, Replit, Lovable, Base44, Bolt, and Windsurf change plan availability and admin controls. Final articles should describe behavior first and avoid pricing.
3. Automatic security features: Scans, warnings, and auto-fixes are detection or remediation aids. They do not prove exploitability, completeness, or independent verification.
4. Runtime versus application security: Sandboxes, V8 isolates, server functions, and protected previews reduce specific risks but do not implement object authorization or validate business rules.
5. Keys and client configuration: Public client identifiers are not automatically secrets. Privileged keys, service credentials, and backend tokens must remain outside client code. Authorization controls still need to be correct even when a client key is intentionally public.
6. Proxy and forwarded headers: Express, FastAPI, Vercel, and Cloudflare behavior depends on actual ingress. Never publish a universal proxy setting without a topology diagram and negative test.

## Drafting re-verification checklist

- Open every official source and record the final review date.
- Pin the product or framework version when documentation exposes one.
- Verify UI labels, defaults, and plan scope in current docs.
- Remove any claim sourced only from a changelog or marketing page when a current technical page is unavailable.
- Run code examples against the named stable framework version.
- Confirm that vulnerable snippets are inert, local, and not aimed at a real system.
- Keep product scan states separate from independent evidence and retest-confirmed outcomes.
- Check internal link publication dependencies before making Batch 4 public.
