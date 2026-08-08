import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider"
import { auth } from "@lyrashield/auth/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = oauthProviderAuthServerMetadata(auth)
