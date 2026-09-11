# LyraShield AI — Litepaper

**Version 1.0.0 — 2026-09-12**

> A short, public overview of LyraShield AI: what it does, who it is for, and how it earns trust. For the full product narrative see [`whitepaper.md`](./whitepaper.md); for the technical specification see [`yellowpaper.md`](./yellowpaper.md).

---

## 1. The problem

Software is increasingly written by AI coding agents and AI-assisted builders. It ships fast — and mostly unreviewed. The result is a widening gap between "it works" and "it is ready": exposed secrets, vulnerable dependencies, missing access controls, unsafe agent tool surfaces, and AI-specific failure modes that generic scanners were never designed to look for.

Existing answers are incomplete. Point scanners produce findings without evidence of what was actually tested. Traditional review processes assume a human wrote the code and a security team exists. Neither describes how AI-built software actually ships.

## 2. What LyraShield AI is

LyraShield AI is the **evidence-backed release-assurance layer for AI-built software**. One loop, at every depth:

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

- Connect an authorized repository, web app, or API.
- Record what was tested — and what could not be.
- Separate detected risks, retest-confirmed outcomes, independently verified findings, and inconclusive results.
- Explain each risk in plain language while retaining the technical evidence.
- Produce approval-gated fix proposals, server-owned retests, and shareable assurance reports.
- Never claim broader coverage or certainty than retained evidence supports.

## 3. Two modes, one account

| Mode              | Execution                                              | Commercial model                         |
| ----------------- | ------------------------------------------------------ | ---------------------------------------- |
| **Cloud**         | Hosted app and worker — LyraShield runs the scans      | Subscription                             |
| **Local/Desktop** | The customer's machine — bring-your-own AI credentials | One-year license with perpetual fallback |

Both modes share the same engine and the same loop. Optional Cloud Sync moves selected Local findings into the Cloud dashboard; nothing syncs by default.

## 4. What's covered

- **Vibe Security 50** — a versioned 50-control coverage contract across code, URL, and operational risk families. Every scan produces an immutable per-control receipt; an unreported control is never presented as passed.
- **Launch Gate** — a named, versioned readiness standard producing `READY` / `NOT_READY` / `INSUFFICIENT_EVIDENCE` verdicts, persisted append-only per target.
- **Launch Readiness Report** — a signed, shareable, publicly verifiable artifact bound to a frozen evidence payload.
- **AI-Built Failure Taxonomy** — a public, citable catalog of how AI-built apps characteristically fail, every class traced to live controls.
- **WebMCP Assurance** — 14 deterministic controls over browser-registered agent tool surfaces.
- **AI App Security** — eight deterministic signals mapped to the OWASP Top 10 for LLM Applications (2025).
- **Lite Check** — a free, passive, no-signup outside-in check of a public URL.
- **Distribution** — CLI, MCP server, agent plugin for 26 client surfaces, a diff-aware GitHub Action, and a versioned public API.

## 5. Honest evidence states

Trust comes from not overclaiming. Every result carries an explicit state:

| State                             | Meaning                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `DETECTED`                        | A scanner reported a candidate with retained provenance               |
| `VALIDATED`                       | A server-owned deterministic retest confirmed the condition is absent |
| `VERIFIED`                        | Independent trusted verification evidence exists                      |
| `INCONCLUSIVE`                    | Coverage, evidence, or verifier result is insufficient                |
| `NOT_ASSESSED` / `NOT_APPLICABLE` | The control was not evaluated or does not apply                       |

Confidence is triage metadata, never proof. Engine-only absence is always inconclusive.

## 6. Business model at a glance

- **Cloud** — two product lines. _Scan_ (find what's wrong): free 14-day trial, Starter, Pro. _Launch Assurance_ (prove it to a third party): Launch Assurance tier, contact-led Enterprise. Metered in agent-minutes; failed scans are never billed.
- **Local/Desktop** — one-time one-year licenses (Individual, Team perpetual, Team subscription) plus a Cloud Sync add-on. No lifetime deals.
- **Affiliates** — application-gated program: 25% recurring for 12 months on Cloud monthly plans, 20% one-time on Local licenses.
- **Free surface** — Lite Check, browser-local tools, the GitHub Action, and technical content are the acquisition engine; there is no permanent free product tier.

Final publishable pricing and production purchase admission remain founder-gated launch decisions.

## 7. Roadmap at a glance

Phase 1 (current): AI app builders, founders, agencies, and small SaaS teams — live in open beta with open registration.

Phase 2 (planned): enterprise governance — SSO/SCIM, advanced policy, private workers, evidence export, and enterprise integrations — sequenced behind design-partner validation, not speculation.

## 8. What we do not claim

LyraShield AI does not claim certification, compliance, guaranteed security, universal detection, or adversarial robustness. Reports are evidence summaries, not SOC 2, ISO, GDPR, or PCI attestations. Every public statement is bounded by the claims-readiness policy summarized in the whitepaper.

## 9. Links

- Product: `https://app.lyrashieldai.com`
- Free Lite Check: `https://lyrashieldai.com/scan`
- Methodology and tools: `https://lyrashieldai.com`
- Full detail: [`whitepaper.md`](./whitepaper.md) · [`yellowpaper.md`](./yellowpaper.md)

---

_This litepaper describes product behavior and commercial structure. It is not a certification, an audit report, or a guarantee of security outcomes._
