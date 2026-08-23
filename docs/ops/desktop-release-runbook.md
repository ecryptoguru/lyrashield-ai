# LyraShield Desktop release runbook

## Ownership and release shape

`lyrashield-ai` owns the customer Desktop app and its signed release. The
workflow builds the app against one immutable `lyrashield-engine` revision,
bundles that sidecar, and creates a draft GitHub Release containing:

- signed and notarized macOS packages for Apple Silicon and Intel;
- a signed Windows x86_64 NSIS installer;
- Tauri updater signatures, SHA-256 checksums, and one `latest.json` bound to
  those exact assets.

Engine CI may build an unsigned package for compatibility testing, but it does
not publish a second Desktop release.

## One-time secret setup

Create the protected `desktop-release` GitHub environment before creating a
release tag. Require a reviewer for deployments to it and provision these
environment secrets:

- `TAURI_UPDATER_PRIVATE_KEY`
- `TAURI_UPDATER_KEY_PASSWORD`
- `APPLE_CERTIFICATE_P12`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY_ID`
- `APPLE_API_PRIVATE_KEY_P8`
- `AZURE_SIGNING_CLIENT_ID`
- `AZURE_SIGNING_TENANT_ID`
- `AZURE_SIGNING_SUBSCRIPTION_ID`

Add the Artifact Signing endpoint, account, certificate profile, and expected
certificate subject as protected environment variables. The Entra application
must have a federated credential restricted to
`repo:ecryptoguru/lyrashield-ai:environment:desktop-release` and only the
`Artifact Signing Certificate Profile Signer` role at profile scope. Do not
create or store a client secret.

Keep private keys and certificates out of Git, logs, workflow artifacts, and
release assets. See [tauri-updater-keys-runbook.md](tauri-updater-keys-runbook.md)
and [license-signing-keys-runbook.md](license-signing-keys-runbook.md) for key
custody and rotation.

## Pre-release gate

Before tagging:

- [ ] `.github/workflows/deploy-azure.yml` and
      `.github/workflows/release-tauri.yml` pin the reviewed engine commit.
- [ ] The pinned engine commit is reachable from engine `main`, and the
      cross-repository worker contract passes.
- [ ] `Cargo.toml` and `tauri.conf.json` contain the intended Desktop version.
- [ ] Desktop frontend build/lint/typecheck and Rust fmt/clippy/tests pass.
- [ ] The committed license verification public key is the production public
      key; no private key is present in the app bundle.
- [ ] Updater private/public key pair, Apple certificate/notarization account,
      and Artifact Signing certificate profile are current and not revoked.

The workflow preflight fails within five minutes when a required secret, tag,
or version is missing. It does not start platform builds in that state.

## Build a draft release

Create an annotated semver tag from a green `main` commit:

```bash
git tag -a v0.1.1 -m "LyraShield Desktop v0.1.1"
git push origin v0.1.1
```

The workflow can also be dispatched manually for an existing tag. It never
builds an arbitrary branch as a release.

The platform jobs:

1. verify the pinned engine commit is on engine `main`;
2. build the native engine sidecar for the runner architecture;
3. package it with the Desktop app;
4. sign updater artifacts;
5. sign and notarize/staple macOS apps with App Store Connect API credentials,
   or Authenticode-sign Windows through OIDC-backed Azure Artifact Signing;
6. verify signatures before uploading workflow artifacts.

The final job constructs `latest.json` from the exact uploaded artifacts and
creates a **draft** GitHub Release. A failed platform job leaves no partial
public release.

Rehearse first with immutable tag `v0.1.1-rc.1`. Keep its signed release as a
private draft and test RC-to-final updating through a compile-time trusted HTTPS
test endpoint. Never accept an updater endpoint from React. Application-code
changes after tagging require a new version; never move either tag.

## Draft verification

Do not publish until all checks pass:

1. Download and install both macOS architecture packages on clean machines.
2. Verify Gatekeeper accepts each package without an override.
3. Install the Windows package on a clean Windows machine and verify its
   Authenticode signer and timestamp.
4. Activate a test license and confirm the bundled engine is detected even
   when no global `lyrashield` or `strix` command exists.
5. Test ChatGPT and Azure OpenAI setup without exposing keys in UI, logs, or
   process arguments.
6. Run, cancel, and complete a scan; reopen the app and confirm persisted
   findings, events, and SARIF export.
7. Verify Local-to-Cloud sync, conflict recovery, explicit revocation, the
   seven-day offline grace, expired update eligibility, and perpetual fallback.
8. Install the prior release and verify the draft's `latest.json` and signed
   artifacts through a private test channel before public publication.

Record tag, app commit, engine commit, artifact checksums, signing identities,
notarization result, test machines, and smoke results as release evidence.

The final `v0.1.1` draft must contain exactly two DMGs, two macOS updater
archives and signatures, one Windows NSIS installer and signature,
`latest.json`, and workflow-generated checksums/evidence. Verify every URL is
HTTPS and tag-bound, every signature is non-empty, and hashes match downloaded
assets.

The app never installs automatically. Verify the user confirmation, release
notes, bounded progress, restart warning, preserved data, and retry/offline
states during the RC-to-final updater rehearsal.

## Publish and rollback

Publishing the draft is a founder-controlled public action. After approval,
edit the notes and publish the existing draft; do not rebuild or replace its
assets.

The same approval must authorize deleting the stale unsigned `v0.1.0` draft.
Capture its metadata and hashes first, delete only the draft, and retain the
immutable tag.

For rollback, return the release to draft and remove `latest.json` from public
availability. Never retag a released version. Fix forward with a new patch tag
so installed-client and audit history remain unambiguous.

If an updater signing key is compromised, existing clients cannot trust a new
key without a release signed by the old trusted key. Stop publication, preserve
evidence, and follow the rotation procedure before issuing another release.
