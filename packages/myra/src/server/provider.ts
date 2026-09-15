/**
 * Model provider boundary. MockProvider is deterministic — it composes
 * support answers from tool outputs with no network call. AzureProvider is a
 * guarded skeleton: it throws PROVIDER_ERROR unless generation is explicitly
 * enabled and configured. Provider output is untrusted — markdown is
 * sanitized before it becomes a component.
 */
import { MYRA_COPY, type MyraComponent, type MyraToolName } from "../contracts"
import { sanitizeLinkHref, sanitizeMarkdown } from "../sanitize"
import { err } from "./errors"

export interface ProviderMessage {
  role: "user" | "assistant" | "tool"
  content: string
}

export interface ToolCallOutput {
  name: MyraToolName
  output: Record<string, unknown>
}

export interface ModelGenerateInput {
  system: string
  messages: ProviderMessage[]
  tools?: { name: string; description: string }[]
  /** Two-tier routing: simple lookups → fast deployment, complex → deep. */
  tier?: "fast" | "deep"
  /** Deterministic context from the task loop. */
  context?: {
    intent?: string
    toolOutputs?: ToolCallOutput[]
    routeContext?: string | null
  }
}

export interface ModelGenerateOutput {
  text: string
  components?: MyraComponent[]
  toolCalls?: { name: string; input: Record<string, unknown> }[]
  usage: { inTokens: number; outTokens: number; costUsd: number }
}

export interface ModelProvider {
  name: string
  generate(input: ModelGenerateInput): Promise<ModelGenerateOutput>
}

/** Rebuild markdown from sanitized segments — disallowed links become text. */
export function sanitizeAnswerMarkdown(markdown: string): string {
  return sanitizeMarkdown(markdown)
    .map((seg) => {
      if (seg.kind === "code") return `\`${seg.text}\``
      if (seg.kind === "link" && seg.href && sanitizeLinkHref(seg.href)) {
        return `[${seg.text}](${seg.href})`
      }
      return seg.text
    })
    .join("")
}

// ─── Mock provider ────────────────────────────────────────────────────────

const ZERO_USAGE = { inTokens: 0, outTokens: 0, costUsd: 0 }

function lastUserText(messages: ProviderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content
  }
  return ""
}

function toolData(outputs: ToolCallOutput[] | undefined, name: string) {
  return outputs?.find((t) => t.name === name)?.output
}

export class MockProvider implements ModelProvider {
  name = "mock"

  async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    const text = lastUserText(input.messages).toLowerCase()
    const outs = input.context?.toolOutputs ?? []
    const intent = input.context?.intent ?? classify(text)

    const answer = composeAnswer(intent, text, outs)
    return { text: answer, usage: { ...ZERO_USAGE } }
  }
}

function classify(text: string): string {
  if (/\b(demo|book a (call|demo)|walkthrough|talk to sales)\b/.test(text)) return "demo"
  if (/\b(human|person|real support|speak to|talk to a person|escalate)\b/.test(text)) {
    return "support_case"
  }
  if (/\b(my (plan|minutes|balance|trial)|minutes left|remaining minutes)\b/.test(text)) {
    return "account"
  }
  if (/\b(price|pricing|plan|cost|how much|subscription|pack|overage)\b/.test(text)) {
    return "catalog"
  }
  if (/\b(scan|finding|result|inconclusive|detected|verified|verdict|not start|fail)\b/.test(text)) {
    return "diagnostics"
  }
  return "help"
}

