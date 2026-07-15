# Cloudflare and marketing code review — 2026-07-16

## Scope and evidence

This review covered the Astro landing-page route set, shared header/footer/waitlist UX, Worker API boundaries, generated Cloudflare configuration, production response behavior, GitHub Actions, and the current live `lyrashieldai.com` surface. Evidence came from source inspection, generated `dist/server/wrangler.json`, Wrangler/D1 local runtime checks, mobile rendered interaction, HTTP response inspection, and Lighthouse baselines.

The review intentionally did not treat the public marketing Worker as proof of the separate Next.js application, Lite Scanner API, production scan infrastructure, or external social unfurls.

## Findings and resolutions

| Priority | Finding                                                                                                                                                           | Resolution                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Mobile visitors had no primary navigation because every landing-page link was hidden below `sm`.                                                                  | Added an accessible native `details` menu with 44 px targets and no client framework. Mobile rendered QA confirms all destinations are reachable and there is no horizontal overflow.                                               |
| P1       | Worker-generated waitlist responses did not inherit the static `_headers` policy. API errors lacked CSP, HSTS, MIME, referrer, no-cache, and indexing protection. | Added Astro middleware that applies the defensive policy to dynamic responses and adds `Cache-Control: no-store` plus `X-Robots-Tag: noindex` to `/api/*`.                                                                          |
| P1       | The waitlist endpoint read attacker-controlled JSON/form bodies without a byte limit and accepted unnecessary multipart bodies.                                   | Added a streaming 16 KiB parser. Only JSON and URL-encoded forms are accepted; oversized bodies return `413` and unsupported media return `415`. Real tests cover both header-independent stream limits and content-type rejection. |
| P1       | Production marketing deploys were manual and no Cloudflare GitHub Actions credentials or deployment gate existed.                                                 | Added a main-only, marketing-path-aware deploy job after the existing security/test/build gates. It applies D1 migrations, deploys the generated Astro config with pinned action/tool versions, and smoke-checks production.        |
| P2       | Worker exception logging could serialize raw D1/runtime errors without a stable event shape.                                                                      | Replaced it with a structured event containing only the event name and safe error class.                                                                                                                                            |
| P2       | Observability was enabled without explicit log/trace behavior.                                                                                                    | Enabled invocation logs at full sampling and traces at 10% sampling in the source config; the generated Worker config retains these values.                                                                                         |
| P2       | Hero actions were content-width on narrow screens and stale footer copy reduced consistency.                                                                      | Made both hero actions full-width on mobile and aligned the footer with “release assurance” positioning. Submission retries now clear stale inline errors first.                                                                    |

No P0 issue was found. The P1 items above were release-quality gaps because they affected navigation, public API hardening, bounded resource use, or repeatable deployment.

## Optimization decisions

- Keep the current Astro static-first architecture. The live homepage baseline was already 96 performance and 100 accessibility/best-practices/SEO on mobile and desktop, with zero blocking script work; a new menu runtime or component library would add cost without value.
- Keep Wrangler `4.110.0` pinned in CI for reproducible deployment. `4.111.0` is available, but this change has no demonstrated need for the upgrade.
- Keep the `2026-07-08` compatibility date for this release. It is current and already exercised; compatibility-date changes should be isolated and tested rather than bundled with deployment automation.
- Deploy only Astro's generated `apps/marketing/dist/server/wrangler.json`. The root `wrangler.jsonc` remains the binding/build source, not the deploy artifact.
- Avoid speculative font/image work. The measured live homepage transferred about 128 KiB and had zero total blocking time, so the strongest improvements were correctness and operational reliability rather than asset churn.

## Verification contract

The release gate is: focused parser/header tests → marketing lint/typecheck/build → Worker-backed D1/API smoke → rendered mobile/desktop interaction → Docker artifact smoke → full repository lint/typecheck/test/build/E2E/format/diff checks → pull-request CI → merge → main-branch Cloudflare deploy → live header/link/Lighthouse smoke.

Cloudflare and GitHub setup remain incomplete until the account-scoped API token is stored as `CLOUDFLARE_API_TOKEN` and the first merged marketing change completes the production deployment job.
