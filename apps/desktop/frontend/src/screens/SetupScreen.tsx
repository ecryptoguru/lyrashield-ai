import { useEffect, useState } from "react"
import type { ChatGptAuthStatus, RuntimeStatus } from "../lib/types"
import { checkChatGptStatus, getRuntimeStatus, loadAzureConfig, logoutChatGpt, saveAzureConfig, startChatGptLogin } from "../lib/tauri"
import { StatusCard } from "../components/StatusCard"
import { ProviderPicker } from "../components/ProviderPicker"

interface Props {
  onComplete: () => void
  onBack: () => void
}

type Step = "runtime" | "byok" | "ready"

export function SetupScreen({ onComplete, onBack }: Props) {
  const [step, setStep] = useState<Step>("runtime")
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [chatgptStatus, setChatgptStatus] = useState<ChatGptAuthStatus | null>(null)
  const [provider, setProvider] = useState<"chatgpt" | "azure" | null>(null)
  const [azureKey, setAzureKey] = useState("")
  const [azureEndpoint, setAzureEndpoint] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getRuntimeStatus().then(setRuntime).catch(() => {})
    checkChatGptStatus().then(setChatgptStatus).catch(() => {})
    loadAzureConfig().then((creds) => {
      if (creds) {
        setAzureKey(creds.apiKey)
        setAzureEndpoint(creds.endpoint)
      }
    }).catch(() => {})
  }, [])

  const engineOk = runtime?.engine.found ?? false
  const dockerOk = (runtime?.docker.found && runtime?.docker.running) ?? false

  function handleContinueFromRuntime() {
    if (engineOk && dockerOk) {
      setStep("byok")
    }
  }

  async function handleChatGptLogin() {
    setLoading(true)
    try {
      await startChatGptLogin()
      const status = await checkChatGptStatus()
      setChatgptStatus(status)
      if (status.status === "signed_in") {
        setStep("ready")
      }
    } catch (e) {
      setChatgptStatus({ status: "error", message: String(e) })
    } finally {
      setLoading(false)
    }
  }

  async function handleAzureSave() {
    setLoading(true)
    try {
      await saveAzureConfig(azureKey, azureEndpoint)
      setStep("ready")
    } catch (e) {
      setChatgptStatus({ status: "error", message: String(e) })
    } finally {
      setLoading(false)
    }
  }

  if (step === "runtime") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="w-full max-w-lg space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-foreground">Setup</h1>
            <p className="text-sm text-muted-foreground">
              LyraShield needs the scan engine and Docker to run local scans.
            </p>
          </div>
          <div className="space-y-3">
            <StatusCard
              label="LyraShield Engine"
              ok={engineOk}
              okText={runtime?.engine.version ?? "Found"}
              failText="Not found — install with: uv tool install lyrashield"
              failHint="Or see docs at lyrashieldai.com/docs/local"
            />
            <StatusCard
              label="Docker"
              ok={dockerOk}
              okText={runtime?.docker.version ?? "Running"}
              failText="Not running — install Docker Desktop"
              failHint="Download at docker.com/products/docker-desktop"
            />
          </div>
          <div className="flex justify-between">
            <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground">
              Back
            </button>
            <button
              onClick={handleContinueFromRuntime}
              disabled={!engineOk || !dockerOk}
              className="rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (step === "byok") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="w-full max-w-lg space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-foreground">Bring Your Own AI</h1>
            <p className="text-sm text-muted-foreground">
              Choose your AI provider. Your credentials stay on this machine.
            </p>
          </div>
          {provider === null ? (
            <ProviderPicker onSelect={setProvider} />
          ) : provider === "chatgpt" ? (
            <div className="space-y-4">
              <p className="text-sm text-foreground">Sign in with your ChatGPT subscription.</p>
              {chatgptStatus?.status === "signed_in" && (
                <p className="text-sm text-success">Already signed in.</p>
              )}
              {chatgptStatus?.status === "error" && (
                <p className="text-sm text-destructive">{chatgptStatus.message}</p>
              )}
              <button
                onClick={handleChatGptLogin}
                disabled={loading}
                className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? "Opening browser…" : "Sign in with ChatGPT"}
              </button>
              {chatgptStatus?.status === "signed_in" && (
                <button
                  onClick={async () => { await logoutChatGpt(); setChatgptStatus({ status: "signed_out" }) }}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Sign out
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-foreground">Configure Azure OpenAI.</p>
              <input
                type="password"
                value={azureKey}
                onChange={(e) => setAzureKey(e.target.value)}
                placeholder="API Key"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              />
              <input
                type="text"
                value={azureEndpoint}
                onChange={(e) => setAzureEndpoint(e.target.value)}
                placeholder="https://your-resource.openai.azure.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
              />
              <button
                onClick={handleAzureSave}
                disabled={loading || !azureKey || !azureEndpoint}
                className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? "Saving…" : "Save & Continue"}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ready
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-semibold text-foreground">Ready to Scan</h1>
        <p className="text-sm text-muted-foreground">
          LyraShield Local is configured and ready.
        </p>
        <button
          onClick={onComplete}
          className="rounded-md bg-primary px-6 py-2 text-primary-foreground hover:bg-primary/90"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
