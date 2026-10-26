import { createHash } from "node:crypto"
import { z } from "zod"

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const identity = {
  userId: z.string().min(1).max(200),
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
}
export const GitHubContextSchema = z.discriminatedUnion("purpose", [
  z.object({ ...identity, purpose: z.literal("github-discover") }).strict(),
  z.object({ ...identity, purpose: z.literal("github-install") }).strict(),
  z.object({ ...identity, purpose: z.literal("github-prove"), selectedId: id }).strict(),
  z
    .object({
      ...identity,
      purpose: z.literal("github-selected"),
      selectedId: id,
      providerUserId: id,
    })
    .strict(),
  z
    .object({
      ...identity,
      purpose: z.literal("github-choose"),
      providerUserId: id,
      candidates: z
        .array(z.object({ id, login: z.string().min(1).max(100) }).strict())
        .min(2)
        .max(20),
    })
    .strict(),
])
export type GitHubContext = z.infer<typeof GitHubContextSchema>

type BrowserSession = { userId: string; sessionId: string; apiKey?: unknown; oauth?: unknown }
export function githubSessionIdentity(session: BrowserSession) {
  if (!session.sessionId || session.apiKey || session.oauth) throw new Error("FORBIDDEN")
  return {
    userId: session.userId,
    sessionHash: createHash("sha256").update(session.sessionId).digest("hex"),
  }
}
export function matchesGitHubSession(context: GitHubContext, session: BrowserSession) {
  const current = githubSessionIdentity(session)
  return current.userId === context.userId && current.sessionHash === context.sessionHash
}
