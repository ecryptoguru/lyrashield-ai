# @lyrashield/agent-plugin

Portable Agent Plugins 1.0.0 package for LyraShield.

Contains the canonical `plugin/` directory and a small TypeScript package that
exposes `getPluginDir()`, `validatePlugin()`, and `buildPlugin()`.

## Build

```bash
pnpm --filter @lyrashield/agent-plugin build:plugin
pnpm --filter @lyrashield/agent-plugin test
```
