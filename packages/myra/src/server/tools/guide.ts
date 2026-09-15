/**
 * guide_workflow — navigation help built from the allowlisted route manifest
 * plus suggested guided flows. Never emits a route the principal cannot use.
 */
import { z } from "zod"
import { suggestFlows } from "../../flows"
import { isManifestRoute, routesForPrincipal } from "../../route-manifest"
import type { MyraComponent } from "../../contracts"
import type { MyraToolContext, MyraToolResult } from "./types"

export const guideWorkflowInput = z.object({
  goal: z.string().max(300).optional(),
  routeContext: z.string().max(120).optional(),
})

export async function runGuideWorkflow(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { goal, routeContext } = guideWorkflowInput.parse(input)
  const route = routeContext ?? ctx.routeContext ?? null
  const surface = ctx.surface === "DASHBOARD" ? "app" : "marketing"
  const allowedRoutes = routesForPrincipal(
    { kind: ctx.principal.kind, role: ctx.role },
    surface
  )
  const suggested = suggestFlows(route).filter((f) => f.surfaces.includes(surface))

  // Task steps: suggested flow steps first, then matching manifest routes.
  const steps: {
    id: string
    title: string
    detail?: string
    status: "pending" | "active" | "done" | "blocked"
    ctaRoute?: string
  }[] = []
  const flow = suggested[0]
  if (flow) {
    for (const [i, s] of flow.steps.entries()) {
      steps.push({
        id: s.id,
        title: s.title,
        detail: s.instruction.slice(0, 400),
        status: i === 0 ? "active" : "pending",
        ctaRoute:
          s.ctaRoute && isManifestRoute(s.ctaRoute, surface) ? s.ctaRoute : undefined,
      })
    }
  }
  const goalLower = (goal ?? "").toLowerCase()
  const matching = allowedRoutes.filter(
    (r) =>
      goalLower &&
      (r.label.toLowerCase().includes(goalLower) ||
        r.description.toLowerCase().includes(goalLower) ||
        r.path.includes(goalLower))
  )
  for (const r of matching.slice(0, 4)) {
    steps.push({ id: `route:${r.path}`, title: r.label, detail: r.description, status: "pending", ctaRoute: r.path })
  }

  const components: MyraComponent[] =
    steps.length > 0 ? [{ type: "task_steps", steps: steps.slice(0, 12) }] : []

  return {
    data: {
      suggestedFlows: suggested.map((f) => ({ id: f.id, title: f.title })),
      routes: allowedRoutes.map((r) => ({ path: r.path, label: r.label })),
      stepCount: steps.length,
    },
    components,
  }
}
