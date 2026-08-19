# LyraShield — Track B Standalone BYOK App (Local/Desktop): Dev-Ready Brief

Dev-ready brief for the LyraShield Developer Agent: Track B — package the lyrashield-engine as a standalone BYOK local/desktop app (LyraShield Local/Desktop) sold as a 1-year license. BYOK model config, local scan UX (CLI/TUI + GUI), thin custom license/activation/update server with offline grace + perpetual fallback, optional cloud sync to LyraShield cloud. All terms founder-confirmed 2026-08-15.

## Goal, Context & Constraints

# Local Mode — LyraShield Local/Desktop (BYOK): Dev-Ready Brief

**Owner:** LyraShield Developer Agent. **Repos:** `ecryptoguru/lyrashield-engine` (the local scan engine — primary) and `ecryptoguru/lyrashield-ai` (monorepo — license/update service + optional cloud-sync endpoints live here). **Do NOT route to the Lyrafin Developer Agent.**

## Goal

Build **Local mode** of the single LyraShield app — **"LyraShield Local / LyraShield Desktop"** — sold as a **one-time 1-year license**, running **entirely on the customer's own AI (BYOK)** so LyraShield carries **zero LLM COGS**, with **local scanning + optional cloud sync** to the customer's LyraShield Cloud account.

> **Unified-structure note (founder, 2026-08-15):** LyraShield is **one app, two modes** — **Local** (this brief) and **Cloud** (the Sprint-10 subscription brief). Same engine, same core loop, **one account**. Local is a **paid license**; Cloud is a **subscription**. Cloud sync is the bridge from Local to Cloud.

## What already exists (verified — build on this)

- `lyrashield-engine` is a **local CLI** that runs scans in a hardened Docker sandbox, model-routed via env. It **already supports ChatGPT subscription sign-in** (`lyrashield auth login chatgpt`, runs record `cost: 0`) and **Azure OpenAI/Foundry** — these are the launch BYOK paths.
- **Engine constraint (verified):** the engine currently **requires a GPT-5.6 Terra or Luna deployment** and rejects non-GPT-5.6 models before scan start; **local/self-hosted endpoints are unsupported** until the engine adds them. So **local models are a deferred, net-new engine workstream**, not config.
- Engine runs modes SAFE/QUICK/STANDARD/DEEP/CUSTOM with budget caps; produces findings, run.json, SARIF, reports. Telemetry **forced off** in the adapter.
- The cloud app (`apps/web`) holds the dashboard/tenancy/findings DB; the MCP server is a thin client over its REST API. **Local mode does not depend on the cloud app to scan** — only for the optional sync.

## Founder-confirmed parameters (2026-08-15 — do not change)

