import { useEffect, useRef, useState } from "react"
import type { CloudTarget, ScanBackend, ScanMode, ScanTarget, ScanWorkflow } from "../lib/types"
import {
  getSyncState,
  hasSyncApiKey,
  listCloudTargets,
  startCloudScan,
  startScan,
} from "../lib/tauri"
// Depth labels, capability explanations, and execution ceilings come from the
// checked-in contract fixture generated from @lyrashield/types profile data —
// not a second hand-maintained table. Rust tests assert parity with it.
import depthContract from "../../../../../packages/types/src/fixtures/scan-depths.json"

interface Props {
  onBack: () => void
  onScanStarted: (scanId: string) => void
}

type LaunchableTargetType = "local_path" | "repo"

const TARGET_OPTIONS: { value: LaunchableTargetType; label: string }[] = [
  { value: "local_path", label: "Local Path" },
  { value: "repo", label: "Git Repo" },
]

// Hosted URL/API scans run through domain verification and the scoped relay
// (or the deterministic surface transport). LyraShield Local has neither, so
// the action is disabled with a reason rather than quietly billing a BYOK AI
// run against an unverified URL.
const URL_TARGET_UNAVAILABLE_REASON =
  "URL scans need the hosted, domain-verified scan relay in the web app. LyraShield Local has no deterministic URL transport and never substitutes a BYOK AI scan."

type DepthOption = {
  value: ScanMode
  label: string
  profileLabel: string
  description: string
  maxEngineMinutes: number
}

// Only the three public depths are launchable; legacy Safe/Custom aliases and
// the retired url kind are normalized or rejected at the Rust boundary.
const DEPTH_OPTIONS: DepthOption[] = depthContract.depths.map((depth) => ({
  value: depth.engineMode as ScanMode,
  label: depth.depthLabel,
  profileLabel: depth.label,
  description: depth.description,
  maxEngineMinutes: depth.executionLimits.maxEngineMinutes,
}))

// Workflow is an explicit choice — never inferred from the target shape.
// AUTHENTICATED_ASSESSMENT is hosted-only and intentionally not offered.
const WORKFLOW_OPTIONS: { value: ScanWorkflow; label: string; hint: string }[] = [
  {
    value: "REVIEW_TARGET",
    label: "Review Target",
    hint: "Full review of the selected target at the chosen depth.",
  },
  {
    value: "REVIEW_CHANGES",
    label: "Review Changes",
    hint: "Diff-scoped review — compares base and head refs on a repository checkout.",
  },
]

// Backend mode is an explicit choice too: the local bundled BYOK engine, or a
// recorded hosted scan submitted to LyraShield Cloud. Cloud is only ever a
// user action — never a silent substitution for a local run.
const BACKEND_OPTIONS: { value: ScanBackend; label: string }[] = [
  { value: "local", label: "Local engine (BYOK)" },
  { value: "cloud", label: "LyraShield Cloud" },
]

const CLOUD_UNAVAILABLE_REASON =
  "LyraShield Cloud needs a connected workspace and a write-scoped Cloud Sync API key — configure them in Cloud Sync."

