# LyraSec AI — Current Next Steps

> Updated 2026-07-11 from the merged code and CI. Historical implementation detail belongs in `codebase.md`; product backlog belongs in `PRD.md`.

## Current baseline

- `main` CI passes lint, typecheck, build, and **607 tests in 48 files**.
- The engine thin fork is merged in [lyrashield-engine PR #1](https://github.com/ecryptoguru/lyrashield-engine/pull/1). The worker image builds with the engine CLI, but no authorized sandbox scan has been run.
- The Cloudflare marketing site is implemented and remains intentionally non-indexable until launch approval. Its local Worker preview is `http://localhost:8787` when started with the generated Wrangler configuration.

## Do next

### 1. Controlled scan release gate

Owner: engineering + founder authorization.

1. Provide authorized `LYRASHIELD_LLM` and `LLM_API_KEY` values.
2. Use the pinned production sandbox digest, not a mutable tag.
3. Run one approved target through the full worker lifecycle and retain the resulting audit evidence.
4. Keep Docker health proof separate from sandbox-execution proof.

### 2. Billing and usage limits

Owner: engineering + founder pricing decision.

Billing (Sprint 10+) is the principal unbuilt Phase 1 feature. Confirm pricing, usage metric, and payment-provider scope before implementation; do not publish pricing from draft material.

### 3. Marketing launch gate

Owner: founder + marketing + engineering.

1. Confirm the LyraSec AI public domain and trademark direction.
2. Replace Cloudflare D1 and Rate Limit placeholders; set `WAITLIST_IP_SALT` as a Worker secret.
3. Build with the production `PUBLIC_SITE_URL` and only then set `PUBLIC_INDEXABLE=true`.
4. Apply D1 migrations, deploy with `dist/server/wrangler.json`, and verify canonical URLs, sitemap, robots, waitlist submission, and visual QA on the real domain.
5. Publish only founder-approved posts. Current sample posts remain drafts by design.

### 4. Deployment defense in depth

Owner: engineering / infrastructure.

Application-level SSRF protections are in place. Add transport-level egress control with DNS pinning before exposing scans to untrusted targets at scale.

## Deferred roadmap

- Security Copilot sidebar and visual security plan
- Enterprise identity, SCIM, policy engine, private worker, VPC, BYOK/BYOM
- IaC/container and reachability scanning

## Founder decisions still needed

- Public domain and trademark clearance
- Pricing, plan boundaries, and billing provider
- Design-partner and public-launch timing
- Authorized model/provider and first controlled-scan target
