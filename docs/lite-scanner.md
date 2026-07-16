# LyraShield AI Lite Check

Status: deployed at `https://lyrashieldai.com/scan` with the scanner API isolated at `https://scanner.lyrashieldai.com`. Production Turnstile, origin-scoped CORS, rate limiting, monitored abuse routing, health/readiness, and a real browser Lite Check have passed. This status does not include the authenticated application or full worker/engine scan pipeline.

## Product boundary

The public route is `/scan`. It returns a distinct **Lite Check**, never the official deterministic LyraShield Score. Findings appear without signup. Email is used only for the waitlist and optional saved scorecard.

The check is passive and outside-only:

- GET the submitted public page;
- read its response headers;
- GET at most six same-origin JavaScript or CSS assets already linked by that page;
- detect high-confidence credential patterns without retaining or returning the matched value;
- review baseline browser headers, HTTPS/mixed-content basics, supported data-layer markers, and public framework fingerprints.

It does not authenticate, exploit, fuzz, brute-force, enumerate a database, actively test row-level security, crawl arbitrary paths, or fetch an exposed `.env` path. Those actions require an ownership-verified full-scan contract and are intentionally outside this free tool.

## Runtime and trust boundary

The Astro marketing app owns the SEO page and client state. `POST /api/lite-scan` runs on the Next.js Node origin because `@lyrashield/security/safeFetch` resolves every hostname, rejects private/reserved addresses, pins the approved address at connection time, and repeats validation on every redirect.

Limits:

- HTTP(S) only; credentials, query strings, and fragments are rejected by the shared SSRF guard;
- private, loopback, link-local, metadata, CGNAT, benchmark, multicast, reserved, IPv4-mapped IPv6, unique-local, link-local IPv6, and site-local IPv6 are blocked;
- three redirects maximum, with every hop revalidated;
- 10 second timeout per request;
- 4 MiB public-page body plus at most six 750 KiB linked assets;
- same-origin assets only, including after redirects;
- scanner-specific five-per-minute hashed-IP rate limit with Upstash in production and bounded in-memory fallback;
- Turnstile verification fails closed in production;
- no server-side persistence of the target body, asset content, matched secret values, or result.

## Result integrity and public sharing

`packages/security/src/lite-scan.ts` owns the versioned deterministic pattern and result contract. Public-by-design values are explicitly excluded from secret findings. BaaS presence is educational context, not a confirmed RLS or authorization vulnerability.

`packages/security/src/lite-scorecard.ts` owns the public-card disclosure allowlist. A card contains only:

- payload and check versions;
- generation time;
- aggregate counts for needs attention, worth reviewing, and looks OK;
- an optional eight-character waitlist referral code.

The Next.js app HMAC-signs this payload before generating `/lite-check/[token]` and its 1200×630 PNG. There is no payload field for the scanned target, headers, findings, matched strings, or exploit detail. These cards are `noindex` and `Referrer-Policy: no-referrer`.

## Analytics and privacy

The marketing client sends the requested funnel events only when the approved PostHog project is configured and browser privacy controls allow capture. The target hostname is SHA-256 hashed in the browser. Manual `$pageview` and `$pageleave` events retain only origin and pathname, and a final send hook removes query strings and fragments from URL/referrer properties on all events. Web Vitals capture records CLS, FCP, LCP, and INP through the managed `pulse.lyrashieldai.com` proxy. Events do not contain the scanned URL, page content, matched value, email, IP, user agent, finding text, or referral code value. Automatic pageview capture, general autocapture, and session recording remain disabled; DNT and GPC opt out.

Waitlist email is submitted with consent to the existing D1 endpoint. The existing non-leaking duplicate/honeypot response and referral ladder remain unchanged.

## Verification matrix

Automated coverage includes:

- shared SSRF ranges, metadata addresses, encoded IPs, DNS rebinding, timeout, and pinned connections;
- Lite endpoint attestation, origin restriction, SSRF precheck, redirect/time/byte options, and same-origin asset selection;
- public Supabase anon JWT, Firebase web config, Stripe publishable key, and reCAPTCHA values do not trigger secret findings;
- Stripe/OpenAI/GitHub/private-key/service-role patterns do trigger a value-redacted finding;
- RLS remains a review signal with explicit no-query wording;
- card payload construction drops out-of-contract target/secret fields and signed tokens reject tampering;
- exact public copy, no-signup findings, non-overstatement, analytics hash property, WebApplication schema, and FAQ schema.

## Production boundary and remaining gates

The passive Lite Check launch gate is complete: the canonical site, isolated scanner origin, Turnstile, abuse address, Upstash limiter, PostHog project, CORS, fail-closed bot check, five browser-local tools, waitlist boundaries, and a real scan are live and verified. Keep the following separate:

1. `PUBLIC_APP_URL` remains unset until the authenticated application has its own deployment and QA.
2. Full repository scans require BullMQ-compatible TLS Redis, private evidence storage, dedicated sandbox-capable worker compute, authorized models, and controlled egress; the Lite Scanner's Supabase/Upstash/Azure Container App deployment does not supply that pipeline.
3. Public app scorecards still require real-origin card/badge, revocation, referral, human-event deduplication, and external-network unfurl checks.
4. Logs must continue to exclude submitted query data, matched values, response bodies, and raw client IPs. Any change to the payload or crawl boundary requires a fresh privacy/security review.
