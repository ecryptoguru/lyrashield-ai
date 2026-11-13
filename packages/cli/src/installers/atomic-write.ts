// The hardened atomic-write implementation lives in @lyrashield/agent-rules so
// every package that writes files shares one correct temp-and-rename path.
// This re-export preserves the existing import paths used by CLI installers.
export { assertSafeDestination, atomicWrite } from "@lyrashield/agent-rules"
