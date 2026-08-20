# LyraShield Local/Desktop — Installation Guide

LyraShield Local is a BYOK (Bring Your Own Key) desktop security scanner. It runs scans on your machine using your own AI credentials. Code, findings, and keys stay local unless you explicitly enable cloud sync.

## Prerequisites

### 1. LyraShield Engine

The desktop app shells out to the LyraShield engine CLI (`lyrashield` or `strix`) on your PATH. Install it separately:

```bash
# Using uv (recommended)
uv tool install lyrashield

# Or using pip
pip install lyrashield

# Verify
lyrashield --version
```

### 2. Docker

Scans run in a hardened Docker sandbox. Install Docker Desktop:

- **macOS:** [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop)
- **Windows:** [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop)

Verify Docker is running:

```bash
docker info
```

### 3. AI Provider (BYOK)

Choose one:

- **ChatGPT Subscription:** Sign in via the desktop app (delegates to `lyrashield auth login chatgpt`). No API key needed.
- **Azure OpenAI:** Provide your API key and endpoint in the desktop setup screen. Credentials are stored in your OS keychain (macOS Keychain / Windows Credential Manager).

## Installation

### macOS

1. Download the `LyraShield_<version>_universal.dmg` from [GitHub Releases](https://github.com/ecryptoguru/lyrashield-ai/releases).
2. Open the DMG and drag LyraShield to Applications.
3. On first launch, macOS may warn about an unidentified developer. Right-click → Open to bypass, or go to System Settings → Privacy & Security → Open Anyway.

### Windows

1. Download the `LyraShield_<version>_x64-setup.exe` from [GitHub Releases](https://github.com/ecryptoguru/lyrashield-ai/releases).
2. Run the installer.
3. If Windows SmartScreen warns, click "More info" → "Run anyway".

## First Run

1. **Activate:** Enter your license key (from your purchase email). The app verifies the license signature locally and activates your machine.
2. **Setup:** The app checks for the engine and Docker. If either is missing, you'll see setup guidance with download links.
3. **BYOK:** Choose your AI provider and sign in / configure credentials.
4. **Scan:** Select a target (local path, Git repo, or URL), choose a scan mode, and start scanning.

## Offline Grace

Once activated, the app works offline. Your license remains valid without network access. After your update eligibility expires, the app continues running at or below your `perpetualFallbackBuild` version indefinitely — it just refuses newer updates.

## Updates

The app checks for updates on GitHub Releases. Updates are signed with an Ed25519 key and verified before installation. You must have an active license with update eligibility to install newer versions.

## Optional Cloud Sync

Sync is **off by default**. To sync findings to your LyraShield cloud workspace:

1. Go to the Sync screen.
2. Enter your workspace ID and license key.
3. Click "Connect Workspace" — the server verifies sync entitlement.
4. Select findings to sync and click "Sync".

Only explicitly selected findings leave your machine. The server enforces a maximum of 500 findings per batch.

## Privacy

- No telemetry or analytics.
- No error-reporting egress.
- Code, findings, prompts, and credentials never leave your machine unless you explicitly sync.
- BYOK credentials are stored in your OS keychain, never in plaintext.
- The license signing private key never enters the app bundle.

## Troubleshooting

### "Engine not found"

Install the engine: `uv tool install lyrashield`. Ensure it's on your PATH.

### "Docker not running"

Start Docker Desktop. Run `docker info` to verify.

### "License activation failed"

Check your license key for typos. Ensure you have network access during activation. Contact support@lyrashieldai.com if the issue persists.

### "ChatGPT login failed"

Ensure you have a ChatGPT Plus or Pro subscription. The login flow opens a browser — ensure pop-ups are allowed.
