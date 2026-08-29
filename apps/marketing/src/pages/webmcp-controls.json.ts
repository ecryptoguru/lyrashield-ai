import type { APIRoute } from "astro"
import { WEBMCP_CONTROLS } from "../../../../packages/security/src/webmcp/controls"
import { WEBMCP_DETECTOR_VERSION } from "../../../../packages/security/src/webmcp/types"

const registry = {
  version: "webmcp-controls/1",
  detectorVersion: WEBMCP_DETECTOR_VERSION,
  updatedDate: "2026-08-29",
  controls: WEBMCP_CONTROLS.map((control) => ({
    id: control.id,
    title: control.title,
    description: control.description,
    strategy: control.strategy,
    severity: control.severity,
    negativeEvidence: control.negativeEvidence,
    falsePositiveNotes: control.falsePositiveNotes,
    remediationTemplate: control.remediationTemplate,
  })),
}

export const GET: APIRoute = () => {
  return new Response(JSON.stringify(registry, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
