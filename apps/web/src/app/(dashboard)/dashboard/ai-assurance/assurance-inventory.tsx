"use client"

import { useState } from "react"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"

type ProfileValue = {
  systemName: string
  systemPurpose: string
  modelProviders: Array<{ provider: string; model: string; deployment: string | null }>
  dataClasses: string[]
  dataSources: string[]
  storageSystems: string[]
  toolIntegrations: string[]
  retentionSummary: string | null
  humanOversightSummary: string | null
}

type ThreatValue = {
  scope: string
  assets: string[]
  trustBoundaries: string[]
  threats: Array<{
    title: string
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
    description: string
    mitigation: string | null
    testPlan: string | null
    owner: string | null
    reviewDate: string | null
  }>
}

type ThreatDraft = NonNullable<ThreatValue["threats"]>[number]

export interface AssuranceInventoryProps {
  workspaceId: string
  targetId: string
  canManage: boolean
  initialProfile: ProfileValue | null
  initialThreatModel: ThreatValue | null
}

function list(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function profileFromForm(form: FormData): ProfileValue {
  const provider = String(form.get("provider") ?? "").trim()
  const model = String(form.get("model") ?? "").trim()
  const deployment = String(form.get("deployment") ?? "").trim()
  return {
    systemName: String(form.get("systemName") ?? "").trim(),
    systemPurpose: String(form.get("systemPurpose") ?? "").trim(),
    modelProviders: provider && model ? [{ provider, model, deployment: deployment || null }] : [],
    dataClasses: list(String(form.get("dataClasses") ?? "")),
    dataSources: list(String(form.get("dataSources") ?? "")),
    storageSystems: list(String(form.get("storageSystems") ?? "")),
    toolIntegrations: list(String(form.get("toolIntegrations") ?? "")),
    retentionSummary: String(form.get("retentionSummary") ?? "").trim() || null,
    humanOversightSummary: String(form.get("humanOversightSummary") ?? "").trim() || null,
  }
}

function newThreat(): ThreatDraft {
  return {
    title: "",
    severity: "MEDIUM",
    description: "",
    mitigation: null,
    testPlan: null,
    owner: null,
    reviewDate: null,
  }
}

function textArea(label: string, name: string, value: string, required = false) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea
        name={name}
        required={required}
        maxLength={4000}
        defaultValue={value}
        className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
      />
    </label>
  )
}

