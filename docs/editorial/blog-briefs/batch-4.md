# Batch 4 editorial briefs

Date: 2026-07-17
Status: research complete, drafting not started
Owner: LyraShield Team
Program scope: topics 53 through 68

## Shared editorial rules

Each article has one search intent and one platform-specific trust boundary. The opening direct answer should be 40 to 80 words. The authority guide link, `/blog/vibe-coding-security-guide`, belongs in the first third. Every article must state what the named platform secures, what remains application responsibility, and what a static or passive check cannot prove. Use the Humanizer draft, audit, and final rewrite loop before publication.

Do not turn platform security features into proof that an application is secure. Avoid claims about product performance, customers, pricing, or the completeness of automated findings. Product UI labels and plan availability are fast-changing details and must be rechecked on the article's final review date.

## 53. Secure a Claude Code Project

- Slug: `claude-code-security-workflow`
- Primary query: `claude code security workflow`
- Intent: workflow
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `agent-security`, `verification`
- Reader problem: A developer wants Claude Code to edit and test a repository without turning a broad approval into uncontrolled shell, network, or MCP access.
- Unique angle: Treat the agent's effective capability as the intersection of workspace scope, permission rules, sandbox boundaries, network access, and connected tools. Prompts describe intent but do not enforce permissions.
- Direct-answer thesis: Start read-only, keep the writable root narrow, deny or prompt for release and credential operations, review project settings in version control, and run generated changes through tests and diff review before any deployment action.
- Relevant entities: Claude Code, permission modes, Bash sandbox, `permissions.deny`, MCP, project settings, dev containers, prompt injection.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/ai-agent-permission-model` for least-privilege design and `/blog/secure-mcp-server-guide` for MCP server controls.
- Cannibalization boundary: Unlike the general agent-permission article, this page explains Claude Code controls and a repository workflow. It should not become a general prompt-injection guide.
- FAQ decision: Include three. Cover whether plan mode is a sandbox, when bypass mode is acceptable, and whether a trusted MCP server still needs scoped permissions.
- Image concept: A graphite repository chamber inside a cyan permission boundary, with one amber tool path waiting at a review gate. No logos or UI text.
- Outline focus: establish the effective permission model; audit settings and MCPs; isolate untrusted content; review commands and diffs; verify with tests; record limitations.

## 54. Secure an OpenAI Codex Project

- Slug: `codex-security-workflow`
- Primary query: `codex security workflow`
- Intent: workflow
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `agent-security`, `verification`
- Reader problem: A developer needs a repeatable Codex workflow that keeps sandbox, approvals, network, environment variables, apps, and MCP tools aligned with the task.
- Unique angle: Separate sandbox enforcement from approval policy. A strict approval setting does not narrow a permissive sandbox, and a narrow sandbox does not make every approved network or MCP action safe.
- Direct-answer thesis: Use a read-only or workspace-scoped sandbox, keep network off unless the task needs named origins, constrain environment inheritance and MCP tools, inspect the diff, and require tests plus a human release decision.
- Relevant entities: Codex, `sandbox_mode`, `approval_policy`, permission profiles, `shell_environment_policy`, MCP allowlists, network access, project trust.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/ai-agent-permission-model` and `/blog/coding-agents-production-access`.
- Cannibalization boundary: This is an operating guide for Codex configuration and review. The later MCP article owns server design, and the production-access article owns production credential policy.
- FAQ decision: Include three. Cover sandbox versus approval policy, when network access is justified, and whether `never` approval is safer than interactive review.
- Image concept: Two nested translucent fields around a repository, one for sandbox capability and one for approval state, with a narrow network aperture.
- Outline focus: choose a permission profile; constrain network and environment; review apps and MCP tools; run a verification loop; separate code completion from deployment approval.

## 55. Secure a Windsurf Project

