import { NextResponse } from "next/server"
import { env, isProd } from "@lyrashield/config"
import { isOAuthProviderConfigured, socialSignUpEnabled } from "@lyrashield/auth/oauth-providers"

export async function GET() {
  const socialSignUp = socialSignUpEnabled(isProd)
  return NextResponse.json(
    {
      github: isOAuthProviderConfigured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
      google: isOAuthProviderConfigured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
      microsoft: isOAuthProviderConfigured(env.AZURE_AD_CLIENT_ID, env.AZURE_AD_CLIENT_SECRET),
      // Production is invite-only. OAuth is available to sign in to a
      // previously invited, verified account but cannot create a new account.
      socialSignUp,
      microsoftSignUp:
        socialSignUp &&
        isOAuthProviderConfigured(env.AZURE_AD_CLIENT_ID, env.AZURE_AD_CLIENT_SECRET),
      emailVerification: env.LYRASHIELD_REQUIRE_EMAIL_VERIFICATION === "1",
      passwordReset:
        Boolean(env.BREVO_API_KEY) && env.LYRASHIELD_REQUIRE_EMAIL_VERIFICATION === "1",
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