- **Model:** one-time **1-year license**, all updates included, **perpetual fallback** (keep last eligible build forever). **BYOK** (customer's own AI — zero LLM cost to us). **Local scan + optional cloud sync.**
- **Individual:** **$199 launch / $299 regular** one-time, up to 3 machines, renewal **$199/yr**.
- **Team:** **$99/seat perpetual (min 3) + $59/seat/yr renewal**, AND **$149/seat/yr** annual sub with cloud sync; 10% off at 10+ seats.
- **Cloud-sync add-on:** included in team sub; **$49/yr** for individuals.
- **No lifetime deal** (standing rule). **No refunds** (company policy).
- **UX scope at launch:** **both** a polished **CLI/TUI** (devs) and a **desktop GUI** (vibe coders).
- **License server:** **thin custom activation/update endpoint** in existing infra (signed license + offline grace + signed updates).
- **BYOK providers at launch:** **ChatGPT/OpenAI subscription sign-in (OAuth) + Azure OpenAI subscription.** **Local/self-hosted models are deferred** (engine gap) — roadmap, not launch. (An earlier "OpenAI API key + local model" line is superseded by this subscription-first scope.)
- **Branding:** edition label under LyraShield AI — "LyraShield Local" / "LyraShield Desktop."

## Agent-minute & Deep-scan relationship (important — differs from Cloud)

- **Local mode bills ZERO agent-minutes.** Agent-minutes are a **Cloud** construct (we pay for LLM there). In Local, the customer's own AI pays — so there is **no usage metering** on Local.
- **Deep/Custom scans ARE available in Local mode.** The "Deep = Pro+" gate is a **Cloud** tier control (it bounds _our_ Terra COGS). In Local, the customer's own AI pays for the deeper scan, so gating it would be artificial. **Do not port Cloud's scan-depth gating into Local.** (License tier may still gate _seats/machines_, not scan depth.)

## Hard constraints

- **Privacy is the product promise and must be literally true:** scans + LLM calls run locally against the customer's own endpoint; LyraShield never receives code, findings, or tokens. Telemetry stays **off by default**. Cloud sync is **opt-in and explicit** only.
- Never name the upstream scan engine publicly; no benchmark/accuracy/"only-we" claims; no FUD; **no money-back claims** (no-refund policy).
- The engine fork stays **thin** (boundary: `lyrashield_adapter/` shelling into unmodified upstream). Engine repo gate: `bash scripts/verify-thin-fork.sh` must be green before engine PRs.
- **Branch + PR, verify green, merge only on explicit founder approval.** High-risk: licensing/activation, signed updates, BYOK credential handling, any cloud-sync data path.

## Product Scope & Architecture

## Product scope & architecture

**The four build pieces:**

### 1. Local scan app (CLI/TUI + GUI)

- **CLI/TUI (devs):** a polished terminal front-end over the engine — configure target (repo path / URL), pick scan mode, run, stream progress, view findings + fix suggestions, export SARIF/report. Reuse the engine's existing CLI run contract (`--max-budget`, modes).
- **Desktop GUI (vibe coders):** a thin desktop shell (Tauri recommended — small, secure, Rust-based; Electron acceptable) wrapping the same local engine + local results store. Guided flow: point at a project → connect your AI → scan → see findings in plain language → apply/export fixes.
- **Local results store:** findings/reports persist **locally** (SQLite, encrypted at rest) — no cloud required.
- **All scan depths available** (Safe/Quick/Standard/Deep/Custom) — the customer's own AI pays, so there's no Cloud-style depth gating in Local. **No agent-minute metering in Local mode.**
- **Docker sandbox:** the engine already sandboxes scans in Docker. The app must detect/provision Docker (or a bundled runtime) and give a clear setup path for non-Docker users.

### 2. BYOK model configuration (subscriptions-first)

- Friendly setup for the customer's own AI, mapping to the engine's existing routing. **Launch providers:**
  - **ChatGPT / OpenAI subscription sign-in (OAuth)** → the engine's `lyrashield auth login chatgpt` path (runs record `cost: 0`). Store the token in the OS keychain.
  - **Azure OpenAI / Foundry subscription** → `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` (or `AZURE_AI_*`).
- **Deferred (roadmap, not launch):** local/self-hosted models (Ollama/LM Studio) — the engine doesn't support them yet (requires GPT-5.6 Terra/Luna today). If a local-model option is shown in UI, mark it clearly "experimental / coming."
- Validate the credential/endpoint on setup (a tiny test call) and surface clear errors. Let users pick a model profile per scan mode (map to LUNA/TERRA/fallback).
- **Never** ship or embed LyraShield's own model keys. The app runs only on customer-supplied credentials/subscriptions.

### 3. License + activation + update server (thin custom, in `apps/web` or a small service)

- **Purchase → license key issued** (via the payment provider's license-key delivery, or a small `licenses` table + signed key). One-time purchase flow — **not** the Sprint-10 subscription engine.
- **Activation endpoint:** the app activates a key online → server returns a **signed license file** (product, seat count, update-eligibility expiry = purchase + 1 year, machine ids) cached locally. **Offline grace:** honor a valid cached signed license without phoning home; never block a scan on network.
- **Seat enforcement:** individual = up to 3 machines; team = per-seat via the license manager. Accept casual sharing (dev-tool norm); enforce via activation counts, not invasive DRM.
- **Perpetual fallback logic:** after the 1-year update window, the app keeps running the **last build it was eligible for** indefinitely; it just stops accepting _newer_ updates. Never deactivates.
- **Signed update channel:** publish versioned, **signed** update artifacts; the app verifies signatures before applying. Renewal extends the update-eligibility date.

### 4. Optional cloud sync (the bridge to Cloud mode)

- A Local-mode user can **opt in** to connect their LyraShield account → sync findings/reports/history to the cloud dashboard. This is the **Local→Cloud bridge**: sync introduces them to the Cloud platform (dashboard, history, team, monitoring, CI gating), which is a separate paid subscription.
- Sync is a **separate, explicit, authenticated** path (existing `LYRASHIELD_API_KEY` / OAuth device flow). Nothing syncs by default.
- Cloud-sync entitlement: included in any Cloud sub; **$49/yr add-on** for Local-only users (enforced server-side on the sync endpoint)."}, {"name": "Acceptance Criteria", "content": "## Acceptance criteria (verify before claiming done)\n\n**Local app (CLI/TUI + GUI)**\n- [ ] CLI/TUI runs a full local scan end-to-end against a local repo/URL using a BYOK subscription/credential, producing findings + SARIF/report, streaming progress, no cloud dependency.\n- [ ] Desktop GUI (Tauri/Electron) does the same via a guided flow; local encrypted results store; Docker detect/setup path with clear errors.\n- [ ] All scan depths (incl. Deep/Custom) run locally; **no agent-minute metering** in Local mode.\n\n**BYOK**\n- [ ] ChatGPT/OpenAI subscription sign-in (OAuth) + Azure OpenAI subscription configurable; credentials validated on setup; stored in OS keychain; model profile selectable per scan mode.\n- [ ] Local/self-hosted models either absent or clearly marked experimental/roadmap (not a supported launch claim).\n- [ ] App contains **no** embedded LyraShield model keys; runs only on customer credentials/subscriptions.\n\n**License & updates**\n- [ ] Thin custom activation endpoint issues signed 1-year licenses (individual 3-machine / team per-seat); offline grace honored; **perpetual fallback** keeps the last eligible build running after the window; renewal extends update eligibility.\n- [ ] Signed update channel; app verifies signatures before applying; no remote-code eval.\n\n**Cloud sync (optional)**\n- [ ] Opt-in connect to a LyraShield account; explicit sync of chosen findings/reports over TLS; sync entitlement enforced (Cloud sub included / $49 individual add-on); nothing syncs by default.\n\n**Security & brand**\n- [ ] No customer code/findings/keys leave the machine except explicit opt-in sync; telemetry off by default; secrets redacted from logs/artifacts.\n- [ ] Engine thin-fork gate green (`scripts/verify-thin-fork.sh`); web repo gates green (`pnpm lint/typecheck/test/build`); no benchmark/only-we claims; no public naming of the upstream engine; no money-back claims.\n\n**Process:** branch + PR (never push to main), verify green, merge only on explicit founder approval. This brief is independent of Sprint-10 Cloud billing — Local mode's license payment is a one-time purchase flow, not the subscription engine."}

## BYOK Credential Handling & Security

## BYOK credential handling & security (high-risk)

This is the most sensitive part — the app holds the customer's AI keys and (on sync) cloud tokens.

- **Store credentials in the OS keychain** (macOS Keychain / Windows DPAPI / Linux Secret Service), never plaintext files. The existing `~/.lyrashield/credentials.json` pattern (0o600) is acceptable for the CLI's own LyraShield token, but customer AI keys go in the keychain.
- **Redact secrets** from all logs, run artifacts, and reports (the engine already redacts before LLM summarization/report persistence — keep that boundary).
- **No LyraShield telemetry** on code, findings, prompts, or keys. If any product analytics are added, they must be strictly opt-in, allowlisted, and free of code/finding/key material.
- **Threat model the activation/update path:** signed licenses (asymmetric), signed updates, no eval of remote code, pin the update channel origin.
- **Local sandbox isolation** stays as-is (the engine's Docker sandbox); document that scans execute against the customer's target under their own authorization.
- Cloud-sync payload: only findings/reports the user explicitly chooses to sync, over TLS, to their authenticated workspace.

## Acceptance Criteria

## Acceptance criteria (verify before claiming done)

**Local app (CLI/TUI + GUI)**

- [ ] CLI/TUI runs a full local scan end-to-end against a local repo/URL using a BYOK subscription/credential, producing findings + SARIF/report, streaming progress, no cloud dependency.
- [ ] Desktop GUI (Tauri/Electron) does the same via a guided flow; local encrypted results store; Docker detect/setup path with clear errors.
- [ ] All scan depths (incl. Deep/Custom) run locally; **no agent-minute metering** in Local mode.

**BYOK**

- [ ] ChatGPT/OpenAI subscription sign-in (OAuth) + Azure OpenAI subscription configurable; credentials validated on setup; stored in OS keychain; model profile selectable per scan mode.
- [ ] Local/self-hosted models either absent or clearly marked experimental/roadmap (not a supported launch claim).
- [ ] App contains **no** embedded LyraShield model keys; runs only on customer credentials/subscriptions.

**License & updates**

- [ ] Thin custom activation endpoint issues signed 1-year licenses (individual 3-machine / team per-seat); offline grace honored; **perpetual fallback** keeps the last eligible build running after the window; renewal extends update eligibility.
- [ ] Signed update channel; app verifies signatures before applying; no remote-code eval.

**Cloud sync (optional)**

- [ ] Opt-in connect to a LyraShield account; explicit sync of chosen findings/reports over TLS; sync entitlement enforced (Cloud sub included / $49 individual add-on); nothing syncs by default.

**Security & brand**

- [ ] No customer code/findings/keys leave the machine except explicit opt-in sync; telemetry off by default; secrets redacted from logs/artifacts.
- [ ] Engine thin-fork gate green (`scripts/verify-thin-fork.sh`); web repo gates green (`pnpm lint/typecheck/test/build`); no benchmark/only-we claims; no public naming of the upstream engine; no money-back claims.

**Process:** branch + PR (never push to main), verify green, merge only on explicit founder approval. This brief is independent of Sprint-10 Cloud billing — Local mode's license payment is a one-time purchase flow, not the subscription engine.

## Open Build Questions for Dev to Confirm

## Open build questions (dev to confirm with founder before/while building)

1. **Desktop shell:** Tauri (recommended — small/secure) vs Electron — confirm choice.
2. **Docker dependency:** require Docker, or bundle/provision a runtime for non-Docker (vibe-coder) users? Recommend a guided Docker install for v1 + document a fallback.
3. **License purchase delivery:** deliver the license key via the payment provider (Gumroad/Lemon Squeezy/Polar license keys) vs a custom `licenses` table + email. Recommend the simplest that gives a signed key.
4. **Update distribution:** where signed update artifacts are hosted (release CDN) + the signing key management.
5. **Local-model contract:** which local servers/models are officially supported at launch (Ollama? LM Studio?) and the minimum capability bar.
6. **GUI scope for v1:** which flows are in the desktop GUI vs CLI-only (recommend GUI = scan + findings + fix export; advanced config stays CLI).
