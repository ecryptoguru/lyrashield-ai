import type { APIRoute } from "astro"
import { renderAgentOnboardingMarkdown } from "../lib/agent-onboarding"

export const prerender = false

export const GET: APIRoute = ({ site }) => {
  const origin = (site?.toString() || "https://lyrashieldai.com").replace(/\/$/, "")
  return new Response(renderAgentOnboardingMarkdown(origin), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  })
}
