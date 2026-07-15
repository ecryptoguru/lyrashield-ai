# LyraShield AI Marketing Site

Astro 7 marketing site for the future LyraShield AI domain. Lives at `apps/marketing` in the monorepo.

## Public claim boundary

- Position LyraShield AI as evidence-backed release assurance for AI-built software, not as a generic AI scanner.
- Distinguish detected risks, independently verified findings, and retest-confirmed fixes.
- Describe scanner coverage and limitations explicitly; do not imply every control ran or every finding was verified.
- PR execution remains fail-closed until a server-generated patch can be bound to an exact approval.
- The public route set includes `/methodology`, which is the canonical explanation of evidence states, coverage, and non-claims. Keep homepage, tools, blog, and social copy aligned with it.

## Environment

Copy `.env.example` to `.env` and `.dev.vars.example` to `.dev.vars`, then edit both:

```bash
cp apps/marketing/.env.example apps/marketing/.env
cp apps/marketing/.dev.vars.example apps/marketing/.dev.vars
```

- Set `PUBLIC_SITE_URL` in `.env`.
- Set `PUBLIC_APP_URL` in `.env` to the app origin (e.g. `http://localhost:3001` for local dev, `https://app.example.com` for production). The build strips a trailing slash if present.
- Set `PUBLIC_TURNSTILE_SITE_KEY` for the production Lite Check. The app origin must set the matching `TURNSTILE_SECRET_KEY`; its scanner endpoint fails closed in production when that secret is absent.
- Set `PUBLIC_ABUSE_EMAIL` to the monitored abuse-report mailbox before enabling indexing. The address is rendered on `/terms`; the production build refuses `PUBLIC_INDEXABLE=true` without it.
- Set `PUBLIC_POSTHOG_KEY`/`PUBLIC_POSTHOG_HOST` only for an approved analytics project. Waitlist referral shares emit the coarse `waitlist_referral_share` event with an allowlisted channel; never add email or referral-code properties.
- Replace `WAITLIST_IP_SALT` in `.dev.vars` with a random 32+ character string (wrangler reads secrets from `.dev.vars` in local dev, not `.env`).
- `public/_headers` supplies the CSP, HSTS, framing, referrer, MIME, opener, and permissions policies for static assets. `src/middleware.ts` applies the same policy to Worker-generated responses and adds `no-store` plus `X-Robots-Tag: noindex` to `/api/*`. Keep the two policies aligned and place any future third-party browser origin inside the narrowest applicable directive.

## Local dev

```bash
pnpm --filter @lyrashield/marketing dev
```

This runs `wrangler types` before `astro dev` to generate `worker-configuration.d.ts`.

## Build and typecheck

```bash
pnpm --filter @lyrashield/marketing typecheck
pnpm --filter @lyrashield/marketing build
```

## Preview

```bash
pnpm --filter @lyrashield/marketing preview
```

The preview command applies local D1 migrations to Astro's generated Worker configuration before starting, so waitlist submissions work in the Worker-backed preview.

Use the URL Wrangler prints (normally `http://localhost:8787`) for Worker-backed API checks. Astro dev at `http://localhost:4321` is useful for UI iteration but does not prove generated Worker bindings or D1 migrations.

After running the marketing build, inspect the exact generated client artifact in the repository's Docker release surface:

```bash
docker compose --profile marketing up --build -d marketing
curl -fsS http://localhost:8787/
docker compose --profile marketing down
```

This Docker target proves the generated static pages and assets. The Worker-backed preview above separately proves Wrangler routing, D1 migrations, and waitlist API behavior because Astro's Cloudflare prerender subprocess is not reliable inside Docker Desktop's VM.

## Manual deploy (Cloudflare Workers)

1. Run migrations to create the D1 database:

```bash
pnpm --filter @lyrashield/marketing exec wrangler d1 migrations apply lyrashield-marketing-waitlist --local
```

