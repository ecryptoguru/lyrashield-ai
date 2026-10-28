#!/usr/bin/env node

/**
 * `pnpm preview` needs the LYRASHIELD_LOCAL_PREVIEW=1 artifact — the only
 * build whose HTTPS-upgrade middleware stands down for wrangler dev's
 * loopback requests (see src/middleware.ts). Serving a plain `pnpm build`
 * output would 301 every SSR route to an https listener that does not exist.
 *
 * In CI the "Build marketing" step already produced that flagged artifact and
 * marked it with dist/.local-preview, so building it again inside the
 * Playwright webServer was a pure duplicate — measured at ~15s of astro work
 * per marketing run. Outside CI we always rebuild: a reused local artifact
 * could be stale, and the marker is only honored under CI anyway.
 */
import { execSync, execFileSync } from "node:child_process"
import { generateBlogResponsive } from "./generate-blog-responsive.mjs"
import { existsSync, writeFileSync } from "node:fs"

const MARKER = "dist/.local-preview"
const reusable = process.env.CI && existsSync(MARKER)

if (!reusable) {
  execSync("astro build", {
    stdio: "inherit",
    env: { ...process.env, LYRASHIELD_LOCAL_PREVIEW: "1" },
  })
}
if (!reusable) {
  await generateBlogResponsive()
  execFileSync(process.execPath, ["scripts/apply-worker-scheme-guard.mjs"], { stdio: "inherit" })
  execFileSync(process.execPath, ["scripts/validate-csp.mjs"], { stdio: "inherit" })
}
if (!existsSync(MARKER)) writeFileSync(MARKER, "1\n")
