# LyraShield AI Lite Check

Status: implemented on a feature branch for engineering and founder review. It is not deployed or founder-approved.

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

The marketing client sends the requested funnel events only when the approved PostHog project is configured and browser privacy controls allow capture. The target hostname is SHA-256 hashed in the browser. Events do not contain the URL, page content, matched value, email, IP, user agent, finding text, or referral code value.

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

## Go-live gate

Do not enable `PUBLIC_INDEXABLE=true` or deploy publicly until all are true:

1. Founder approves the route, copy, distinct Lite Check naming, referral coupling, and final legal terms.
2. `PUBLIC_SITE_URL`, `PUBLIC_SCANNER_URL`, `PUBLIC_TURNSTILE_SITE_KEY`, `PUBLIC_ABUSE_EMAIL`, `PUBLIC_POSTHOG_KEY`, and production bindings are set; the scanner origin has `TURNSTILE_SECRET_KEY`, trusted proxy configuration, and shared Upstash rate limiting. `PUBLIC_APP_URL` is set separately only when authenticated-app links are ready.
3. The real marketing and app origins pass CORS, scan, waitlist, scorecard, referral, OG unfurl, mobile, keyboard, reduced-motion, and error-state QA.
4. X, LinkedIn, and Reddit render the PNG card correctly from the real app domain.
5. Logs confirm no submitted URL query, matched value, response body, or raw client IP is retained.
6. Founder gives final public-artifact approval after Vision QA.
