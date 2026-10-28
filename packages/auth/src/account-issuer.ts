interface AccountIdentity {
  providerId: string
  accountId: string
  idToken?: string | null
}

/** Preserve the 1.7.1 identity column during rollout and image rollback.
 * Called only after Better Auth validates the provider response; this is not a token verifier.
 */
export function accountIssuerForCompatibility(account: AccountIdentity): string {
  if (account.providerId === "credential") return "local:credential"
  if (account.providerId === "github") return "local:oauth:github"
  if (account.providerId === "google") return "https://accounts.google.com"
  if (account.providerId === "microsoft" && account.idToken && account.idToken.length <= 32_768) {
    try {
      const parts = account.idToken.split(".")
      if (parts.length !== 3) throw new Error()
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >
      if (
        typeof claims.tid === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.tid) &&
        claims.oid === account.accountId &&
        claims.iss === `https://login.microsoftonline.com/${claims.tid}/v2.0`
      ) {
        return claims.iss
      }
    } catch {
      // Never include the token or provider claims in an error.
    }
  }
  throw new Error("Account identity is incomplete")
}
import type { BetterAuthOptions } from "better-auth"

export const accountIssuerCompatibility = {
  account: {
    additionalFields: {
      issuer: { type: "string", required: false, input: false, returned: false },
    },
  },
  databaseHooks: {
    account: {
      create: {
        before: async (account) => ({
          data: { ...account, issuer: accountIssuerForCompatibility(account) },
        }),
      },
    },
  },
} satisfies Pick<BetterAuthOptions, "account" | "databaseHooks">