- Slug: `windsurf-security-workflow`
- Primary query: `windsurf security workflow`
- Intent: workflow
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `agent-security`, `verification`
- Reader problem: A team using Cascade needs to control terminal automation, MCPs, credentials, shared rules, and repository changes as Windsurf moves into the Devin Desktop product surface.
- Unique angle: The security boundary is not the editor alone. It includes terminal auto-execution, the MCP registry and tool toggles, local credential interpolation, team policy, and the branch review path.
- Direct-answer thesis: Cap terminal auto-execution, allowlist MCP servers and tools, keep tokens out of checked-in configuration, review generated changes in a branch, and make CI plus human review the release boundary.
- Relevant entities: Windsurf, Devin Desktop, Cascade, MCP registry, `mcp_config.json`, terminal auto-execution, team allowlists, worktrees.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/secure-mcp-server-guide` and `/blog/ai-generated-code-review-workflow`.
- Cannibalization boundary: Focus on current Windsurf and Cascade control surfaces, not a generic agent checklist. Explain the product-documentation transition explicitly and briefly.
- FAQ decision: Include three. Cover the Windsurf to Devin Desktop documentation change, whether MCP marketplace status is a security audit, and when terminal auto-run should be disabled.
- Image concept: A repository worktree splitting into reviewed and blocked paths, with a separate MCP tool rail entering through an allowlist gate.
- Outline focus: map current product terminology; set terminal and MCP policy; protect credentials; use branches and CI; verify deployment separately.

## 56. Secure a Lovable App Before Launch

- Slug: `lovable-app-security-checklist`
- Primary query: `lovable app security checklist`
- Intent: workflow
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `access-control`, `web-security`, `verification`
- Reader problem: A Lovable builder needs to know which checks belong in the browser, Edge Functions, RLS policies, authentication flow, and publishing review.
- Unique angle: Organize the launch check around Lovable's own three-part application boundary: public frontend, server-side Edge Functions, and PostgreSQL RLS.
- Direct-answer thesis: Keep secrets and authorization out of the frontend, move validation and sensitive integrations to Edge Functions, test RLS with multiple accounts, run current scans, and treat scan results as evidence to review rather than a launch guarantee.
- Relevant entities: Lovable, Edge Functions, Supabase, RLS, Project security view, Basic scan, Deep scan, workspace visibility.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/supabase-rls-checker`
- Related dependency: `/blog/supabase-security-guide` and `/blog/two-account-idor-test`.
- Cannibalization boundary: This page owns the Lovable launch workflow. The Supabase article owns deeper SQL policy and service-key guidance.
- FAQ decision: Include three. Cover whether frontend validation is enough, what a Lovable scan proves, and why two-account RLS tests remain necessary.
- Image concept: Three stacked evidence planes for browser, Edge Function, and database, with the database plane divided into tenant compartments.
- Outline focus: identify the trust boundary; review secrets and backend functions; test authentication and RLS; use scans; perform a manual launch gate.

## 57. Secure a Bolt App Before Launch

- Slug: `bolt-app-security-checklist`
- Primary query: `bolt app security checklist`
- Intent: workflow
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `access-control`, `web-security`, `verification`
- Reader problem: A Bolt builder needs one launch process that works whether the app uses Bolt Database or Supabase and does not confuse project preview with production security.
- Unique angle: Start by identifying the actual backend. Then verify server functions, secrets, table policies, webhook authentication, CORS, publishing visibility, and the deployed URL as separate controls.
- Direct-answer thesis: Determine which database and hosting path the app uses, keep secrets in server-side storage, inspect RLS or table policies, authenticate every server function and webhook, validate the live deployment, and review Bolt's security findings without assuming they cover every route.
- Relevant entities: Bolt, Bolt Database, Supabase, server functions, secrets, Security Audit, RLS, Publish, CORS, webhooks.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/supabase-security-guide` and `/blog/webhook-signature-verification`.
- Cannibalization boundary: Own Bolt-specific backend selection and publish workflow. Do not duplicate the full Supabase or webhook guides.
- FAQ decision: Include three. Cover Bolt Database versus Supabase, whether project sharing equals site publishing, and how to secure a webhook that cannot present the app's JWT.
- Image concept: Two backend paths converge on a single release gate, with secrets and webhook receipts passing through separate server-side channels.
- Outline focus: inventory backend and environments; review secrets and policies; harden server functions; validate publishing visibility; test the deployed result.

## 58. Secure a Replit App Before Launch

- Slug: `replit-app-security-checklist`
- Primary query: `replit app security checklist`
- Intent: workflow
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `web-security`, `access-control`, `verification`
- Reader problem: A Replit user needs to reconcile development URLs, deployment type, production secrets, authentication, access controls, and response headers before publication.
- Unique angle: Treat Preview and the published deployment as different environments. Re-check production secrets, callback URLs, data persistence, visibility, and headers on the real deployment.
- Direct-answer thesis: Keep secrets out of code and browser storage, choose a deployment type that supports the app's server behavior, protect development and published URLs appropriately, verify authentication and authorization at the API, and inspect the final response headers.
- Relevant entities: Replit Apps, Secrets, Preview, Static Deployments, Autoscale or Reserved VM deployments, Replit Auth, private deployments, security scan.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/security-headers-checker`
- Related dependency: `/blog/security-headers-checklist` and `/blog/session-cookie-security`.
- Cannibalization boundary: This page owns Replit environment and publishing differences. The headers article owns policy construction, and the session article owns cookie details.
- FAQ decision: Include three. Cover whether Preview is private, whether static deployment can host API routes, and whether Replit Secrets can be exposed by application code.
- Image concept: A preview chamber and production chamber connected by a deployment bridge, with secrets sealed outside the client bundle.
- Outline focus: choose deployment type; isolate secrets; secure auth and endpoints; configure visibility; validate production behavior and headers.

