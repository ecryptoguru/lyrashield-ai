import { NextResponse } from "next/server"
import { env, isProd } from "@lyrashield/config"
import { isOAuthProviderConfigured, socialSignUpEnabled } from "@lyrashield/auth/oauth-providers"

export async function GET() {
  return NextResponse.json(
    {
      github: isOAuthProviderConfigured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
      google: isOAuthProviderConfigured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
      microsoft: isOAuthProviderConfigured(env.AZURE_AD_CLIENT_ID, env.AZURE_AD_CLIENT_SECRET),
      emailVerification: env.LYRASHIELD_REQUIRE_EMAIL_VERIFICATION === "1",
      passwordReset: isProd && Boolean(env.BREVO_API_KEY),
      // Production is invite-only. OAuth is available to sign in to a
      // database-hook-authorized GitHub or Google account.
      socialSignUp: socialSignUpEnabled(isProd),
      // Microsoft email claims are mutable and are not an authorization
      // boundary. Production users link Microsoft from an authenticated account.
      microsoftSignUp: !isProd,
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
