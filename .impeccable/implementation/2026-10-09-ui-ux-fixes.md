# Marketing and account-access UI/UX fixes

Implemented all 25 findings from the October 9 audit in the local source on
`codex/ui-ux-audit-fixes`. This is local implementation and verification evidence,
not deployment evidence. Existing and concurrent unrelated changes are preserved.

| Audit finding                                 | Resolution                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Light hero CTA contrast                       | Explicit white foreground in light theme; computed contrast regression check                |
| Blog search scope                             | Searches all published titles, descriptions and topics; clear and empty-state recovery      |
| Myra/mobile CTA collision                     | Launcher uses measured sticky-bar height, including responsive changes                      |
| No-finding advice resembles urgent findings   | Actual finding actions, coverage follow-ups and collapsed general guidance are distinct     |
| SQL risk presentation                         | Structured observation intent replaces English-text severity inference for SQL              |
| Trial tool wording                            | Catalog-derived trial terms and explicit scan-depth limits                                  |
| Pricing decisions precede prices              | Removed duplicate chooser; mode/currency controls precede priced plan cards                 |
| Agent finder buried                           | Client directory precedes general setup; hero links directly to it                          |
| Cramped comparison tables                     | Readable minimum column widths, local scrolling, keyboard focus and mobile cue              |
| TOC destinations hidden by header             | Scroll offsets on article H2/H3 destinations                                                |
| Long illustrated category lists               | Compact searchable article rows without repeated hero images                                |
| Verdict terminology relationship              | Explains current receipt-based gate versus frozen-score public scorecard semantics          |
| Repeated homepage/methodology/Vault decisions | One consent-bound homepage Lite input; sample explanation below; duplicate closers removed  |
| Unavailable demo booking                      | Direct demo-request email with timezone guidance; scheduling details hidden until available |
| Tool sample actions                           | Synthetic header, SQL and JWT example loaders with limits stated                            |
| Comparison hint map                           | Correct Corgea key and Pixee hint                                                           |
| Guard evaluation wording                      | Behavior-and-limits wording aligned across page, schema and navigation                      |
| Research CTA                                  | Clear evidence-approach CTA with unpublished-research status retained                       |
| Docs breadcrumb                               | Removes SEO brand suffix from the navigation label                                          |
| Verification resend false success             | Returned API error checked before success and cooldown                                      |
| Signup provider failure recovery              | Explanation and Retry, independent of acquisition/invitation effects                        |
| Hidden signup loading status                  | Accessible status outside the hidden skeleton                                               |
| Tokenless reset state                         | Immediate invalid-link recovery; no password request                                        |
| Signup reassurance                            | Catalog-derived trial capacity and selected-plan acknowledgement; no payment implied        |
| Mobile auth brand continuity                  | Product wordmark and marketing link                                                         |

## Verification

- Marketing unit suite: 536 tests in 59 files passed.
- Auth regression suite: 10 tests in three files passed.
- Impacted browser suite: 71 passed, one expected skip for a disabled local scanner
  input. A separate mocked focus test verifies sticky-CTA coordination without a scan.
- Astro validation: zero errors, zero warnings, one existing Myra async-function hint.
- Web typecheck and web test typecheck passed; lint and supported-file Prettier passed.
- Production marketing build passed, including CSP validation for 274 HTML files.
- Web production build compiled and typechecked; initial page-data collection rejected
  local mock calendar configuration. Full build passed with `MYRA_WRITES_ENABLED=0`
  for that process only. No environment file or production setting was changed.
- Plain marketing `tsc` cannot resolve an existing test's `.astro` import. Supported
  Astro validation passed. No type-check configuration was weakened.
- `git diff --check` passed.

Two independent reviewers inspected the implemented marketing and auth pages in
desktop/mobile and both themes. Local auth mocks verified provider 503 to Retry
to restored options, and resend 429 to an error with no false success or cooldown.
No production account, email, booking, payment or scan action was submitted.

Detector reconciliation: 193 signals, 191 advisory and two warnings. The warnings
are an unused incumbent accent-border style and an image-regex test false positive.
Advisories reflect existing partial design-token definitions and intentional styles;
they do not represent 193 unresolved UX defects. No broad detector ignores were added.

Raw check logs: `output/playwright/ui-fixes/checks/`.
Marketing captures: `output/playwright/ui-fixes-a/`.
Auth proof: `output/playwright/landing-audit/auth-fix-b-proof.json` and related captures.

The processed critique snapshot was closed after its priority issues were resolved.
No commit, push, PR, merge or deployment was performed. Production email delivery,
OAuth completion, authenticated onboarding, real-device/screen-reader behavior and
Core Web Vitals were not established by this local verification.
