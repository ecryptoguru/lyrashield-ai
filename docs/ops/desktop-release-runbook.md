# LyraShield Desktop — Release Operations Runbook

## Overview

This runbook covers the desktop release process: tagging, building, signing, publishing, and rollback. Releases produce signed macOS (universal DMG) and Windows (NSIS installer) artifacts plus a signed updater manifest on GitHub Releases.

## Prerequisites (one-time setup)

### Tauri updater signing key

See `docs/ops/tauri-updater-keys-runbook.md` for the full keypair generation and custody procedure. Summary:

1. Generate keypair on an offline workstation: `npx tauri signer generate -w ~/.tauri/lyrashield-updater.key`
2. Store the private key as GitHub Actions secret `TAURI_UPDATER_PRIVATE_KEY`.
3. Store the key password as `TAURI_UPDATER_KEY_PASSWORD`.
4. Put the public key in `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

### Apple Developer ID + notarization

1. Obtain an Apple Developer ID Application certificate.
2. Export it as a P12 file.
3. Base64-encode the P12 and store as `APPLE_CERTIFICATE_P12`.
4. Store the P12 password as `APPLE_CERTIFICATE_PASSWORD`.
5. Store the signing identity name as `APPLE_SIGNING_IDENTITY` (e.g., "Developer ID Application: Your Name (TEAM_ID)").
6. Create an app-specific password for notarization and store as `APPLE_PASSWORD`.
7. Store your Apple ID as `APPLE_ID` and team ID as `APPLE_TEAM_ID`.

### Windows code signing

Use Azure Trusted Signing or a code signing certificate. Store the certificate details as GitHub Actions secrets. If no signing is configured, the Windows build will be unsigned (SmartScreen warnings on first launch).

### License signing public key

Replace `apps/desktop/src-tauri/resources/license-signing-public-key.pem` with the production ed25519 public key from Azure Key Vault. The golden test key must NOT ship in production.

## Release process

### 1. Pre-release checklist

- [ ] Production license signing public key is bundled (not the golden test key)
- [ ] Tauri updater public key in `tauri.conf.json` matches the founder-generated keypair
- [ ] `ENGINE_REVISION` in `release-tauri.yml` matches the current production engine pin
- [ ] All CI gates pass on `main`
- [ ] `cargo test`, `cargo clippy`, `cargo fmt --check` green
- [ ] Frontend `typecheck`, `lint`, `build` green
- [ ] No private keys in the repository or app bundle
- [ ] Version in `Cargo.toml` and `tauri.conf.json` matches the intended tag

### 2. Tag and push

```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers the `release-tauri.yml` workflow.

### 3. Monitor the workflow

The workflow has three jobs:

- `build-macos`: Builds universal DMG + app on macOS-14, signs with Apple Developer ID, notarizes.
- `build-windows`: Builds NSIS installer on Windows, signs if credentials are present.
- `publish-manifest`: Downloads the signed `latest.json` from the release, verifies no private key material, and publishes it as the canonical updater manifest.

Monitor at: `https://github.com/ecryptoguru/lyrashield-ai/actions`

### 4. Verify the release

After the workflow completes:

1. Check the GitHub Release page for the tag.
2. Verify the following assets exist:
   - `LyraShield_<version>_universal.dmg` (macOS)
   - `LyraShield_<version>_x64-setup.exe` (Windows)
   - `latest.json` (signed updater manifest)
3. Download the DMG and verify it opens and the app launches.
4. Download the setup.exe and verify it installs and the app launches.
5. Verify `latest.json` contains the correct version and signature.
6. Run a production smoke test (see below).

### 5. Publish the release

The release is created as a **draft**. After verification:

1. Go to the GitHub Release page.
2. Edit the release notes.
3. Click "Publish release".

The updater manifest (`latest.json`) is now live at:
`https://github.com/ecryptoguru/lyrashield-ai/releases/latest/download/latest.json`

Existing desktop clients will detect the update on their next check.

## Production smoke test

After publishing:

1. Install the new version on a clean macOS machine.
2. Install the new version on a clean Windows machine.
3. Activate with a test license key.
4. Verify the engine and Docker are detected.
5. Sign in with ChatGPT or configure Azure OpenAI.
6. Run a scan against a test target.
7. Verify findings are displayed and SARIF export works.
8. Test the updater: install the previous version, verify it detects the new version and updates.
9. Test offline grace: disconnect from the network, verify the app still works.
10. Test sync (if applicable): connect a workspace, sync findings, verify they appear in the dashboard.

## Rollback

If a release is broken:

1. **Unpublish the GitHub Release:** Go to the release page → Edit → "Set as draft" (or delete the release).
2. **Remove `latest.json`:** Delete the `latest.json` asset from the release. This stops the updater from offering the broken version.
3. **Re-tag (if needed):** If the tag itself is broken, delete it and re-tag a known-good commit:
   ```bash
   git tag -d v0.1.0
   git push origin :refs/tags/v0.1.0
   git tag v0.1.0 <known-good-commit>
   git push origin v0.1.0
   ```
4. **Communicate:** Notify users via the support channel. Existing installations with perpetual fallback will continue working at their current version.

## Signing key rotation

If the Tauri updater signing key is compromised:

1. Generate a new keypair per `tauri-updater-keys-runbook.md`.
2. Update `tauri.conf.json` with the new public key.
3. Update GitHub Actions secrets with the new private key.
4. Ship a new release with the new key.
5. The old key's updates will be rejected by clients that have the new key.

If the license signing key is compromised, follow `docs/ops/license-signing-keys-runbook.md` for rotation.
