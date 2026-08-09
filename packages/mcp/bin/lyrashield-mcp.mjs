#!/usr/bin/env node
// Stable bin shim for the LyraShield MCP server.
// tsup writes the real entrypoint to ../dist; this file exists so pnpm
// can create .bin symlinks before the package is built.
await import("../dist/stdio-transport.js")
