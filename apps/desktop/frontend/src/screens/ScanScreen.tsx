import { useEffect, useRef, useState } from "react"
import type { ScanMode, ScanTarget } from "../lib/types"
import { startScan } from "../lib/tauri"
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
  const [instruction, setInstruction] = useState("")
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("3.20")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const budget = Number(maxBudgetUsd)
  const budgetValid = Number.isFinite(budget) && budget >= 0.01 && budget <= 100

  const selectedDepth = DEPTH_OPTIONS.find((d) => d.value === mode)

  async function handleStart() {
    setLoading(true)
    setError(null)
    try {
      const target: ScanTarget =
        targetType === "repo"
          ? { type: "repo", path, branch: branch || null }
          : { type: "local_path", path }

      if (!budgetValid) {
        setError("Enter a BYOK budget between $0.01 and $100.00.")
        return
      }
      const scanId = await startScan(target, mode, instruction || undefined, budget)
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
            <p id="scan-target-type" className="mb-2 block text-sm font-medium text-foreground">
              Target type
            </p>
            <div role="group" aria-labelledby="scan-target-type" className="flex flex-wrap gap-2">
              {TARGET_OPTIONS.map((t) => (
                <button
                  key={t.value}
                  aria-pressed={targetType === t.value}
                  onClick={() => setTargetType(t.value)}
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

          <div>
            <label htmlFor="scan-path" className="mb-1 block text-sm font-medium text-foreground">
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

          <div>
            <label htmlFor="scan-budget" className="mb-1 block text-sm font-medium text-foreground">
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
              engine’s rate card. Your provider’s actual bill may differ. Changing scan depth keeps
              your chosen budget. The model is resolved by your installed engine configuration.
            </p>
          </div>

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

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            onClick={handleStart}
            disabled={loading || !path.trim() || !budgetValid}
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Starting scan…" : "Start Scan"}
          </button>
        </div>
      </div>
    </div>
  )
}
