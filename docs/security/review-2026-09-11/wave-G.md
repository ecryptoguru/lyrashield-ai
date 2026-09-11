# Wave G — Marketing site & public web surface security review

Baseline: `main` @ `3b289a43`. Primary threat actor: T1 (external unauthenticated user).
Scope: `apps/marketing` (Astro + Cloudflare Worker, D1, rate-limit binding), `apps/marketing-motion`,
`public/` assets, and the Lite Scanner / waitlist / referral client flows.

- Files reviewed: ~56 — wrangler.jsonc, astro.config.mjs, middleware.ts, content.config.ts, env.d.ts;
  all of `src/pages/api/**`; every `.ts` endpoint (llms.txt, robots.txt, rss.xml, agents.md,
  webmcp-controls.json); scan.astro, index.astro, pricing.astro, compare/[slug].astro,
  compare/index.astro, tools/[slug].astro, tools/index.astro, webmcp.astro, ai-safety.astro,
  terms.astro, about.astro, methodology.astro, agents.astro, vibe-security-50.astro; layouts
  Base/ToolLayout/DocsLayout/BlogPost; components SeoHead, JsonLd, WaitlistForm, AgentSnippet,
  HomeLiteScan, evidence-world, AiAppSecurityScanner, WebMcpSecurityLab, ComparisonPricingLadder;
  lib/ request-body, waitlist-rate-limit, public-url, motion-manifest, webmcp-security,
  webmcp-analyzer.worker, webmcp-config, tool-checks, tools, ai-app-security, jsonc;
  public/_headers + _redirects; .env/.dev.vars examples; marketing-motion main.ts, publish-r2.mjs,
  r2-cors.json; all 14 compare/*.md disclaimers; shared WebMcpSignal/AISignal types.
- Findings: 0. No Critical/High/Medium vulnerabilities meeting the T1 high-confidence bar.

## Findings

None confirmed. Every public write path (`/api/waitlist`, `/api/waitlist/position`) is
origin-gated, bounded, schema-validated, parameterized, and rate-limited with a fail-closed
fallback; every other public route is prerendered or generated from build-time registries with
no request-controlled input.

## Needs Verification

- **[VERIFY-G-001] `set:html={disclaimer}` on compare pages** — `compare/[slug].astro:64` injects
  the `disclaimer` frontmatter string as raw HTML; `content.config.ts:67` constrains it only with
  `z.string().min(80)` (no markup sanitization). All 14 current compare disclaimers are plain
  text/markdown-link prose committed via PR, so under a repo-trust assumption there is no
  T1-reachable path. Becomes stored XSS only if frontmatter can ever be authored outside reviewed
  commits (CMS/generated/third-party flow). Confirm no such path; sanitize before `set:html` if added.
- **[VERIFY-G-002] `www`→apex redirect lives outside the repo** — wrangler.jsonc attaches the worker
  to both `lyrashieldai.com` and `www.lyrashieldai.com`; README states Cloudflare 301s www→apex.
  Not in-repo verifiable; impact if absent is duplicate-origin serving (SEO), plus `/api/waitlist`
  403s `Origin: https://www.lyrashieldai.com` posts since `isTrustedOrigin` pins apex only.
  (Parent review note: live probe confirms www→apex 301 IS active in production.)

## Verified safe (high-confidence)

- `/api/waitlist` POST: Origin/Referer gate on every request (absent/null → 403) vs configured
  apex; 16 KiB streamed body bound; JSON/urlencoded allowlist; Zod bounds all fields (email ≤254,
  referralCode 8-char Crockford regex); WAITLIST_RL 5/60s → atomic D1 `INSERT…WHERE COUNT<5`
  fallback, both fail closed; missing `WAITLIST_IP_SALT` → 500; IP = `cf-connecting-ip` only,
  stored as sha256(ip:salt); all `.bind()` parameterized; duplicate email → identical success with
  existing code; honeypot → unpersisted decoy; `referredBy` no-ops on nonexistent codes.
- `/api/waitlist/position` GET: code uppercased + regexed; parameterized; rate-limited (`position:`
  key); `no-store`; aggregate position/count only; codes ≈39-bit CSPRNG — unguessable + rate-limited.
- Lite Scanner client: `normalizePublicHttpUrl` rejects credentials/control chars/non-http(s)/
  localhost/`.local`/bare hosts/`%`-hosts; NFKC+ASCII reapplied; Turnstile on scan; scorecard mint
  uses fresh `getResponse()` (v16 `75410d54` confirmed, token never reused); results via
  `textContent`/`replaceChildren`; `learnMoreUrl` https-only; scorecard URL resolved against
  configured app origin; `?start=1` reads same-origin sessionStorage only; 30 s abort; no
  credentials flag on cross-origin fetches.
- Referral/analytics: `?ref=` regex-validated, sent only on explicit submit — no stuffing;
  PostHog `respect_dnt` + explicit DNT/GPC → `opt_out_capturing()` before first capture;
  autocapture/pageview/recording off; URLs stripped of query+fragment in `before_send`.
- Headers/CSP: middleware + `_headers` parity — CSP (default-src 'self', object-src 'none',
  base-uri 'self', form-action 'self', frame-ancestors 'none', upgrade-insecure-requests on https),
  COOP, Permissions-Policy, Referrer-Policy, HSTS+preload, nosniff, XFO DENY; `/api/*` gets
  no-store + noindex; static redirect map only.
- Config/secrets: vars all PUBLIC_*; `WAITLIST_IP_SALT` server-secret, absent from vars;
  workers_dev/preview_urls off; example files placeholder-only; no live secrets found; build
  refuses INDEXABLE=true without public-HTTPS origins; Turnstile+abuse-email required with scanner.
- Canonical/OG/JSON-LD: built from `Astro.site`/`PUBLIC_SITE_URL` (validated), never request Host;
  JsonLd escapes `<` → `<` before set:html; no internal-origin leakage.
- Content endpoints (llms.txt, robots.txt, rss.xml, agents.md, webmcp-controls.json, sitemap):
  generated from committed registries only — no request input → no poisoning path.
- Dynamic routes all `getStaticPaths` over trusted collections — arbitrary slugs 404 at platform.
- Local tools: fully client-side, zero network; Worker has no eval/fetch/importScripts; every
  innerHTML sink escapes dynamic values; unescaped interpolations are enum/number-typed
  (`line` verified `number` in shared types).
- marketing-motion: deterministic (no fetch/Math.random); publish requires --confirm-production,
  refuses immutable-hash overwrite, whitelists content types; r2-cors.json = GET/HEAD + Range
  from apex only.
- No proxy/SSRF surface on the worker; imageService passthrough; no KV binding (scope N/A).
- CSRF/header-injection/downloads: no ambient authority on origin; Origin/Referer gate covers
  no-JS form path; user input never in response headers; no outbound email binding; public/
  serves committed static assets only — no traversal.
- Observability: worker logs+traces enabled (1.0/0.1 sampling) — `/api/*` abuse signal retained.

## Hygiene notes (below finding threshold)

- Markdown links inside compare disclaimers render literally through `set:html` (cosmetic only).
- Duplicate-email responses return the existing referral code → knowing a subscriber's email
  yields their position/count via the position endpoint. Accepted trade-off (indistinguishable
  success); codes aren't secrets.
- `connect-src https:` is broad — tightening to enumerated hosts reduces post-XSS exfil headroom.
- waitlist and position use independent per-IP 5/60s budgets — documented, not a gap.