Production D1 is provisioned and migrations `0001`–`0003` are applied for `lyrashieldai.com`. For a new environment, create the D1 database in that Cloudflare account, then update `wrangler.jsonc` with its `database_id`. The configured Cloudflare Rate Limit binding is the primary limiter; the endpoint retains an atomic D1 sliding-window fallback if that binding errors or is unavailable. Set `WAITLIST_IP_SALT` via:

```bash
pnpm --filter @lyrashield/marketing exec wrangler secret put WAITLIST_IP_SALT
```

2. Build and deploy:

```bash
# Preview / staging
PUBLIC_SITE_URL=https://lyrashield-marketing.YOUR_SUBDOMAIN.workers.dev \
PUBLIC_APP_URL=https://app.YOUR_SUBDOMAIN.workers.dev \
PUBLIC_INDEXABLE=false pnpm --filter @lyrashield/marketing build
pnpm --filter @lyrashield/marketing exec wrangler versions upload --config dist/server/wrangler.json

# Production (only after founder approval and domain attach)
PUBLIC_SITE_URL=https://lyrashieldai.com \
PUBLIC_APP_URL=https://app.example.com \
PUBLIC_INDEXABLE=true pnpm --filter @lyrashield/marketing build
pnpm --filter @lyrashield/marketing exec wrangler deploy --config dist/server/wrangler.json
```

3. Production uses `PUBLIC_INDEXABLE=true` on `lyrashieldai.com`. The ready marketing, methodology, sample-report, resource, and browser-local tool routes are indexable; `/scan` and `/terms` remain individually `noindex` and are excluded from the sitemap while the scanner API is unavailable. Cloudflare permanently redirects `www.lyrashieldai.com` to the apex with path and query preservation so canonical URLs have one origin. Preview builds may still use `PUBLIC_INDEXABLE=false`.

## Automatic production deploy (GitHub Actions)

The `deploy-marketing` job in `.github/workflows/ci.yml` runs only for a push to `main` that changes `apps/marketing` or a root dependency/build input. It waits for the repository security and release gates, builds the Worker, applies remote D1 migrations, deploys Astro's generated `dist/server/wrangler.json`, and then smoke-checks the canonical routes, API 404 boundary, and `www` redirect. A failed gate, migration, deployment, or smoke check fails the job.

Configure these GitHub Actions secrets for `ecryptoguru/lyrashield-ai`:

- `CLOUDFLARE_ACCOUNT_ID` — the production Cloudflare account ID.
- `CLOUDFLARE_API_TOKEN` — an account-owned token restricted to the production account with Workers Scripts Write, Workers KV Storage Write, D1 Write, Account Settings Read, and Workers Routes Write. The current token expires on July 16, 2027 and must be rotated in Cloudflare and GitHub before then. Do not use the Global API Key or a local interactive OAuth token.

The workflow pins both the Cloudflare action commit and Wrangler version. Rotate or revoke the API token in Cloudflare and replace the GitHub secret if it is ever exposed; never commit it or print it in workflow output.

The first automated production run completed successfully on July 16, 2026 and deployed Worker version `eba63368-9dd4-4dcb-bb0c-09f46c26ec7f`. Post-deploy verification covered both custom domains, D1/API error boundaries, defensive headers, all sitemap pages, discovered internal links, metadata/schema validity, console output, and mobile/desktop Lighthouse. A later version supersedes this identifier normally; use the successful main-branch workflow and Cloudflare deployment history as the current source of truth.

## Passive Lite Check

