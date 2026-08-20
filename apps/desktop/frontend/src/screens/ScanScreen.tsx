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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

      const scanId = await startScan(target, mode, instruction || undefined)
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
            <label className="mb-2 block text-sm font-medium text-foreground">Target type</label>
            <div className="flex gap-2">
              {(["local_path", "repo", "url"] as const).map((t) => (
                <button
                  key={t}
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
              <label className="mb-1 block text-sm font-medium text-foreground">URL</label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {targetType === "repo" ? "Repository path or URL" : "Local path"}
              </label>
              <input
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
              <label className="mb-1 block text-sm font-medium text-foreground">
                Branch (optional)
              </label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              />
            </div>
          )}

          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">Scan mode</label>
            <div className="flex flex-wrap gap-2">
              {modes.map((m) => (
                <button
                  key={m.value}
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
            <label className="mb-1 block text-sm font-medium text-foreground">
              Custom instruction (optional)
            </label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Focus on authentication and input validation..."
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={handleStart}
            disabled={loading || (targetType === "url" ? !url : !path)}
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Starting scan…" : "Start Scan"}
          </button>
        </div>
      </div>
    </div>
  )
}
