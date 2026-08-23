# LyraShield Desktop release runbook

## Ownership and release shape

`lyrashield-ai` owns the customer Desktop app and its signed release. The
workflow builds the app against one immutable `lyrashield-engine` revision,
bundles that sidecar, and creates a draft GitHub Release containing:

- signed and notarized macOS packages for Apple Silicon and Intel;
- a signed Windows x86_64 NSIS installer;
- Tauri updater signatures and one `latest.json` bound to those exact assets.

Engine CI may build an unsigned package for compatibility testing, but it does
not publish a second Desktop release.

## One-time secret setup

Provision these GitHub repository secrets before creating a release tag:

- `TAURI_UPDATER_PRIVATE_KEY`
- `TAURI_UPDATER_KEY_PASSWORD`
- `APPLE_CERTIFICATE_P12`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`
- `WINDOWS_CERTIFICATE_PFX`
- `WINDOWS_CERTIFICATE_PASSWORD`

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
      and Windows certificate are current and not revoked.

The workflow preflight fails within five minutes when a required secret, tag,
or version is missing. It does not start platform builds in that state.

## Build a draft release

Create an annotated semver tag from a green `main` commit:

```bash
git tag -a v0.1.0 -m "LyraShield Desktop v0.1.0"
git push origin v0.1.0
```

The workflow can also be dispatched manually for an existing tag. It never
builds an arbitrary branch as a release.

The platform jobs:

1. verify the pinned engine commit is on engine `main`;
2. build the native engine sidecar for the runner architecture;
3. package it with the Desktop app;
4. sign updater artifacts;
5. sign and notarize/staple macOS apps, or Authenticode-sign Windows;
6. verify signatures before uploading workflow artifacts.

The final job constructs `latest.json` from the exact uploaded artifacts and
creates a **draft** GitHub Release. A failed platform job leaves no partial
public release.

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
7. Verify Local-to-Cloud sync, conflict recovery, offline behavior, revocation,
   update eligibility, and perpetual fallback.
8. Install the prior release and verify the draft's `latest.json` and signed
   artifacts through a private test channel before public publication.

Record tag, app commit, engine commit, artifact checksums, signing identities,
notarization result, test machines, and smoke results as release evidence.

## Publish and rollback

Publishing the draft is a founder-controlled public action. After approval,
edit the notes and publish the existing draft; do not rebuild or replace its
assets.

For rollback, return the release to draft and remove `latest.json` from public
availability. Never retag a released version. Fix forward with a new patch tag
so installed-client and audit history remain unambiguous.

If an updater signing key is compromised, existing clients cannot trust a new
key without a release signed by the old trusted key. Stop publication, preserve
evidence, and follow the rotation procedure before issuing another release.
