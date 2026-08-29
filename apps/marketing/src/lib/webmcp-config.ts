export const WEBMCP_FREE_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxWallTimeMs: 60_000,
  maxDefinitions: 100,
} as const
