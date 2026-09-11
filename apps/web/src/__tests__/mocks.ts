import { vi } from "vitest"

/**
 * Shared vi.mock factories for apps/web route/lib tests.
 *
 * `vi.mock(path, factory)` factories are hoisted above the test file's own
 * imports, so they cannot reference top-level bindings. The supported escape
 * is an async factory that imports this module at resolution time:
 *
 *   vi.mock("@lyrashield/logger", async () =>
 *     (await import("@/__tests__/mocks")).loggerModule()
 *   )
 *   import { loggerSpies } from "@/__tests__/mocks"
 *
 * Per-file module isolation (vitest default) gives each test file its own
 * copy of these objects — `loggerSpies` is the same object the mock returned
 * for that file, so assertions and `vi.clearAllMocks()` behave as usual.
 *
 * Keeping the shape here (not per-file) is the point: when the logger module
 * gains an export (e.g. setRequestIdResolver), every consumer's mock stays
 * complete instead of throwing on a missing mocked export.
 */

export const loggerSpies = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

/** Full surface of `@lyrashield/logger` used by app code. */
export function loggerModule() {
  return {
    logger: loggerSpies,
    setRequestId: vi.fn(),
    setRequestIdResolver: vi.fn(),
    activeRequestId: vi.fn(() => undefined),
  }
}
