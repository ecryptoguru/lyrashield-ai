# LyraShield AI — Litepaper

## Version 1.1.0 — 2026-10-06

> A short, public overview of LyraShield AI: what it does, who it is for, what makes it different and how it earns trust. For the full product narrative see [`whitepaper.md`](./whitepaper.md); for the technical specification see [`yellowpaper.md`](./yellowpaper.md).

---

## 1. The problem

Software is increasingly written by AI coding agents and AI-assisted builders. It ships fast — and mostly unreviewed. The result is a widening gap between "it works" and "it is ready": exposed secrets, vulnerable dependencies, missing access controls, unsafe agent tool surfaces and AI-specific failure modes that generic scanners were never designed to look for.

Existing answers are incomplete. Point scanners produce findings without evidence of what was actually tested. Traditional review processes assume a human wrote the code and a security team exists. Neither describes how AI-built software actually ships.

## 2. What LyraShield AI is

LyraShield AI is the **evidence-backed release-assurance layer for AI-built software**. One loop, at every depth:

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

- Connect an authorized repository, web app or API.
- Record what was tested — and what could not be.
- Separate detected risks, retest-confirmed outcomes, independently verified findings and inconclusive results.
- Explain each risk in plain language while retaining the technical evidence.
- Produce approval-gated fix proposals, server-owned retests and shareable assurance reports.
- Never claim broader coverage or certainty than retained evidence supports.

## 3. What makes it different

Most security tools answer "what did the scanner flag?" LyraShield answers "what was tested, what was proven and what remains unknown — and can you show that to a client, investor or reviewer?"

1. **Evidence states, not confidence scores.** Every result carries an explicit state — `DETECTED`, `VALIDATED`, `VERIFIED` or `INCONCLUSIVE`. Confidence is triage metadata and never proof; engine-only absence is always inconclusive. A score or AI suggestion is never treated as verification.
2. **Purpose-built for AI-built software.** The public AI-Built Failure Taxonomy catalogs how AI-generated apps characteristically fail; eight deterministic AI App Security signals (AI-01–AI-08) map to the OWASP Top 10 for LLM Applications (2025); 14 WebMCP controls review the agent tool surface itself — agent rules, MCP configs, embedded secrets and prompt-injection exposure.
3. **It runs where the coding agent runs.** A published CLI, an MCP server with 21 tools over stdio and remote Streamable HTTP with hosted OAuth, a portable Agent Plugin, a 51-entry install registry resolving to 48 preferred client surfaces and an account-less, diff-aware GitHub Action. Assurance without leaving the editor, terminal or CI pipeline.
4. **An approval-gated fix loop that closes itself.** Fix pull requests are created only from a server-generated patch bound to an explicit human approval — no client-authored patches, nothing auto-merges. When a fix branch merges, the server automatically queues a fresh retest and re-evaluates the release gate.
5. **A launch verdict you can verify yourself.** The Launch Gate is a named, versioned standard producing `READY` / `NOT_READY` / `INSUFFICIENT_EVIDENCE` per target. Launch Readiness Reports are ed25519-signed with a public verify endpoint, and release-identity confirmation answers only `MATCH`, `MISMATCH` or `UNAVAILABLE` for a caller-supplied commit or artifact digest.
6. **Honest coverage accounting.** The Vibe Security 50 contract records one immutable receipt per control; "no finding" is never presented as "passed", and seven operational controls are explicitly marked evidence-required because no scan can prove them.
7. **Two modes, one loop.** Cloud (hosted subscription; LyraShield pays model cost) and Local/Desktop (one-year BYOK license with perpetual fallback; scans run on your machine and nothing syncs by default).
8. **Fail-closed trust architecture.** Tenant isolation by Postgres row-level security, engine output treated as untrusted and bounded and every result manifest binding the exact product revision, worker image digest and engine revision into its checksum.

These differentiators are product design choices, not performance claims. LyraShield does not claim broader detection than its retained evidence supports (§8).

## 4. Two modes, one account

