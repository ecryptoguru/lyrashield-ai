import { useState } from "react"
import type { ScanMode, ScanTarget } from "../lib/types"
import { startScan } from "../lib/tauri"

interface Props {
  onScanStarted: (scanId: string) => void
}

export function ScanScreen({ onScanStarted }: Props) {
  const [targetType, setTargetType] = useState<"repo" | "url" | "local_path">("local_path")
  const [path, setPath] = useState("")
  const [url, setUrl] = useState("")
  const [branch, setBranch] = useState("")
  const [mode, setMode] = useState<ScanMode>("standard")
  const [instruction, setInstruction] = useState("")
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("3.20")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const budget = Number(maxBudgetUsd)
  const budgetValid = Number.isFinite(budget) && budget >= 0.01 && budget <= 100

  async function handleStart() {
    setLoading(true)
    setError(null)
    try {
      const target: ScanTarget =
        targetType === "repo"
          ? { type: "repo", path, branch: branch || null }
          : targetType === "url"
            ? { type: "url", url }
            : { type: "local_path", path }

      if (!budgetValid) {
        setError("Enter a BYOK budget between $0.01 and $100.00.")
        return
      }
      const scanId = await startScan(target, mode, instruction || undefined, budget)
      onScanStarted(scanId)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const modes: { value: ScanMode; label: string }[] = [
    { value: "safe", label: "Safe" },
    { value: "quick", label: "Quick" },
    { value: "standard", label: "Standard" },
    { value: "deep", label: "Deep" },
    { value: "custom", label: "Custom" },
    { value: "url", label: "URL" },
  ]

  return (
    <div className="flex h-screen overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">New Scan</h1>
          <p className="text-sm text-muted-foreground">Choose a target and scan mode.</p>
        </div>

        <div className="space-y-4">
          <div>
            <p id="scan-target-type" className="mb-2 block text-sm font-medium text-foreground">Target type</p>
            <div role="group" aria-labelledby="scan-target-type" className="flex flex-wrap gap-2">
              {(["local_path", "repo", "url"] as const).map((t) => (
                <button
                  key={t}
                  aria-pressed={targetType === t}
                  onClick={() => setTargetType(t)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    targetType === t
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {t === "local_path" ? "Local Path" : t === "repo" ? "Git Repo" : "URL"}
                </button>
              ))}
            </div>
          </div>

          {targetType === "url" ? (
            <div>
              <label htmlFor="scan-url" className="mb-1 block text-sm font-medium text-foreground">URL</label>
              <input
                id="scan-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              />
            </div>
          ) : (
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
          )}

          {targetType === "repo" && (
            <div>
              <label htmlFor="scan-branch" className="mb-1 block text-sm font-medium text-foreground">
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
            <p id="scan-mode" className="mb-2 block text-sm font-medium text-foreground">Scan mode</p>
            <div role="group" aria-labelledby="scan-mode" className="flex flex-wrap gap-2">
              {modes.map((m) => (
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
              engine’s rate card. Your provider’s actual bill may differ. Changing scan mode keeps
              your chosen budget. The model is resolved by your installed engine configuration.
            </p>
          </div>

          <div>
            <label htmlFor="scan-instruction" className="mb-1 block text-sm font-medium text-foreground">
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

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <button
            onClick={handleStart}
            disabled={
              loading ||
              (targetType === "url" ? !url.trim() : !path.trim()) ||
              !budgetValid
            }
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Starting scan…" : "Start Scan"}
          </button>
        </div>
      </div>
    </div>
  )
}