export function ScanScreen({ onScanStarted, onBack }: Props) {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [targetType, setTargetType] = useState<LaunchableTargetType>("local_path")
  const [path, setPath] = useState("")
  const [branch, setBranch] = useState("")
  const [mode, setMode] = useState<ScanMode>("standard")
  const [workflow, setWorkflow] = useState<ScanWorkflow>("REVIEW_TARGET")
  const [backend, setBackend] = useState<ScanBackend>("local")
  const [diffBase, setDiffBase] = useState("")
  const [diffHead, setDiffHead] = useState("")
  const [instruction, setInstruction] = useState("")
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("3.20")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cloudWorkspaceId, setCloudWorkspaceId] = useState<string | null>(null)
  const [cloudTargets, setCloudTargets] = useState<CloudTarget[]>([])
  const [cloudTargetId, setCloudTargetId] = useState("")
  const budget = Number(maxBudgetUsd)
  const budgetValid = Number.isFinite(budget) && budget >= 0.01 && budget <= 100

  // Cloud submission unlocks only when the workspace is connected and a
  // write-scoped Cloud Sync API key is in the keychain — and even then it is
  // only ever an explicit user action, never a default or a substitution.
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        if (!(await hasSyncApiKey())) return
        const connection = await getSyncState()
        if (!connection?.workspaceId || disposed) return
        const targets = await listCloudTargets(undefined, connection.workspaceId)
        if (disposed) return
        setCloudWorkspaceId(connection.workspaceId)
        setCloudTargets(targets)
      } catch {
        // Cloud stays disabled — the reason text explains how to configure it.
      }
    })()
    return () => {
      disposed = true
    }
  }, [])

  const selectedDepth = DEPTH_OPTIONS.find((d) => d.value === mode)
  // Review Changes compares refs on a repository target — the only type whose
  // immutable base/head revisions the hosted diff scope can bind.
  const eligibleCloudTargets =
    workflow === "REVIEW_CHANGES"
      ? cloudTargets.filter((t) => t.targetType === "repo")
      : cloudTargets

  // Review Changes only makes sense against a repository checkout — keep the
  // two selections consistent instead of failing at the Rust boundary.
  function selectWorkflow(w: ScanWorkflow) {
    setWorkflow(w)
    if (w === "REVIEW_CHANGES") setTargetType("repo")
  }

  function selectTargetType(t: LaunchableTargetType) {
    setTargetType(t)
    if (t !== "repo" && workflow === "REVIEW_CHANGES") setWorkflow("REVIEW_TARGET")
  }

  async function handleStart() {
    setLoading(true)
    setError(null)
    try {
      const reviewChanges = workflow === "REVIEW_CHANGES"
      if (backend === "cloud") {
        if (!cloudWorkspaceId) {
          setError(CLOUD_UNAVAILABLE_REASON)
          return
        }
        if (!cloudTargetId) {
          setError("Choose a connected target for the recorded cloud scan.")
          return
        }
        if (reviewChanges && !diffBase.trim()) {
          setError("Review Changes needs a base ref to compare against.")
          return
        }
        const scanId = await startCloudScan(
          undefined,
          cloudWorkspaceId,
          cloudTargetId,
          mode,
          workflow,
          reviewChanges ? diffBase.trim() || undefined : undefined,
          reviewChanges ? diffHead.trim() || undefined : undefined
        )
        if (mounted.current) onScanStarted(scanId)
        return
      }

      const target: ScanTarget =
        targetType === "repo"
          ? { type: "repo", path, branch: branch || null }
          : { type: "local_path", path }

      if (!budgetValid) {
        setError("Enter a BYOK budget between $0.01 and $100.00.")
        return
      }
      if (reviewChanges && (targetType !== "repo" || !diffBase.trim())) {
        setError("Review Changes needs a repository target and a base ref to compare against.")
        return
      }
      const scanId = await startScan(
        target,
        mode,
        workflow,
        reviewChanges ? diffBase.trim() || undefined : undefined,
        reviewChanges ? diffHead.trim() || undefined : undefined,
        instruction || undefined,
        budget
      )
      if (mounted.current) onScanStarted(scanId)
    } catch (e) {
      if (mounted.current) setError(String(e))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  return (
    <div className="flex h-screen overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-8">
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground">
          ← Back
        </button>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">New Scan</h1>
          <p className="text-sm text-muted-foreground">Choose a target and scan depth.</p>
        </div>

        <div className="space-y-4">
          <div>
            <p id="scan-backend" className="mb-2 block text-sm font-medium text-foreground">
              Backend
            </p>
            <div role="group" aria-labelledby="scan-backend" className="flex flex-wrap gap-2">
              {BACKEND_OPTIONS.map((b) =>
                b.value === "cloud" && !cloudWorkspaceId ? (
                  <button
                    key={b.value}
                    disabled
                    aria-disabled="true"
                    title={CLOUD_UNAVAILABLE_REASON}
                    className="rounded-md border border-border px-3 py-1.5 text-sm opacity-50"
                  >
                    {b.label}
                  </button>
                ) : (
                  <button
                    key={b.value}
                    aria-pressed={backend === b.value}
                    onClick={() => setBackend(b.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      backend === b.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {b.label}
                  </button>
                )
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {backend === "cloud"
                ? "Runs on LyraShield Cloud under your workspace plan — a recorded, evidence-producing scan with a server-owned execution plan."
                : cloudWorkspaceId
                  ? "Runs on the bundled engine with your BYOK credentials."
                  : `Runs on the bundled engine with your BYOK credentials. ${CLOUD_UNAVAILABLE_REASON}`}
            </p>
          </div>

          {backend === "cloud" ? (
            <div>
              <label
                htmlFor="scan-cloud-target"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                Connected target
              </label>
              <select
                id="scan-cloud-target"
                value={cloudTargetId}
                onChange={(e) => setCloudTargetId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              >
                <option value="">
                  {eligibleCloudTargets.length === 0
                    ? "No eligible connected targets — add one in the LyraShield web app"
                    : "Select a connected target"}
                </option>
                {eligibleCloudTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} ({t.targetType})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <p id="scan-target-type" className="mb-2 block text-sm font-medium text-foreground">
                Target type
              </p>
              <div
                role="group"
                aria-labelledby="scan-target-type"
                className="flex flex-wrap gap-2"
              >
                {TARGET_OPTIONS.map((t) => (
                  <button
                    key={t.value}
                    aria-pressed={targetType === t.value}
                    onClick={() => selectTargetType(t.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      targetType === t.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
                <button
                  disabled
                  aria-disabled="true"
                  title={URL_TARGET_UNAVAILABLE_REASON}
                  className="rounded-md border border-border px-3 py-1.5 text-sm opacity-50"
                >
                  URL
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                URL targets are unavailable locally: {URL_TARGET_UNAVAILABLE_REASON}
              </p>
            </div>
          )}

          <div>
            <p id="scan-workflow" className="mb-2 block text-sm font-medium text-foreground">
              Workflow
            </p>
            <div role="group" aria-labelledby="scan-workflow" className="flex flex-wrap gap-2">
              {WORKFLOW_OPTIONS.map((w) => (
                <button
                  key={w.value}
                  aria-pressed={workflow === w.value}
                  onClick={() => selectWorkflow(w.value)}
                  title={w.hint}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    workflow === w.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {WORKFLOW_OPTIONS.find((w) => w.value === workflow)?.hint}
            </p>
          </div>

          {backend === "local" && (
            <>
              <div>
                <label
                  htmlFor="scan-path"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  {targetType === "repo" ? "Repository path or URL" : "Local path"}
                </label>
                <input
                  id="scan-path"
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder={
                    targetType === "repo"
                      ? "/path/to/repo or https://github.com/user/repo"
                      : "/path/to/project"
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
                />
              </div>

              {targetType === "repo" && (
                <div>
                  <label
                    htmlFor="scan-branch"
                    className="mb-1 block text-sm font-medium text-foreground"
                  >
                    Branch (optional)
                  </label>
                  <input
                    id="scan-branch"
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
                  />
                </div>
              )}
            </>
          )}

          {workflow === "REVIEW_CHANGES" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="diff-base"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  Base ref
                </label>
                <input
                  id="diff-base"
                  type="text"
                  value={diffBase}
                  onChange={(e) => setDiffBase(e.target.value)}
                  placeholder="main or commit SHA"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
                />
              </div>
              <div>
                <label
                  htmlFor="diff-head"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  Head ref (optional)
                </label>
                <input
                  id="diff-head"
                  type="text"
                  value={diffHead}
                  onChange={(e) => setDiffHead(e.target.value)}
                  placeholder="HEAD"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
                />
              </div>
            </div>
          )}

          <div>
            <p id="scan-mode" className="mb-2 block text-sm font-medium text-foreground">
              Scan depth
            </p>
            <div role="group" aria-labelledby="scan-mode" className="flex flex-wrap gap-2">
              {DEPTH_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  aria-pressed={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    mode === m.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {selectedDepth && (
              <p className="mt-2 text-xs text-muted-foreground">
                {selectedDepth.profileLabel}: {selectedDepth.description} Up to{" "}
                {selectedDepth.maxEngineMinutes} engine minutes.
              </p>
            )}
          </div>

          {backend === "local" && (
            <div>
              <label
                htmlFor="scan-budget"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                BYOK maximum model budget (USD)
              </label>
              <input
                id="scan-budget"
                type="number"
                min="0.01"
                max="100"
                step="any"
                inputMode="decimal"
                value={maxBudgetUsd}
                onChange={(e) => setMaxBudgetUsd(e.target.value)}
                aria-describedby="scan-budget-help"
                aria-invalid={!budgetValid}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              />
              <p id="scan-budget-help" className="mt-1 text-xs text-muted-foreground">
                Enter $0.01–$100.00. This limits estimated model spending for this scan using the
                engine’s rate card. Your provider’s actual bill may differ. Changing scan depth
                keeps your chosen budget. The model is resolved by your installed engine
                configuration.
              </p>
            </div>
          )}

          {backend === "local" && (
            <div>
              <label
                htmlFor="scan-instruction"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                Custom instruction (optional)
              </label>
              <textarea
                id="scan-instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Focus on authentication and input validation..."
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            onClick={handleStart}
            disabled={
              loading ||
              (workflow === "REVIEW_CHANGES" && !diffBase.trim()) ||
              (backend === "cloud" ? !cloudTargetId : !path.trim() || !budgetValid)
            }
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading
              ? "Starting scan…"
              : backend === "cloud"
                ? "Submit recorded scan"
                : "Start Scan"}
          </button>
        </div>
      </div>
    </div>
  )
}