| Mode              | Execution                                              | Commercial model                         |
| ----------------- | ------------------------------------------------------ | ---------------------------------------- |
| **Cloud**         | Hosted app and worker — LyraShield runs the scans      | Subscription                             |
| **Local/Desktop** | The customer's machine — bring-your-own AI credentials | One-year license with perpetual fallback |

Both modes share the same engine and the same loop. Optional Cloud Sync moves selected Local findings into the Cloud dashboard; nothing syncs by default.

## 5. What's covered

- **Vibe Security 50** — a versioned 50-control coverage contract across code, URL and operational risk families. Every scan produces an immutable per-control receipt; an unreported control is never presented as passed.
- **Launch Gate** — a named, versioned readiness standard producing `READY` / `NOT_READY` / `INSUFFICIENT_EVIDENCE` verdicts, persisted append-only per target.
- **Launch Readiness Report** — a signed, shareable, publicly verifiable artifact bound to a frozen evidence payload.
- **AI-Built Failure Taxonomy** — a public, citable catalog of how AI-built apps characteristically fail, every class traced to live controls.
- **WebMCP Assurance** — 14 deterministic controls over browser-registered agent tool surfaces.
- **AI App Security** — eight deterministic signals mapped to the OWASP Top 10 for LLM Applications (2025).
- **Lite Check** — a free, passive, no-signup outside-in check of a public URL.
- **Distribution** — CLI, MCP server and a 51-entry install registry resolving to 48 preferred client surfaces, a diff-aware GitHub Action and a versioned public API. A documented workflow is not a verified installation on every client and platform.

## 6. Honest evidence states

Trust comes from not overclaiming. Every result carries an explicit state:

| State                             | Meaning                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `DETECTED`                        | A scanner reported a candidate with retained provenance               |
| `VALIDATED`                       | A server-owned deterministic retest confirmed the condition is absent |
| `VERIFIED`                        | Independent trusted verification evidence exists                      |
| `INCONCLUSIVE`                    | Coverage, evidence or verifier result is insufficient                 |
| `NOT_ASSESSED` / `NOT_APPLICABLE` | The control was not evaluated or does not apply                       |

Confidence is triage metadata, never proof. Engine-only absence is always inconclusive.

## 7. Business model at a glance

- **Cloud** — two product lines. _Scan_ (find what's wrong): free 7-day trial, Starter, Pro. _Agency_ (team assurance): Agency tier and contact-led Enterprise. Metered in agent-minutes; failed scans are never billed.
- **Local/Desktop** — one-time one-year licenses (Individual, Team perpetual, Team subscription) plus a Cloud Sync add-on. No lifetime deals.
- **Affiliates** — application-gated program: 25% recurring for 12 months on Cloud monthly plans, 20% one-time on Local licenses.
- **Free surface** — Lite Check, browser-local tools, the GitHub Action and technical content are the acquisition engine; there is no permanent free product tier.

Final publishable pricing and production purchase admission remain founder-gated launch decisions.

## 8. What we do not claim

LyraShield AI does not claim certification, compliance, guaranteed security, universal detection or adversarial robustness. Reports are evidence summaries, not SOC 2, ISO, GDPR or PCI attestations. Every public statement is bounded by the claims-readiness policy summarized in the whitepaper.

## 9. Roadmap at a glance

Phase 1 (current): AI app builders, founders, agencies and small SaaS teams — live in open beta with open registration.

Phase 2 (planned): enterprise governance — SSO/SCIM, advanced policy, private workers, evidence export and enterprise integrations — sequenced behind design-partner validation, not speculation.

## 10. Links

- Product: `https://app.lyrashieldai.com`
- Free Lite Check: `https://lyrashieldai.com/scan`
- Methodology and tools: `https://lyrashieldai.com`
- Full detail: [`whitepaper.md`](./whitepaper.md) · [`yellowpaper.md`](./yellowpaper.md)

---

_This litepaper describes product behavior and commercial structure. It is not a certification, an audit report or a guarantee of security outcomes._
