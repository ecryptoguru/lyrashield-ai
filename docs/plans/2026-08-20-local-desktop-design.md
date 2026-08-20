# LyraShield Local/Desktop App — Architecture Design

> Status: **Approved 2026-08-20**. This is the design doc for the LyraShield Local/Desktop Tauri app (Task C). The server-side licensing contract is already built, merged, and live; the desktop is a client of it.

## 1. Product framing

LyraShield is **one app, two modes** under **one account**:

- **Cloud mode** — the existing web app at `app.lyrashieldai.com` (subscription, agent-minutes, dashboard).
- **Local mode** — the desktop app (this design). Runs scans on the user's machine via their own AI (BYOK). Sold as a one-time 1-year license with perpetual fallback.

Branding: an edition label under LyraShield AI — "LyraShield Local" / "LyraShield Desktop". Never a separate brand.

Privacy promise (literally true): telemetry off by default; code, findings, and keys never leave the machine unless the user explicitly syncs.

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────┐
│                   Tauri v2 App                       │
│                                                      │
│  ┌─────────────┐    ┌─────────────────────────────┐ │
│  │  Rust Core  │    │     React Frontend (Vite)    │ │
│  │             │    │                              │ │
│  │  License    │◄──►│  ActivationScreen            │ │
│  │  Verify     │    │  SetupScreen                 │ │
│  │  (ed25519)  │    │  ScanLaunchScreen            │ │
│  │             │    │  ScanProgressScreen          │ │
│  │  BYOK       │    │  ScanResultsScreen           │ │
│  │  (keychain) │    │  ScanHistoryScreen           │ │
│  │             │    │  UpdateScreen                │ │
│  │  Engine     │    │  SyncSetupScreen             │ │
│  │  Shell      │    │  SyncStatusScreen            │ │
│  │             │    │                              │ │
│  │  SQLite     │    │  Tailwind CSS v4             │ │
│  │  Store      │    │  (matches apps/web tokens)   │ │
│  │             │    │                              │ │
│  │  HTTP Client│    │                              │ │
│  │  (reqwest)  │    │                              │ │
│  └──────┬──────┘    └─────────────────────────────┘ │
│         │                                            │
└─────────┼────────────────────────────────────────────┘
          │ spawn (shell out to PATH)
          ▼
┌─────────────────────┐    ┌──────────────────┐
│  lyrashield-engine  │    │  Docker Desktop  │
│  (Python CLI)       │───►│  (scan sandbox)  │
│  strix/auth_cli     │    │                  │
│  strix/cli          │    └──────────────────┘
└─────────────────────┘
          │ HTTPS (only on activation/reconnect/sync)
          ▼