## 59. Secure a v0-Generated App

- Slug: `v0-app-security-checklist`
- Primary query: `v0 app security checklist`
- Intent: workflow
- Target: 1,350 words
- Stable tags: `vibe-coding-security`, `web-security`, `verification`
- Reader problem: A developer has generated a v0 application and needs to distinguish v0 preview protections, Next.js client-server boundaries, Vercel environment settings, and application authorization.
- Unique angle: Follow generated code across three contexts: v0 project and preview, the Next.js server-client boundary, and the Vercel deployment. Security analysis at generation time does not validate business authorization.
- Direct-answer thesis: Review generated code as untrusted input, keep non-public variables server-side, move privileged work to server routes or actions with authorization, protect preview deployments, and test the deployed application with negative access cases.
- Relevant entities: v0, Next.js, `NEXT_PUBLIC_`, Route Handlers, Server Actions, Vercel environments, deployment protection.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/secret-exposure-scanner`
- Related dependency: `/blog/nextjs-ai-app-security` and `/blog/vercel-deployment-security`.
- Cannibalization boundary: This page is the generated-app handoff checklist. The Next.js and Vercel articles own framework and hosting detail.
- FAQ decision: Include three. Cover whether v0 security analysis proves safety, which environment variables reach the browser, and whether a preview URL is private by default.
- Image concept: Generated component blocks crossing from a preview field into a server-client boundary and then a protected deployment gate.
- Outline focus: inspect generated code and dependencies; map variables; review server endpoints; protect previews; run negative tests on deployment.

## 60. Secure a Base44 App Before Launch

- Slug: `base44-app-security-checklist`
- Primary query: `base44 security checklist`
- Intent: workflow
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `access-control`, `verification`
- Reader problem: A Base44 builder needs to validate app visibility, roles, table-level CRUD rules, backend functions, secrets, and scan findings before sharing a public link.
- Unique angle: Test the gap between app access and data access. A user who can open the app may still need row-level restrictions, and table-wide permissions do not provide field-level confidentiality.
- Direct-answer thesis: Set the narrowest app visibility, require sign-in where needed, review every table's create, read, update, and delete rules, keep credentials in backend secrets, run a fresh scan, and verify roles with separate accounts.
- Relevant entities: Base44, app visibility, roles, data permissions, CRUD rules, security scan, secrets, backend functions, field-level permission limitation.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/idor-ai-built-apps` and `/blog/server-side-authorization-ai-apis`.
- Cannibalization boundary: Focus on Base44's app and table permission model. The IDOR article owns the complete two-account test method.
- FAQ decision: Include four because platform terms are easy to conflate. Cover visibility versus permissions, role versus editor access, field-level restrictions, and what a scan can miss.
- Image concept: A public outer gate around multiple table compartments, each with separate CRUD apertures and one hidden backend secret vault.
- Outline focus: choose visibility; model roles; audit table rules; protect backend functions and secrets; scan; verify with multiple accounts.

## 61. Secure Supabase Auth, RLS, and Service Keys

