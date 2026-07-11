# LyraSec AI Marketing Site

Astro 7 marketing site for `lyrasecai.com` (not yet attached). Lives at `apps/marketing` in the monorepo.

## Environment

Copy `.env.example` to `.env` and `.dev.vars.example` to `.dev.vars`, then edit both:

```bash
cp apps/marketing/.env.example apps/marketing/.env
cp apps/marketing/.dev.vars.example apps/marketing/.dev.vars
```

- Set `PUBLIC_SITE_URL` in `.env`.
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

## Manual deploy (Cloudflare Workers)

1. Run migrations to create the D1 database:

```bash
pnpm --filter @lyrashield/marketing exec wrangler d1 migrations apply lyrasec-marketing-waitlist --local
```

For production, create the D1 database and Rate Limit namespace in your Cloudflare account, then update `wrangler.jsonc` with the `database_id` and `ratelimits.namespace_id`. Set `WAITLIST_IP_SALT` via:

```bash
pnpm --filter @lyrashield/marketing exec wrangler secret put WAITLIST_IP_SALT
```

1. Build and deploy:

```bash
# Preview / staging
PUBLIC_SITE_URL=https://lyrasec-marketing.YOUR_SUBDOMAIN.workers.dev PUBLIC_INDEXABLE=false pnpm --filter @lyrashield/marketing build
pnpm --filter @lyrashield/marketing exec wrangler versions upload

# Production (only after founder approval and domain attach)
PUBLIC_SITE_URL=https://lyrasecai.com PUBLIC_INDEXABLE=true pnpm --filter @lyrashield/marketing build
pnpm --filter @lyrashield/marketing exec wrangler deploy
```

1. `PUBLIC_INDEXABLE` is `false` by default. Set it to `true` only on the real production domain after Vision QA and founder approval.

## No-JS waitlist fallback

The `POST /api/waitlist` endpoint accepts `application/x-www-form-urlencoded` as well as JSON. To test without JavaScript, run a build with `pnpm --filter @lyrashield/marketing build` and `pnpm --filter @lyrashield/marketing preview`, then use `curl`:

```bash
curl -X POST -d "email=you@example.com" -d "source=landing" http://localhost:4323/api/waitlist
```

## Notes

- No pricing, no fake metrics, no Strix.
- Blog posts are `draft: true` by default. Only un-draft a post after founder sign-off.
- See `BLOG_AUTHORING.md` for content rules.
