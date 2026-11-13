import { env } from "@lyrashield/config"
import type { NextRequest } from "next/server"
import { verifyOAuthOnboardingReturn } from "./oauth-onboarding-return"
import type { InstallStateResult } from "./github-install-state"

function installReturnPath(returnTo: "onboarding" | "integrations" | "scan"): string {
  return returnTo === "onboarding"
    ? "/onboarding"
    : returnTo === "scan"
      ? "/dashboard/scans?new=1&source=repo"
      : "/dashboard/integrations"
}

/**
 * Returns the canonical, browser-safe app origin for post-install redirects.
 * Falls back to the incoming request origin, and normalises loopback addresses
 * (0.0.0.0 / 127.0.0.1 / ::1) to `localhost` with plain HTTP so local dev
 * callbacks don't resolve to an invalid `https://0.0.0.0:3000` page.
 */
export function getAppOrigin(request: NextRequest): URL {
  const configured = env.NEXT_PUBLIC_APP_URL || env.BETTER_AUTH_URL
  const base = configured ? new URL(configured) : new URL(request.url)

  if (
    base.hostname === "0.0.0.0" ||
    base.hostname === "127.0.0.1" ||
    base.hostname === "::1" ||
    base.hostname === "[::]"
  ) {
    base.hostname = "localhost"
    if (base.protocol === "https:") {
      base.protocol = "http:"
    }
  }

  // Drop any path so callers use this as a clean origin base.
  base.pathname = "/"
  base.search = ""
  base.hash = ""
  return base
}

export function githubAuthorizationUrl(origin: URL, state: string): URL {
  if (!env.GITHUB_APP_CLIENT_ID) throw new Error("GitHub App OAuth client not configured")
  const url = new URL("https://github.com/login/oauth/authorize")
  url.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID)
  url.searchParams.set(
    "redirect_uri",
    new URL("/api/integrations/github/install", origin).toString()
  )
  url.searchParams.set("state", state)
  return url
}

export function githubReturnPath(
  context: Extract<InstallStateResult, { valid: true }>,
  userId: string
) {
  const url = new URL(installReturnPath(context.returnTo), "https://return.invalid")
  const oauth = context.oauthReturnState
    ? verifyOAuthOnboardingReturn(context.oauthReturnState)
    : null
  if (context.returnTo === "onboarding" && oauth?.valid && oauth.userId === userId)
    url.searchParams.set("oauth_return", context.oauthReturnState!)
  return url.pathname + url.search
}