- Slug: `supabase-security-guide`
- Primary query: `supabase security checklist guide`
- Intent: stack guide
- Target: 1,500 words
- Stable tags: `access-control`, `web-security`, `verification`
- Reader problem: A Supabase developer needs a coherent model for public client keys, sessions, grants, RLS, views, `security definer` functions, and service-role credentials.
- Unique angle: Explain access as a chain: exposed schema grants determine reachability, RLS policies constrain rows, trusted server code may use privileged keys, and the app must still authorize each business operation.
- Direct-answer thesis: Enable RLS on every exposed table, scope grants and policies by role and tenant, keep service-role keys out of browsers, treat user-editable metadata as untrusted for authorization, and test positive plus negative cases with separate accounts.
- Relevant entities: Supabase Auth, Postgres RLS, `anon`, `authenticated`, `service_role`, `auth.uid()`, `auth.jwt()`, `raw_app_meta_data`, views, `security invoker`, `security definer`.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/supabase-rls-checker`
- Related dependency: `/blog/supabase-rls-vibe-coded-apps` and `/blog/api-keys-frontend-ai-apps`.
- Cannibalization boundary: This is the complete stack guide. The earlier RLS article should remain a focused fix tutorial, and the service-key article should remain incident-focused.
- FAQ decision: Include four. Cover public anon keys, RLS on SQL-created tables, authorization metadata, and service-role use.
- Image concept: A PostgreSQL data plane segmented by tenant, with public and authenticated paths filtered by policies and a privileged service path isolated server-side.
- Outline focus: map keys and roles; enable and test RLS; review grants and views; protect service keys; cover session freshness and limitations.

## 62. Secure Firebase Rules and Storage

- Slug: `firebase-security-guide`
- Primary query: `firebase security rules checklist guide`
- Intent: stack guide
- Target: 1,450 words
- Stable tags: `access-control`, `web-security`, `verification`
- Reader problem: A Firebase developer needs to coordinate Authentication, Firestore or Realtime Database rules, Storage rules, App Check, API-key restrictions, and abuse controls.
- Unique angle: Separate identity, authorization, app attestation, and abuse resistance. Firebase API keys identify the project but do not grant data access by themselves; Security Rules and IAM remain the authorization boundary.
- Direct-answer thesis: Start rules in locked mode, version and test rules alongside schema changes, validate both document and file access, enable App Check where supported, restrict APIs and quotas, and test with the Emulator Suite before deploying.
- Relevant entities: Firebase Authentication, Security Rules, Cloud Firestore, Realtime Database, Cloud Storage, App Check, API keys, IAM, Emulator Suite.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/server-side-authorization-ai-apis` and `/blog/secure-file-uploads-ai-apps`.
- Cannibalization boundary: Own the Firebase control model. Do not imply the Supabase RLS checker applies to Firebase rules.
- FAQ decision: Include four. Cover whether Firebase API keys are secrets, App Check versus Authentication, test mode, and Storage metadata validation.
- Image concept: Identity, database-rule, and storage-rule planes around a project core, with a separate App Check signal entering before resource access.
- Outline focus: explain four control layers; lock rules; test database and storage paths; configure App Check and API restrictions; monitor abuse.

## 63. Secure a Next.js App Generated by AI

- Slug: `nextjs-ai-app-security`
- Primary query: `nextjs security checklist guide`
- Intent: stack guide
- Target: 1,450 words
- Stable tags: `vibe-coding-security`, `web-security`, `access-control`, `verification`
- Reader problem: AI-generated Next.js code can blur Server and Client Components, expose data through serialization, and omit authorization on Route Handlers or Server Actions.
- Unique angle: Treat every callable server entry point as an API. Build one server-only data access layer that authenticates, authorizes, and returns minimal DTOs before data reaches the React render boundary.
- Direct-answer thesis: Keep secrets and privileged modules server-only, perform authorization near the data source, validate all Server Action and Route Handler input, return minimal DTOs, and test direct endpoint access rather than relying on UI guards or hidden navigation.
- Relevant entities: Next.js App Router, Server Components, Client Components, Route Handlers, Server Actions, Data Access Layer, `server-only`, DTOs, `NEXT_PUBLIC_`.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/security-headers-checker`
- Related dependency: `/blog/react-frontend-security-ai-code` and `/blog/server-side-authorization-ai-apis`.
- Cannibalization boundary: Own Next.js server-client and route boundaries. The React article owns DOM rendering and browser trust; the API article owns framework-neutral endpoint policy.
- FAQ decision: Include four. Cover whether unused Server Actions are private, middleware as the only auth check, `NEXT_PUBLIC_`, and Server Components as an authorization boundary.
- Image concept: Server and client component planes separated by a narrow DTO membrane, with actions and route handlers shown as public entry paths.
- Outline focus: map entry points; create a DAL; protect secrets and serialization; authorize mutations; validate headers and deployment behavior.

## 64. Secure React Frontends Without Trusting the Browser

- Slug: `react-frontend-security-ai-code`
- Primary query: `react frontend security guide`
- Intent: stack guide
- Target: 1,400 words
- Stable tags: `vibe-coding-security`, `web-security`, `access-control`
- Reader problem: A React app may hide controls or validate input in the UI while leaving privileged APIs, unsafe HTML rendering, or browser-stored secrets exposed.
- Unique angle: React can reduce accidental HTML injection through normal JSX rendering, but the browser remains attacker-controlled. Authorization, secret handling, and data minimization belong at the server boundary.
- Direct-answer thesis: Treat all browser state and requests as untrusted, avoid raw HTML unless it is sanitized under a defined policy, never ship secrets, enforce authorization server-side, and test the APIs independently of the interface.
- Relevant entities: React 19.2, JSX, `dangerouslySetInnerHTML`, Server Functions, client state, local storage, CSP, DOM XSS.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/secret-exposure-scanner`
- Related dependency: `/blog/nextjs-ai-app-security` and `/blog/xss-ai-app-markdown-output`.
- Cannibalization boundary: This article owns the browser trust model in React. The XSS article owns a deeper injection tutorial, and Next.js owns server implementation details.
- FAQ decision: Include three. Cover JSX escaping, safe use of raw HTML, and whether hiding a button enforces authorization.
- Image concept: A translucent browser plane that can be inspected from all sides, with protected authorization and secrets remaining behind a server boundary.
- Outline focus: define browser trust; handle rendering safely; keep secrets out; enforce server authorization; add CSP and negative API tests.