- `/scan` is the no-signup public UI. When `PUBLIC_APP_URL` is set, the Astro page calls `PUBLIC_APP_URL/api/lite-scan`; without a public app origin, the form fails closed and explains that live scanning is unavailable. Do not move the fetch into the Cloudflare marketing Worker because the Node app endpoint reuses the DNS-resolving, connection-pinned SSRF client in `@lyrashield/security`.
- The endpoint performs one bounded public-page GET and reads at most six same-origin JavaScript/CSS assets already linked by that page. It never logs in, sends attack payloads, queries a BaaS table/collection, actively tests RLS, fuzzes, or spiders arbitrary paths.
- Enabling the production scanner requires `PUBLIC_APP_URL`, Turnstile, a monitored `PUBLIC_ABUSE_EMAIL`, and the scanner-specific hashed-IP rate limit together. Until then the ready marketing surface can remain indexable while `/scan` fails closed and stays `noindex`. Redirects are capped at three, every hop is re-resolved and pinned, request/body work is time- and byte-bounded, and page/asset contents are not persisted.
- The deterministic detector is versioned in `packages/security/src/lite-scan.ts`. Supabase anon/publishable values, Firebase web config, Stripe publishable keys, and reCAPTCHA site keys never become exposed-secret findings. A Supabase/Firebase marker is only a data-layer review signal.
- Saved cards are stateless signed URLs generated by `POST /api/lite-scorecards`. `buildLiteScorecardPayload()` is the sole constructor and allows only aggregate counters, versions, a timestamp, and an optional waitlist referral code. It has no field for target URLs, findings, headers, matched values, or exploit detail.
- `/sample-report` is synthetic and labeled. `/terms` is a pre-launch acceptable-use summary; founder-approved legal text and the monitored abuse mailbox remain go-live gates.
- See `docs/lite-scanner.md` for the trust boundary, verification matrix, and launch checklist.

## Waitlist referral and sharing loop

- `POST /api/waitlist` always returns the same success shape for a new address, an existing address, and the honeypot path. JSON responses include a referral code in every case; do not change this contract in a way that reveals whether an email exists.
- Waitlist request bodies are streamed with a 16 KiB limit and accept only JSON or URL-encoded form data. Oversized and unsupported payloads return `413` and `415` before rate-limit or D1 work.
- `?ref=<8-character-code>` attributes a valid new signup and increments the referrer's count. Invalid codes do not break signup.
- `GET /api/waitlist/position?code=<code>` returns `{ position, referrals }` with `Cache-Control: no-store`.
- After JavaScript submission, the success state shows position/referral progress and Copy, LinkedIn, X, and WhatsApp actions. The shared URL is the canonical marketing origin with only `?ref=` added.
- Tool CTAs may add only `source=tools` or `source=tool`; the API normalizes any other source to `landing`. Do not add target names, pasted values, filenames, or referral details to attribution.
- Clipboard denial must leave a readable “Copy unavailable” state. External channel buttons open a new tab with `noopener,noreferrer`.
- This ladder is pre-launch prioritization, not a guaranteed invitation or monetary reward. Do not describe it as one.

Worker-preview smoke:

```bash
curl -fsS -H 'Content-Type: application/json' \
  -d '{"email":"qa@example.com","source":"manual"}' \
  http://localhost:8787/api/waitlist
curl -fsS 'http://localhost:8787/api/waitlist/position?code=<returned-code>'
```

Use a disposable local address. Do not run this against production with a real person's email unless they asked to join.

## No-JS waitlist fallback

The `POST /api/waitlist` endpoint accepts `application/x-www-form-urlencoded` as well as JSON. To test without JavaScript, run a build with `pnpm --filter @lyrashield/marketing build` and `pnpm --filter @lyrashield/marketing preview`, then use `curl`:

```bash
curl -X POST -d "email=you@example.com" -d "source=landing" http://localhost:8787/api/waitlist
```

## Notes

- `/tools` is a browser-local free-utility hub. The launch checklist, headers/CORS checker, secret scanner, Supabase RLS checker, and JWT/session inspector intentionally do not fetch a supplied target or upload pasted text/files. They are bounded heuristics, not security scans; see `docs/plans/2026-07-14-vibe-coder-security-seo-tools-plan.md` for the product and publishing boundaries.
- The pre-launch header intentionally hides Sign in when `PUBLIC_APP_URL` is unset. Configure a real app origin before exposing that destination.
- No pricing, no fake metrics, no public mention of the forked engine.
- Blog posts are `draft: true` by default. Only un-draft a post after founder sign-off.
- Marketing share buttons promote the waitlist referral link. Product scorecards, grades, verified-fix cards, and README badges come from the app origin and must never be recreated or edited as marketing artwork.
- See `BLOG_AUTHORING.md` for content rules.
