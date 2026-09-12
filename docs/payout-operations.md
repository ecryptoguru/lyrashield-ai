# Affiliate payout operations

This document retains the approved payout operating model and the unresolved provider and tax gates. It is an internal execution checklist, not legal or tax advice. Current provider requirements and Indian tax treatment must be confirmed with the paying entity's authorized dealer bank and qualified tax adviser before production payouts.

## Approved operating model

- The paying entity is the Indian company. Polar collects payments only and does not pay affiliates.
- India affiliate payouts use RazorpayX in INR.
- Non-India affiliate payouts use Payoneer Enterprise Mass Payouts, subject to partnership and API approval. BriskPe or Cashfree is the fallback if the primary rail is unavailable or unsuitable.
- Payout eligibility remains a $100 minimum, monthly net-30 payment on the 15th, a 30-day hold, completed tax-form gate, a 25% reserve for a new affiliate's first 90 days, and automatic clawback for provider-confirmed refunds or chargebacks.
- Payouts remain disabled until provider credentials, recipient validation, delivery webhooks, idempotency, rejection handling, reconciliation, tax-form handling, and operator procedures pass production-scoped verification.

## Gates before activation

- Obtain and verify RazorpayX production payout access for domestic INR payouts.
- Obtain Payoneer partnership approval, API access, commercial terms, recipient KYC/tax flow, and webhook behavior.
- Confirm the outward-remittance funding path with the Indian authorized dealer bank.
- Confirm the applicable purpose code, Form 15CA/15CB process, TDS treatment including section 194H, GST treatment for registered affiliates, and DTAA or treaty handling for non-residents.
- Record provider-hosted delivery, application and ledger effects, replay idempotency, rejection and ambiguous-outcome handling, reconciliation, cancellation or recovery behavior, and redacted evidence before enabling scheduled payouts.

The implementation state remains defined by `AGENTS.md`, `PRD.md`, and code under `packages/affiliate`. Historical provider comparisons and planning rationale remain in Git at commit `e3fa791f` under `monetization.md`.