## 65. Secure Node and Express APIs Generated by AI

- Slug: `node-express-ai-api-security`
- Primary query: `express api security checklist guide`
- Intent: stack guide
- Target: 1,450 words
- Stable tags: `vibe-coding-security`, `web-security`, `access-control`, `supply-chain`
- Reader problem: Generated Express APIs often have plausible routes but inconsistent validation, authorization, proxy trust, error handling, cookie settings, rate limits, or dependency controls.
- Unique angle: Build one ordered middleware and handler contract, then verify the deployment proxy assumptions. `trust proxy` and client IP logic are security-sensitive configuration, not a generic performance switch.
- Direct-answer thesis: Validate at each route, authenticate then authorize each resource, configure proxy trust to match the real ingress, use secure cookies and headers, bound request bodies and rates, sanitize errors, and keep Express plus dependencies current.
- Relevant entities: Node.js, Express 5, middleware order, Helmet, `trust proxy`, `express-session`, secure cookies, rate limiting, dependency audit, Node permission model.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/server-side-authorization-ai-apis` and `/blog/rate-limiting-ai-apps`.
- Cannibalization boundary: Own Express implementation and ingress configuration. Generic API authorization and rate limiting remain separate deep dives.
- FAQ decision: Include four. Cover Helmet, `trust proxy`, in-memory sessions, and whether Node's permission model replaces application authorization.
- Image concept: An API request corridor crossing ordered validation, authentication, authorization, and rate-limit gates before a service chamber.
- Outline focus: define middleware order; protect inputs and resources; set headers and cookies; configure ingress trust; handle failures and dependencies.

## 66. Secure FastAPI Code Generated by AI

- Slug: `fastapi-ai-generated-security`
- Primary query: `fastapi security checklist guide`
- Intent: stack guide
- Target: 1,450 words
- Stable tags: `vibe-coding-security`, `web-security`, `access-control`, `verification`
- Reader problem: Generated FastAPI projects can have valid Pydantic schemas and OAuth2 helpers while omitting object-level authorization, restrictive CORS, host validation, trusted proxy configuration, or production error controls.
- Unique angle: Distinguish request-shape validation from authorization. Typed request models do not determine whether the current principal may access a specific object.
- Direct-answer thesis: Validate identity and object authorization in dependencies or service code, configure explicit CORS origins, restrict trusted hosts and proxy headers, protect documentation where appropriate, handle secrets outside source, and run the app behind correctly configured TLS termination.
- Relevant entities: FastAPI, Pydantic, OAuth2, dependencies, CORSMiddleware, TrustedHostMiddleware, Uvicorn, proxy headers, TLS termination, Starlette.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/ai-app-security-checklist`
- Related dependency: `/blog/idor-ai-built-apps` and `/blog/cors-vibe-coded-apps`.
- Cannibalization boundary: Own FastAPI and ASGI implementation. The IDOR and CORS articles remain framework-neutral deep dives.
- FAQ decision: Include four. Cover Pydantic validation, wildcard CORS with credentials, proxy headers, and public OpenAPI docs.
- Image concept: A typed API contract entering a service through separate validation and authorization rings, with proxy and host boundaries outside.
- Outline focus: define dependency and service boundaries; authorize objects; configure CORS and hosts; deploy behind a trusted proxy; test negative cases.

