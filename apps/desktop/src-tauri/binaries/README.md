# Bundled engine sidecars

The Desktop release workflow copies the verified, version-pinned engine binary
here with Tauri's required Rust target-triple suffix. `externalBin` packages it
as the `lyrashield-engine` sidecar. Production builds never fall back to a
global `lyrashield` or `strix` executable.
