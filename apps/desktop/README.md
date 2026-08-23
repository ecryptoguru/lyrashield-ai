# LyraShield Desktop

LyraShield Local — a BYOK desktop security scanner built with Tauri v2.

## Prerequisites

- **Rust** (stable, 1.77+) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node.js** 24+ and **pnpm** 11+
- A bundled LyraShield Engine sidecar in production. Debug builds may use
  `LYRASHIELD_ENGINE_BIN` or a developer `lyrashield`/`strix` install on PATH.
- **Docker Desktop** (macOS/Windows) or Docker Engine (Linux) — scans run in a hardened sandbox

## Development

```bash
# From the monorepo root
pnpm install

# Run the desktop app in dev mode (starts Vite + Tauri)
cd apps/desktop
pnpm dev

# Or run just the frontend (Vite dev server on port 1420)
cd apps/desktop/frontend
pnpm dev
```

## Building

```bash
# Build the frontend
cd apps/desktop/frontend
pnpm build

# Build the Tauri app (produces platform-specific installer)
cd apps/desktop
pnpm build
```

## Rust checks

```bash
cd apps/desktop
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

## Architecture

- **Rust core** (`src-tauri/src/`) — license verification (ed25519), BYOK credential management (OS keychain), engine/Docker detection, process spawning, HTTP client for the license API
- **React frontend** (`frontend/src/`) — Vite + React + TypeScript + Tailwind CSS v4, matching the web app's design tokens
- **Engine** — signed releases bundle the immutable engine revision selected by
  the release workflow. Production never falls back to PATH.

## License verification

The desktop verifies licenses in compiled Rust using `ed25519-dalek`, pinned by golden-vector tests that prove byte-identical behavior to the JS `@lyrashield/licenses` package. The public key is bundled in `src-tauri/resources/`; the private key never leaves Azure Key Vault.

## Release

Releases are triggered by tagging `v*` — see `.github/workflows/release-tauri.yml` and the release runbook at `docs/ops/desktop-release-runbook.md`.

For end-user installation instructions, see `docs/ops/desktop-installation.md`.