## 67. Secure Vercel Deployments and Preview URLs

- Slug: `vercel-deployment-security`
- Primary query: `vercel security checklist guide`
- Intent: stack guide
- Target: 1,350 words
- Stable tags: `web-security`, `access-control`, `verification`
- Reader problem: A team may treat preview deployments as private while exposing real data, production credentials, shareable links, bypass tokens, or branch-specific services.
- Unique angle: A preview is a separate live environment, not a private screenshot. Review who can reach it, which environment variables and databases it uses, and how bypass mechanisms are stored and revoked.
- Direct-answer thesis: Enable appropriate deployment protection, isolate preview credentials and data, scope share and automation bypasses, avoid putting secrets in URLs, validate callback domains and headers, and delete or revoke access when a preview is no longer needed.
- Relevant entities: Vercel Preview, Production, Deployment Protection, Vercel Authentication, shareable links, automation bypass, environment variables, branch environments.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/security-headers-checker`
- Related dependency: `/blog/public-by-default-ai-apps` and `/blog/nextjs-ai-app-security`.
- Cannibalization boundary: This is the Vercel-specific control guide. The preview-deployment article owns provider-neutral threat modeling.
- FAQ decision: Include four. Cover default preview visibility, environment variable updates, shareable links, and automation bypass headers versus query strings.
- Image concept: Multiple branch deployments behind distinct access membranes, each connected to a separate credential and data compartment.
- Outline focus: inventory URLs; configure protection; isolate variables and data; secure bypasses and callbacks; verify and retire previews.

## 68. Secure Cloudflare Workers Built With AI

- Slug: `cloudflare-workers-ai-security`
- Primary query: `cloudflare workers security guide`
- Intent: stack guide
- Target: 1,450 words
- Stable tags: `vibe-coding-security`, `web-security`, `access-control`, `verification`
- Reader problem: Generated Worker code may mishandle bindings, secrets, redirects, untrusted upstream URLs, request bodies, cache keys, CORS, or fail-open routing even though the runtime isolates code.
- Unique angle: Distinguish platform isolation from application capability. Bindings are permissions, and outbound `fetch()` follows application-controlled policy. Runtime isolation does not validate authorization, upstream destinations, or response caching.
- Direct-answer thesis: Grant only required bindings, store credentials as secrets, validate hosts and redirects before outbound fetches, bound bodies and subrequests, configure authentication and CORS at the route, use fail-closed behavior for security-critical paths, and test with the real Worker configuration.
- Relevant entities: Cloudflare Workers, V8 isolates, bindings, Wrangler secrets, service bindings, `fetch`, redirects, `Authorization` headers, route fail modes, memory and subrequest limits.
- Authority link: `/blog/vibe-coding-security-guide`
- Tool CTA: `/tools/security-headers-checker`
- Related dependency: `/blog/ssrf-protection-dns-redirects` and `/blog/cors-vibe-coded-apps`.
- Cannibalization boundary: Own Worker runtime and binding-specific controls. The SSRF and CORS articles own complete vulnerability treatments.
- FAQ decision: Include four. Cover isolate security, bindings versus API tokens, redirect header forwarding, and fail-open routes.
- Image concept: A Worker isolate chamber with narrowly scoped binding conduits and an outbound request path stopped at a redirect policy gate.
- Outline focus: inventory capabilities; protect secrets; validate requests and upstreams; control caching and CORS; respect runtime limits; verify deployed configuration.

## Cross-batch link dependencies

The authority guide must publish before Batch 4. Batch 4 also expects earlier mapped articles on authorization, IDOR, CORS, XSS, secrets, headers, sessions, rate limiting, uploads, preview deployments, prompt injection, agent permissions, production access, and review workflows. Links to topics 69 or later, including `secure-mcp-server-guide`, `webhook-signature-verification`, and `two-account-idor-test`, must not become public until their target batch is published. Before Batch 4 publication, either hold those links behind the batch dependency check or replace them with already-published related articles.