function composeAnswer(intent: string, text: string, outs: ToolCallOutput[]): string {
  switch (intent) {
    case "catalog": {
      const catalog = toolData(outs, "read_product_catalog")
      if (catalog && Array.isArray(catalog.plans)) {
        const names = (catalog.plans as { name: string; monthlyUsd: number }[])
          .map((p) => `${p.name} $${p.monthlyUsd}/mo`)
          .join(", ")
        return `Current Cloud plans (checked just now): ${names}. ` +
          `Prices exclude tax; Enterprise is custom. See the comparison above or /pricing for checkout.`
      }
      return "Here is the current plan comparison from the live catalog."
    }
    case "demo":
      return "Pick a slot below — weekday times are shown in your timezone. The booking is confirmed only after you review it."
    case "demo_status": {
      const info = toolData(outs, "manage_own_demo")
      const bookings = (info?.bookings as
        | { status: string; startsAt: string; conferenceState: string }[]
        | undefined) ?? []
      const latest = bookings[0]
      if (!latest) {
        return "I don't see a demo booking on this account yet. Want to pick a time?"
      }
      if (latest.status === "OUTCOME_UNKNOWN") {
        return MYRA_COPY.demoUnknown
      }
      if (latest.status === "CONFIRMED") {
        return latest.conferenceState === "pending"
          ? MYRA_COPY.demoMeetPending
          : MYRA_COPY.demoConfirmed(latest.startsAt)
      }
      if (latest.status === "CANCELED") {
        return "That demo booking is canceled. I can help you pick a new time."
      }
      return "Your booking is being prepared — you do not need to submit it again."
    }
    case "support_case":
      return "I'll draft a support case for you to review — nothing is sent until you confirm."
    case "account": {
      const ctx = toolData(outs, "get_my_context")
      if (ctx) {
        return `Your plan is ${ctx.planName} and you have ${ctx.minutesRemaining} agent-minutes remaining` +
          (ctx.isTrial ? ` (${ctx.trialDaysLeft} trial days left).` : ".")
      }
      return "I could not read your account status. Try again or open /dashboard/billing."
    }
    case "diagnostics":
      return "I checked your current status above. If a check is failing, follow the step shown — I'll re-verify it."
    case "help":
    default: {
      const help = toolData(outs, "search_public_help")
      if (help && (help.hitCount as number) > 0) {
        return "Here's what our documentation says — see the sources below."
      }
      if (/\b(inconclusive|not proven|unverified)\b/.test(text)) {
        return "An inconclusive result means the evidence gathered was not sufficient to prove or disprove the issue — it is not a release approval. Review the evidence state on the findings page or ask for a retest."
      }
      return "I don't have a sourced answer for that. I can connect you with a person if you'd like."
    }
  }
}

// ─── Azure provider (skeleton — disabled until configured) ────────────────

export class AzureProvider implements ModelProvider {
  name = "azure"

  async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    if (process.env.MYRA_GENERATION_ENABLED !== "1") {
      throw err("PROVIDER_ERROR", "Generation is disabled.")
    }
    const endpoint = process.env.MYRA_AZURE_OPENAI_ENDPOINT
    const apiKey = process.env.MYRA_AZURE_OPENAI_API_KEY
    const isDeep = input.tier === "deep"
    const deployment =
      (isDeep ? process.env.MYRA_MODEL_DEEP : process.env.MYRA_MODEL_FAST) ??
      process.env.MYRA_AZURE_OPENAI_DEPLOYMENT
    if (!endpoint || !apiKey || !deployment) {
      throw err("PROVIDER_ERROR", "Generation provider is not configured.")
    }
    // v1 GA surface: works on both legacy `*.openai.azure.com` and Foundry
    // `*.services.ai.azure.com` endpoints — the deployment goes in the body's
    // `model` field and no dated api-version is required. One retry on
    // transient 429/5xx keeps a blip from failing the whole support turn.
    const url = `${endpoint.replace(/\/$/, "")}/openai/v1/chat/completions`
    let res: Response | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", "api-key": apiKey },
        body: JSON.stringify({
          model: deployment,
          messages: [
            { role: "system", content: input.system },
            ...input.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          max_completion_tokens: 4000,
        }),
      }).catch(() => null)
      if (res && (res.ok || (res.status !== 429 && res.status < 500))) break
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1_000))
    }
    if (!res?.ok) throw err("PROVIDER_ERROR", "Generation provider request failed.")
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const text = body.choices?.[0]?.message?.content ?? ""
    const inTokens = body.usage?.prompt_tokens ?? 0
    const outTokens = body.usage?.completion_tokens ?? 0
    // Cost is derived from per-tier per-1K rates so the monthly budget cap
    // actually enforces on real usage — zero here would silently bypass it.
    // Deep-tier rates fall back to the generic pair when unset.
    const inRate =
      Number(
        (isDeep ? process.env.MYRA_DEEP_COST_PER_1K_INPUT_USD : undefined) ??
          process.env.MYRA_COST_PER_1K_INPUT_USD ??
          0
      ) || 0
    const outRate =
      Number(
        (isDeep ? process.env.MYRA_DEEP_COST_PER_1K_OUTPUT_USD : undefined) ??
          process.env.MYRA_COST_PER_1K_OUTPUT_USD ??
          0
      ) || 0
    const costUsd = (inTokens * inRate + outTokens * outRate) / 1000
    return {
      text,
      usage: { inTokens, outTokens, costUsd },
    }
  }
}

export function getProvider(): ModelProvider {
  const kind = (process.env.MYRA_PROVIDER ?? "mock").toLowerCase()
  if (kind === "azure") return new AzureProvider()
  return new MockProvider()
}
