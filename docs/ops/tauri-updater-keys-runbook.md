# Tauri Updater Signing Keys — Provisioning Runbook

> Status: **Updater key verified on 2026-08-23.** Its private/public pairing
> matches the public key committed in `tauri.conf.json`. The private key and
> password are protected `desktop-release` environment secrets with Key Vault
> backups; repository-wide copies were removed. Apple credentials and the Azure
> Artifact Signing account/profile remain unprovisioned.

## Why this matters

The Tauri updater signs each release artifact with a private key. The desktop app verifies updates against the corresponding public key, which is bundled in `tauri.conf.json`. **If the private key is lost, no further updates can be pushed to existing installations.** This is the single irreversible failure in the desktop release pipeline.

## 1. Generate the keypair

Perform this on an **offline workstation** (no network access, no cloud sync):

```bash
# Install the Tauri CLI if not already available
npm install -g @tauri-apps/cli

# Generate the updater signing keypair
npx tauri signer generate -w ~/.tauri/lyrashield-updater.key
```

You will be prompted for a password. Choose a strong password and store it in your password manager.

This produces:

- `~/.tauri/lyrashield-updater.key` — the private key (password-encrypted)
- A public key string printed to stdout (starts with `dW50cn...`)

**Record both the public key string and the password.** The public key goes into `tauri.conf.json` (PR #364). The password goes into GitHub Actions secrets.

## 2. Back up the private key (two independent locations)

### 2a. Azure Key Vault

```bash
# Upload the private key as a secret in the production Key Vault
az keyvault secret set \
  --vault-name lyrashieldprodsecrets \
  --name tauri-updater-private-key \
  --file ~/.tauri/lyrashield-updater.key

# Upload the password as a separate secret
az keyvault secret set \
  --vault-name lyrashieldprodsecrets \
  --name tauri-updater-private-key-password \
  --value "<your-password>"
```

### 2b. Offline hardware token

Copy `~/.tauri/lyrashield-updater.key` to a USB drive and store it in a physical safe or safety deposit box. This is the disaster-recovery copy — if Key Vault is inaccessible, you can still recover the key.

## 3. Add GitHub Actions secrets

In the `ecryptoguru/lyrashield-ai` protected `desktop-release` environment:

| Secret name                  | Value                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `TAURI_UPDATER_PRIVATE_KEY`  | Contents of `~/.tauri/lyrashield-updater.key` (the file body, base64 if needed) |
| `TAURI_UPDATER_KEY_PASSWORD` | The password you chose in step 1                                                |

```bash
# To get the file contents for pasting into GitHub:
cat ~/.tauri/lyrashield-updater.key | base64 | pbcopy  # macOS
```

## 4. Embed the public key in tauri.conf.json

The public key string from step 1 goes into `apps/desktop/src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "dW50cnku...",
      "endpoints": [
        "https://github.com/ecryptoguru/lyrashield-ai/releases/latest/download/latest.json"
      ]
    }
  }
}
```

The public key is committed in `apps/desktop/src-tauri/tauri.conf.json`; only
the private key and password are secret. `release-tauri.yml` maps the two
protected environment secrets above to Tauri's
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
environment variables. Do not create repository-wide copies.

## 5. Apple Developer ID (macOS signing/notarization)

Separately from the Tauri updater key, macOS builds require:

1. **Apple Developer ID Application certificate** — from the Apple Developer portal (https://developer.apple.com). Export as a `.p12` file.
2. **App Store Connect API key** with Developer access — for Tauri's automated
   notarization. Do not use a founder Apple ID password in CI.

Add these as GitHub Actions secrets:

| Secret name                  | Value                                            |
| ---------------------------- | ------------------------------------------------ |
| `APPLE_CERTIFICATE_P12`      | Base64-encoded `.p12` file                       |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password                           |
| `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: LyraShield (TEAM_ID)` |
| `APPLE_API_ISSUER`           | App Store Connect API issuer ID                  |
| `APPLE_API_KEY_ID`           | App Store Connect key ID                         |
| `APPLE_API_PRIVATE_KEY_P8`   | Raw CI-specific `.p8` private key                |

## 6. Windows code signing

`Microsoft.CodeSigning` is registered. A release-only Entra workload identity
is federated to the protected `desktop-release` environment with subject
`repo:ecryptoguru/lyrashield-ai:environment:desktop-release`; it has no client
secret or Azure role assignment yet.

The founder/account holder must now create the Artifact Signing account and
complete public organization identity validation in Azure Portal. Microsoft
does not support completing identity validation through CLI, and Public Trust
availability is country-restricted, so confirm the legal entity and Azure
billing account are eligible before creating a paid account. After validation,
create the public-trust certificate profile and assign only `Artifact Signing
Certificate Profile Signer` at certificate-profile scope to the release
identity.

Environment secrets contain the client, tenant, and subscription IDs. Protected
environment variables contain the signing endpoint, account, profile, and
expected certificate subject. No PFX or client secret is stored. The workflow
authenticates through GitHub OIDC, signs a disposable canary, and then invokes
the pinned Artifact Signing CLI from Tauri's `signCommand` so Authenticode
signing happens before updater signatures are created.

## 7. Key rotation procedure

If the updater private key is compromised:

1. Generate a new keypair (step 1).
2. Ship an update signed with the **old** key that includes the **new** public key in the app bundle.
3. After users update to the transition build, switch `tauri.conf.json` to the new public key.
4. All subsequent releases are signed with the new private key.
5. Revoke the old key in Key Vault and the offline backup.

This requires at least one more update cycle to complete the rotation.

## 8. Loss of the private key

If the private key is lost (both Key Vault and offline backup are inaccessible):

- **Existing installs:** continue running but cannot receive updates.
- **New installs:** can be signed with a new keypair, but existing installs won't recognize the new key.
- **Recovery:** there is no automatic recovery. Users must manually download and install a new version signed with the new key.

This is why the dual backup in step 2 is mandatory.
