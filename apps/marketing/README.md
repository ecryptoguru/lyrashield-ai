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
- Set `PUBLIC_POSTHOG_KEY`/`PUBLIC_POSTHOG_HOST` only for an approved analytics project. Waitlist referral shares emit the coarse `waitlist_referral_share` event with an allowlisted channel; never add email or referral-code properties.
- Replace `WAITLIST_IP_SALT` in `.dev.vars` with a random 32+ character string (wrangler reads secrets from `.dev.vars` in local dev, not `.env`).

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

## Manual deploy (Cloudflare Workers)

1. Run migrations to create the D1 database:

```bash
pnpm --filter @lyrashield/marketing exec wrangler d1 migrations apply lyrashield-marketing-waitlist --local
```

For production, create the D1 database and Rate Limit namespace in your Cloudflare account, then update `wrangler.jsonc` with the `database_id` and `ratelimits.namespace_id`. Set `WAITLIST_IP_SALT` via:

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
PUBLIC_SITE_URL=https://example.com \
PUBLIC_APP_URL=https://app.example.com \
PUBLIC_INDEXABLE=true pnpm --filter @lyrashield/marketing build
pnpm --filter @lyrashield/marketing exec wrangler deploy --config dist/server/wrangler.json
```

3. `PUBLIC_INDEXABLE` is `false` by default. Set it to `true` only on the real production domain after visual QA, referral/share verification, and founder approval.

## Waitlist referral and sharing loop

- `POST /api/waitlist` always returns the same success shape for a new address, an existing address, and the honeypot path. JSON responses include a referral code in every case; do not change this contract in a way that reveals whether an email exists.
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
