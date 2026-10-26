"use client"

import { Button } from "@lyrashield/ui"

const messages: Record<string, string> = {
  workspace_already_connected:
    "This workspace already has a different active GitHub installation. Its connection has been preserved. Retry with the existing installation or use another workspace. If several installations were previously connected here, ask your workspace owner to resolve the conflicting connections.",
  already_claimed:
    "This GitHub installation is already connected to another LyraShield workspace. Ask that workspace's owner for access, or install on a different GitHub account. An installation cannot be shared between workspaces.",
  verification_required:
    "We could not confirm that you administer this GitHub installation. Retry and approve GitHub authorization using the owner account or an active organization admin account.",
  no_installations:
    "No eligible GitHub installations were found. Install the app on an account you administer, or retry with the GitHub account that owns an existing installation.",
  cancelled:
    "GitHub authorization was cancelled. You can retry, install on another account, or continue setup later.",
  session_changed:
    "Your app session changed during GitHub connection. Start again from this session.",
  identity_changed:
    "Your GitHub account changed after choosing an installation. Retry with the same GitHub account throughout the connection.",
}

export function GitHubConnectionRecovery({
  status,
  busy,
  onConnect,
  onSkip,
}: {
  status?: string | null
  busy?: boolean
  onConnect?: (mode?: "existing" | "install-new") => void
  onSkip?: () => void
}) {
  const message = status && Object.hasOwn(messages, status) ? messages[status] : undefined
  if (!message) return null
  return (
    <section
      className="my-4 space-y-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
      aria-label="GitHub connection recovery"
    >
      <p role="status">{message}</p>
      {(onConnect || onSkip) && (
        <div className="flex flex-wrap gap-2">
          {onConnect && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onConnect("existing")}
              >
                Retry connection
              </Button>
              {status !== "workspace_already_connected" && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onConnect("install-new")}
                >
                  Install on another account
                </Button>
              )}
            </>
          )}
          {onSkip && (
            <Button type="button" variant="ghost" disabled={busy} onClick={onSkip}>
              Skip for now
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
