import { createAuthClient } from "better-auth/client"
import { genericOAuthClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  plugins: [genericOAuthClient()],
})

export const {
  signIn,
  signOut,
  signUp,
  useSession,
  sendVerificationEmail: clientSendVerificationEmail,
} = authClient

export const getClientSession = authClient.getSession

export type AuthClient = typeof authClient
