import { createAuthClient } from "better-auth/client"

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
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