export function AssuranceInventory({
  workspaceId,
  targetId,
  canManage,
  initialProfile,
  initialThreatModel,
}: AssuranceInventoryProps) {
  const [profile, setProfile] = useState(initialProfile)
  const [threatModel, setThreatModel] = useState(initialThreatModel)
  const [profileOpen, setProfileOpen] = useState(false)
  const [threatOpen, setThreatOpen] = useState(false)
  const [threats, setThreats] = useState<ThreatDraft[]>(
    initialThreatModel?.threats ?? [newThreat()]
  )
  const [pending, setPending] = useState<"profile" | "threat" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function saveProfile(form: FormData) {
    setPending("profile")
    setError(null)
    try {
      const response = await fetch("/api/ai-assurance/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, targetId, ...profileFromForm(form) }),
      })
      const body = (await response.json()) as {
        data?: { profile?: ProfileValue }
        error?: { message?: string }
      }
      if (!response.ok || !body.data?.profile)
        throw new Error(body.error?.message ?? "Profile save failed")
      setProfile(body.data.profile)
      setProfileOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Profile save failed")
    } finally {
      setPending(null)
    }
  }

  async function saveThreatModel(form: FormData) {
    setPending("threat")
    setError(null)
    try {
      const content: ThreatValue = {
        scope: String(form.get("scope") ?? "").trim(),
        assets: list(String(form.get("assets") ?? "")),
        trustBoundaries: list(String(form.get("trustBoundaries") ?? "")),
        threats: threats.map((threat) => ({
          ...threat,
          mitigation: threat.mitigation?.trim() || null,
          testPlan: threat.testPlan?.trim() || null,
          owner: threat.owner?.trim() || null,
          reviewDate: threat.reviewDate || null,
        })),
      }
      const response = await fetch("/api/ai-assurance/threat-model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, targetId, ...content }),
      })
      const body = (await response.json()) as {
        data?: { content?: ThreatValue }
        error?: { message?: string }
      }
      if (!response.ok || !body.data?.content)
        throw new Error(body.error?.message ?? "Threat model save failed")
      setThreatModel(body.data.content)
      setThreats(body.data.content.threats)
      setThreatOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Threat model save failed")
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="grid gap-4 lg:grid-cols-2" aria-label="AI assurance inventory">
      <Card>
        <CardHeader className="pb-0">
          <CardTitle as="h2" className="text-base">
            AI system profile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          <p className="text-sm text-muted-foreground">
            Customer-declared. Inventory completeness is not verification, certification, or
            data-lineage proof.
          </p>
          {profile ? (
            <p className="text-sm">
              {profile.systemName} ·{" "}
              {profile.modelProviders.map((item) => `${item.provider}/${item.model}`).join(", ")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not assessed — no profile has been submitted.
            </p>
          )}
          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null)
                setProfileOpen((open) => !open)
              }}
              aria-expanded={profileOpen}
            >
              {profileOpen ? "Close profile" : profile ? "Revise profile" : "Add profile"}
            </Button>
          )}
          {profileOpen && (
            <form
              className="grid gap-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault()
                void saveProfile(new FormData(event.currentTarget))
              }}
            >
              {textArea("System name", "systemName", profile?.systemName ?? "", true)}
              {textArea("Purpose", "systemPurpose", profile?.systemPurpose ?? "", true)}
              {textArea("Provider", "provider", profile?.modelProviders[0]?.provider ?? "", true)}
              {textArea("Model", "model", profile?.modelProviders[0]?.model ?? "", true)}
              {textArea(
                "Deployment (optional)",
                "deployment",
                profile?.modelProviders[0]?.deployment ?? ""
              )}
              {textArea(
                "Data classes (one per line)",
                "dataClasses",
                profile?.dataClasses.join("\n") ?? "",
                true
              )}
              {textArea(
                "Data sources (one per line)",
                "dataSources",
                profile?.dataSources.join("\n") ?? ""
              )}
              {textArea(
                "Storage or vector systems (one per line)",
                "storageSystems",
                profile?.storageSystems.join("\n") ?? "",
                true
              )}
              {textArea(
                "Tool or MCP integrations (one per line)",
                "toolIntegrations",
                profile?.toolIntegrations.join("\n") ?? ""
              )}
              {textArea("Retention summary", "retentionSummary", profile?.retentionSummary ?? "")}
              {textArea(
                "Human oversight summary",
                "humanOversightSummary",
                profile?.humanOversightSummary ?? "",
                true
              )}
              <Button type="submit" size="sm" disabled={pending === "profile"}>
                {pending === "profile" ? "Saving…" : "Create immutable profile version"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <CardTitle as="h2" className="text-base">
            Threat model
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          <p className="text-sm text-muted-foreground">
            Customer-declared, versioned threat scenarios. High and critical threats require an
            owner, mitigation, and test plan.
          </p>
          {threatModel ? (
            <p className="text-sm">
              {threatModel.threats.length} threat{" "}
              {threatModel.threats.length === 1 ? "scenario" : "scenarios"} recorded.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Missing — no threat model has been submitted.
            </p>
          )}
          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null)
                setThreatOpen((open) => !open)
              }}
              aria-expanded={threatOpen}
            >
              {threatOpen
                ? "Close threat model"
                : threatModel
                  ? "Revise threat model"
                  : "Add threat model"}
            </Button>
          )}
          {threatOpen && (
            <form
              className="grid gap-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault()
                void saveThreatModel(new FormData(event.currentTarget))
              }}
            >
              {textArea("Scope", "scope", threatModel?.scope ?? "", true)}
              {textArea("Assets (one per line)", "assets", threatModel?.assets.join("\n") ?? "")}
              {textArea(
                "Trust boundaries (one per line)",
                "trustBoundaries",
                threatModel?.trustBoundaries.join("\n") ?? ""
              )}
              {threats.map((threat, index) => (
                <fieldset key={index} className="grid gap-2 rounded-md border p-3">
                  <legend className="px-1 text-sm font-medium">Threat {index + 1}</legend>
                  <label className="grid gap-1 text-sm font-medium">
                    Title
                    <input
                      required
                      maxLength={4000}
                      className="h-10 rounded-md border bg-background px-3 font-normal"
                      value={threat.title}
                      onChange={(event) =>
                        setThreats((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, title: event.target.value } : item
                          )
                        )
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    Severity
                    <select
                      className="h-10 rounded-md border bg-background px-3 font-normal"
                      value={threat.severity}
                      onChange={(event) =>
                        setThreats((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, severity: event.target.value as ThreatDraft["severity"] }
                              : item
                          )
                        )
                      }
                    >
                      <option>LOW</option>
                      <option>MEDIUM</option>
                      <option>HIGH</option>
                      <option>CRITICAL</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    Scenario
                    <textarea
                      required
                      maxLength={4000}
                      className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
                      value={threat.description}
                      onChange={(event) =>
                        setThreats((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, description: event.target.value }
                              : item
                          )
                        )
                      }
                    />
                  </label>
                  {["HIGH", "CRITICAL"].includes(threat.severity) && (
                    <>
                      <label className="grid gap-1 text-sm font-medium">
                        Mitigation
                        <textarea
                          required
                          maxLength={4000}
                          className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
                          value={threat.mitigation ?? ""}
                          onChange={(event) =>
                            setThreats((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, mitigation: event.target.value }
                                  : item
                              )
                            )
                          }
                        />
                      </label>
                      <label className="grid gap-1 text-sm font-medium">
                        Test plan
                        <textarea
                          required
                          maxLength={4000}
                          className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
                          value={threat.testPlan ?? ""}
                          onChange={(event) =>
                            setThreats((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, testPlan: event.target.value }
                                  : item
                              )
                            )
                          }
                        />
                      </label>
                      <label className="grid gap-1 text-sm font-medium">
                        Owner
                        <input
                          required
                          maxLength={4000}
                          className="h-10 rounded-md border bg-background px-3 font-normal"
                          value={threat.owner ?? ""}
                          onChange={(event) =>
                            setThreats((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, owner: event.target.value } : item
                              )
                            )
                          }
                        />
                      </label>
                    </>
                  )}
                  <label className="grid gap-1 text-sm font-medium">
                    Review date (optional)
                    <input
                      type="date"
                      className="h-10 rounded-md border bg-background px-3 font-normal"
                      value={threat.reviewDate ?? ""}
                      onChange={(event) =>
                        setThreats((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, reviewDate: event.target.value || null }
                              : item
                          )
                        )
                      }
                    />
                  </label>
                  {threats.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setThreats((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index)
                        )
                      }
                    >
                      Remove threat
                    </Button>
                  )}
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setThreats((current) => [...current, newThreat()])}
              >
                Add threat
              </Button>
              <Button type="submit" size="sm" disabled={pending === "threat"}>
                {pending === "threat" ? "Saving…" : "Create immutable threat-model version"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      {error && (
        <p className="text-sm text-destructive lg:col-span-2" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
