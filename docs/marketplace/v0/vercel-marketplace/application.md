# Vercel Marketplace provider application — draft

**State: PREPARATION. Not submitted.** This is a field-preparation document, not a claim that LyraShield is listed, approved, or eligible. A v0 chat MCP connection and a Vercel Marketplace integration are separate products and review routes.

## Draft public profile

| Field                       | Draft                                        | State                                                                                                                                                                |
| --------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration name            | LyraShield AI                                | Draft; confirm legal/publisher identity                                                                                                                              |
| Short description           | Release assurance for AI-built software      | Draft; 39 characters, within the documented 40-character limit                                                                                                       |
| Category                    | Security                                     | Candidate only; confirm with Vercel and product positioning                                                                                                          |
| Website                     | `https://lyrashieldai.com`                   | Existing public site                                                                                                                                                 |
| Documentation               | `https://lyrashieldai.com/docs`              | Existing public docs entry point; confirm final integration guide before submission                                                                                  |
| Privacy                     | `https://lyrashieldai.com/privacy`           | Existing public policy                                                                                                                                               |
| Support                     | `https://lyrashieldai.com/support`           | Existing public support page                                                                                                                                         |
| EULA                        | **Pending**                                  | No verified EULA URL was found in the product source                                                                                                                 |
| Developer/legal entity      | **Pending founder confirmation**             | Do not substitute the product brand if the form requires the legal entity                                                                                            |
| Contact email               | **Pending founder confirmation**             | Form requires a private Vercel contact email                                                                                                                         |
| Public support email        | `support@lyrashieldai.com`                   | Published on current support page source; confirm delivery/monitoring before submission                                                                              |
| Logo                        | `docs/marketplace/assets/lyrashield-400.png` | Existing PNG candidate; verify exact dimensions, opacity, and crop against current listing requirements                                                              |
| Feature media               | **Pending**                                  | Vercel's docs conflict: the prose says at least 1 image; the media table says 3–5 at 1440×960. Confirm in the current console and use only verified product behavior |
| Integration type / Base URL | **Pending product decision**                 | A native product requires a separate Vercel Marketplace integration server; the current MCP endpoint is not that server                                              |

## Draft overview

> LyraShield AI helps teams review code changes and authorized project targets, track scan coverage and evidence states, plan fixes, and inspect trusted retest outcomes. Results keep incomplete evidence visible and do not imply certification or guaranteed security.

## Required review before submission

- Choose connectable-account or native-integration scope. For a native product, design and implement the Marketplace API server, installation/resource lifecycle, account linkage, billing model, and failure handling before applying for product approval.
- Confirm legal developer name, contact and public support addresses, terms/EULA URL, integration agreement owner, and support operations.
- Confirm category, public copy, logo (non-transparent PNG, 256px minimum), and listing media against the current Vercel console. The current docs disagree on whether one or three images are the minimum; the media row permits up to five 1440×960 images.
- Confirm the integration's permissions and privacy behavior. Do not send LyraShield scan evidence, source contents, credentials, or model-cost information into Vercel Marketplace metadata.
- Submit only after the intended integration exists and passes the current Vercel approval checklist. Record the exact application state and listing URL separately from runtime compatibility.

Current official sources checked 2026-10-01: [Vercel Marketplace Program](https://vercel.com/marketplace/program), [integration types](https://vercel.com/docs/integrations), [create integration](https://vercel.com/docs/integrations/create-integration), [native product requirements](https://vercel.com/docs/integrations/create-integration/marketplace-product), [listing requirements](https://vercel.com/docs/integrations/create-integration/submit-integration), and [approval checklist](https://vercel.com/docs/integrations/create-integration/approval-checklist).
