import { NextResponse } from "next/server"
import { env } from "@lyrashield/config"
import { isOAuthProviderConfigured } from "@lyrashield/auth/oauth-providers"

export async function GET() {
  return NextResponse.json(
    {
      github: isOAuthProviderConfigured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
      google: isOAuthProviderConfigured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
      microsoft: isOAuthProviderConfigured(env.AZURE_AD_CLIENT_ID, env.AZURE_AD_CLIENT_SECRET),
      socialSignUp: true,
      emailVerification: Boolean(env.BREVO_API_KEY),
      passwordReset: Boolean(env.BREVO_API_KEY),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
