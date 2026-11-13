import { z } from "zod"
import { CreateWorkspaceSchema } from "@lyrashield/types"

export const onboardingWorkspaceChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("select"), workspaceId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      kind: z.literal("create"),
      name: CreateWorkspaceSchema.shape.name.refine(
        (name) => name.length > 0,
        "Workspace name is required"
      ),
    })
    .strict(),
])
export type OnboardingWorkspaceChoice = z.infer<typeof onboardingWorkspaceChoiceSchema>
const concurrency = { expectedUpdatedAt: z.string().datetime() }
export const onboardingWorkspaceRequestSchema = z.discriminatedUnion("kind", [
  onboardingWorkspaceChoiceSchema.options[0].extend(concurrency),
  onboardingWorkspaceChoiceSchema.options[1].extend(concurrency),
])
