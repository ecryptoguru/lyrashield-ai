import { test, expect } from "@playwright/test"

/**
 * Deep scan is blocked on Trial and Starter plans.
 *
 * These E2E specs verify the Deep-scan billing gate through the browser/API.
 * They are marked skip because they were authored as stubs against guessed
 * selectors and a marketing-site URL (port 4321) that is not running in the
 * Playwright CI (the webServer only starts the app on port 3100), and the
 * second test destructured { request } but used page (ReferenceError).
 *
 * The substantive Deep-gating logic — Deep = Pro+ only, blocked for TRIAL and
 * STARTER — is covered by the vitest unit tests in
 * packages/billing/src/entitlements.test.ts, which assert against the real
 * assertScanAllowed code with a mocked DB.
 *
 * To un-skip: (1) create a Starter-plan workspace fixture, (2) call the
 * scan-create API with mode:"DEEP" and assert the 403 DEEP_NOT_ALLOWED response,
 * (3) for the UI test, navigate to the app's /pricing (port 3100) and assert
 * against the real rendered copy. See the diagnosis in the Sprint-10
 * verification report.
 */

test.skip("Deep scan blocked on Trial plan", async () => {
  // Placeholder: needs a real Trial workspace + the scans UI. Covered by
  // entitlements.test.ts (vitest) for the Deep-gating logic.
})

test.skip("Deep scan blocked on Starter plan", async () => {
  // Placeholder: needs a Starter-plan fixture + an API call to /api/scans with
  // mode:"DEEP", asserting 403 DEEP_NOT_ALLOWED. Covered by entitlements.test.ts.
})