┌─────────────────────────────────────────────────────┐
│           app.lyrashieldai.com (existing)            │
│                                                      │
│  POST /api/licenses/activate                        │
│  POST /api/licenses/verify                          │
│  POST /api/sync/connect                             │
│  POST /api/sync/findings                            │
│  GET/PUT /api/sync/cursor                           │
└─────────────────────────────────────────────────────┘
```

### Module map

| Module                     | Language | Responsibility                                                                                                 |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `src/license/`             | Rust     | ed25519 license verification (port of `@lyrashield/licenses`), blob decode, local storage, golden-vector tests |
| `src/byok/`                | Rust     | BYOK credential management: ChatGPT auth (delegated to engine CLI), Azure OpenAI (OS keychain)                 |
| `src/runtime/`             | Rust     | Engine + Docker detection, process spawning utilities                                                          |
| `src/scan/`                | Rust     | Scan lifecycle: spawn engine, stream progress, parse output, persist to SQLite, SARIF/report export            |
| `src/updater/`             | Rust     | Update eligibility gating (`isBuildInstallable`), Tauri updater plugin integration                             |
| `src/sync/`                | Rust     | Optional cloud sync client (`/api/sync/*`), batched findings upload, cursor management                         |
| `src/api.rs`               | Rust     | HTTP client for license + sync endpoints (reqwest)                                                             |
| `src/commands.rs`          | Rust     | Tauri IPC command registration (bridge between Rust core and React frontend)                                   |
| `frontend/src/screens/`    | React/TS | All UI screens                                                                                                 |
| `frontend/src/components/` | React/TS | Reusable UI components                                                                                         |
| `frontend/src/lib/`        | React/TS | Tauri invoke wrappers, shared types                                                                            |

## 3. Data flows

### 3.1 Activation

```
User pastes license key
  → Frontend calls invoke("activate_license", { licenseKey, machineId })
  → Rust: POST /api/licenses/activate { licenseKey, machineId }
  → Server: validates key hash, checks seat cap (Individual=3, Team=1/seat),
            issues signed license file, returns { license, blob, licenseId }
  → Rust: decode blob, verify signature against bundled public key,
            save license.json to app data dir (0o600)
  → Frontend: show LicenseStatusScreen (SKU, seats, expiry)
```

### 3.2 Offline grace

```
App starts
  → Rust: load_license() from app data dir
  → Rust: verify_license() against bundled public key (no network)
  → If valid → app runs fully offline
  → If signature_mismatch → clear license, show ActivationScreen
```

### 3.3 Revalidation on reconnect

```
Network available + license stored
  → Rust: POST /api/licenses/verify { licenseId }
  → Server: checks DB for revoked flag
  → If revoked → { valid: false, revoked: true, reason: "LICENSE_REVOKED" }
  → Rust: clear_license() → hard-stop → show ActivationScreen
  → If not revoked → continue with cached license
```

### 3.4 Scan

```
User picks target + mode + budget
  → Frontend calls invoke("start_scan", { target, mode, goal, budget })
  → Rust: load BYOK creds from keychain (Azure) or rely on engine's own auth (ChatGPT)
  → Rust: spawn `lyrashield --target <target> --scan-mode <mode> --max-budget <budget>`
  → Rust: stream stdout/stderr via Tauri events → Frontend: ScanProgressScreen
  → Engine: runs in Docker sandbox, produces findings + run.json
  → Rust: parse output, persist findings to SQLite
  → Frontend: ScanResultsScreen (findings, export, open output dir)
```

### 3.5 Update

```
App starts (or manual check)
  → Rust: check Tauri updater for latest.json from GitHub Releases
  → If update available:
    → Rust: should_install_update(license, newVersion)
    → If eligible → "Update available" banner
    → If past perpetualFallbackBuild → "Update eligibility expired. Last eligible: vX.Y.Z"
  → User clicks install → Tauri updater verifies signature against bundled pubkey → installs
```

### 3.6 Sync (opt-in)

```
User connects workspace (explicit action)
  → Rust: POST /api/sync/connect { apiKey, licenseId }
  → Server: checks sync entitlement (sync_addon, team_subscription, or paid Cloud plan)
  → If entitled → save connection to SQLite
  → If not entitled → error: "Cloud Sync requires a Team subscription or the $49/yr sync add-on"

User clicks "Sync now" on a scan
  → Rust: load findings from SQLite, batch (max 500/batch)
  → Rust: POST /api/sync/findings { batch }
  → Rust: PUT /api/sync/cursor { cursor }
  → Handle 409 CURSOR_REWIND by re-fetching server cursor
```

## 4. License verification — Rust port

The desktop verifies licenses in **compiled Rust** (not webview JS) to keep the trust path outside the XSS-attackable webview.

### Algorithm (must be byte-identical to `packages/licenses/src/`)

1. **`canonical_json(value)`** — lexicographic key sort at every depth, no whitespace, `undefined`→omit, `null`→`"null"`, arrays preserve order. Port of `sign.ts:canonicalJSON`.
2. **`signing_bytes(payload)`** — `canonical_json(payload).into_bytes()`. The exact bytes the ed25519 signature covers.
3. **`verify_license(file, pubkey_pem)`** — validate payload fields (sku non-empty string, seatCount finite 1..10000, machineIds string[], updateEligibleUntil parseable date) → verify ed25519 signature over `signing_bytes` against bundled public key → check `updateEligible` separately from `valid`. Port of `verify.ts:verifyLicense`.
4. **`is_build_installable(license, build_version)`** — if `updateEligibleUntil` in future → any build; if expired → only builds `<= perpetualFallbackBuild` (semver compare, pre-release tags stripped). Port of `verify.ts:isBuildInstallable`.

### Golden-vector parity

`packages/licenses/src/golden-license.json` is embedded in the Rust binary via `include_str!`. The Rust test verifies the same blob against the same public key and asserts the same result as the JS test. This proves byte-identical behavior.

### Revocation = hard-stop

A revoked license has `signature`/`signingKeyId` set to `"REVOKED"` server-side. The next `verify_license` call fails signature verification → client deactivates — **even within `perpetualFallbackBuild`**. `perpetualFallbackBuild` only covers update eligibility after lapse, never survival past explicit revocation.

## 5. BYOK credential handling

### ChatGPT subscription (OAuth)

Delegated entirely to the engine:

- `lyrashield auth login chatgpt` → opens browser, stores token at `~/.strix/subscription-auth.json`
- `lyrashield auth status` → returns signed-in state
- `lyrashield auth logout` → clears token

The desktop spawns these commands; it does not implement OAuth itself.

### Azure OpenAI

- Desktop stores `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` in the OS keychain (macOS Keychain / Windows DPAPI / Linux Secret Service) via the `keyring` Rust crate.
- On scan launch, the desktop injects these as env vars when spawning the engine.
- A "test" button spawns a tiny engine validation call.

### Security

- No credentials in plaintext files, logs, or SQLite.
- No LyraShield model keys ever embedded in the app — runs only on customer credentials.
- The engine's telemetry is forced off in the adapter (already true).

## 6. Update channel

- **Hosting:** GitHub Releases on `ecryptoguru/lyrashield-ai`.
- **Manifest:** `latest.json` (Tauri v2 updater format) attached to the latest release.
- **Signing:** Tauri updater signs artifacts with `TAURI_SIGNING_PRIVATE_KEY`; the app verifies against the public key bundled in `tauri.conf.json`.
- **Gating:** Before installing, the Rust core calls `is_build_installable(license, newVersion)`. Past eligibility → refused. Revoked → hard-stop before any update check.
- **Key management:** Founder generates the updater keypair via the runbook (`docs/ops/tauri-updater-keys-runbook.md`), backs up to Key Vault + offline hardware, adds private key as GitHub Actions secret, pubkey goes into `tauri.conf.json`.

## 7. Threat model

| Threat                                               | Mitigation                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| License forgery (attacker creates fake license)      | ed25519 signature verification against bundled public key; server never accepts client-supplied keys |
| License tampering (attacker modifies stored license) | Signature covers the exact payload bytes; any modification breaks verification                       |
| Webview XSS bypasses license check                   | License verification in compiled Rust core, not webview JS                                           |
| BYOK credential theft from disk                      | OS keychain (Keychain/DPAPI/Secret Service), never plaintext                                         |
| Update channel MITM                                  | Tauri updater verifies artifact signature against bundled pubkey; HTTPS to GitHub                    |
| Updater private key compromise                       | Rotation procedure in runbook; new key shipped via old-key-signed update                             |
| Unintended data egress                               | Only license API + opt-in sync make network calls; no telemetry; engine telemetry forced off         |
| Docker not available → user runs without sandbox     | App blocks scan launch until Docker is detected; no bypass mode                                      |

## 8. PR sequence

| PR   | Title          | Content                                                                                                                                                                      |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #364 | Foundation     | Design doc + updater-keys runbook + Tauri scaffold + license activation/verification (Rust ed25519 + golden vectors) + BYOK setup + engine/Docker detection + CI integration |
| #365 | Functionality  | Scan launch + results UI + update system wiring + optional cloud sync                                                                                                        |
| #366 | Release + docs | `release-tauri.yml` (macOS universal + Windows, sign/notarize, `latest.json`) + all ops docs updated                                                                         |

Strictly sequential. PR 1 must merge before PR 2; PR 2 before PR 3.

## 9. Acceptance criteria (end-to-end)

1. `cargo build`/`test`/`clippy`/`fmt --check` green; frontend `typecheck`/`lint`/`build` green; CI green.
2. Real machine: purchase Local license (Polar sandbox) → email arrives → activate in desktop app → offline grace → reconnect + verify → revoke → hard-stop.
3. Update: eligible build installs; past `perpetualFallbackBuild` refused; updater signature verifies.
4. Smoke-test plan §2 Local flow passes via desktop GUI.
5. No private keys in client bundle, logs, or public surface.
6. No telemetry; no data egress except license API + opt-in sync.
7. Engine revision pinned; `cryptography<49` honored for Intel macOS.

## 10. Rollback strategy

- **Per-PR revert:** each PR is independently revertible via `git revert`.
- **Updater key loss (irreversible):** losing `TAURI_SIGNING_PRIVATE_KEY` means no updates to existing installs. Mitigated by dual backup (Key Vault + offline hardware token) at generation time.
- **Engine incompatibility:** if the engine CLI surface changes, the desktop targets a specific pinned revision; breaking changes require a coordinated desktop + engine release.
- **Bad release:** tag a new version with a fix; the updater fetches the new `latest.json`. Users on the bad version update to the fix. Users past eligibility stay on their last eligible build.
