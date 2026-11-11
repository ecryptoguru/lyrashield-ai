"use client"

import { useEffect, useRef, useState, type Ref } from "react"
import { Check, Copy, KeyRound, Plus, ShieldAlert } from "lucide-react"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Spinner,
} from "@lyrashield/ui"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { z } from "zod"
import { apiDelete, apiPost, ApiError } from "@/lib/api-client"
import { formatDate, formatDateTime } from "@/lib/date-format"
import { apiKeyRowSchema, expiryTime, useApiKeysList, type ApiKeyRow } from "./use-api-keys-list"
import { useApiKeyCopy } from "./use-api-key-copy"

interface CreatedKey extends ApiKeyRow {
  rawKey: string
}

const createdKeySchema = apiKeyRowSchema.and(z.object({ rawKey: z.string() }).passthrough())
/**
 * Workspace API keys — used by the LyraShield MCP server, CLI, and CI.
 * The raw key is displayed exactly once after creation.
 */
function renderApiKeyNameField(
  name: string,
  onNameChange: (name: string) => void,
  inputRef: Ref<HTMLInputElement>
) {
  return (
    <div className="space-y-1">
      <label htmlFor="api-key-name" className="text-sm font-medium">
        Key name
      </label>
      <input
        id="api-key-name"
        ref={inputRef}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        maxLength={100}
        placeholder="e.g. Cursor on my laptop, CI pipeline"
        className="border-input bg-background w-full rounded-md border px-3 py-2 text-base md:text-sm"
      />
    </div>
  )
}

function renderApiKeyExpiryField(
  expiryHours: number,
  creating: boolean,
  onExpiryChange: (hours: number) => void
) {
  return (
    <div className="space-y-1">
      <label htmlFor="api-key-expiry" className="text-sm font-medium">
        Expires after
      </label>
      <select
        id="api-key-expiry"
        value={expiryHours}
        onChange={(event) => {
          const hours = Number(event.target.value)
          if ([0, 4, 24, 720].includes(hours)) onExpiryChange(hours)
        }}
        disabled={creating}
        className="border-input bg-background w-full rounded-md border px-3 py-2 text-base md:text-sm"
      >
        <option value={0}>No expiry</option>
        <option value={4}>4 hours</option>
        <option value={24}>1 day</option>
        <option value={720}>30 days</option>
      </select>
    </div>
  )
}

function renderApiKeyScopeField(
  scope: "read" | "write",
  onScopeChange: (scope: "read" | "write") => void
) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">Access</legend>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="api-key-scope"
            checked={scope === "read"}
            onChange={() => onScopeChange("read")}
          />
          Read-only <span className="text-muted-foreground">(recommended)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="api-key-scope"
            checked={scope === "write"}
            onChange={() => onScopeChange("write")}
          />
          Read &amp; write (can start scans, create reports)
        </label>
      </div>
      {scope === "write" ? (
        <p className="text-muted-foreground text-xs">
          This key will be able to start scans and create reports in this workspace. Prefer
          read-only unless a tool needs to make changes.
        </p>
      ) : null}
    </fieldset>
  )
}

function renderAdminOnlyApiKeys() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle as="h2" className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden="true" />
          API keys
        </CardTitle>
      </CardHeader>
      <CardContent>
        <EmptyState
          headingLevel="h3"
          icon={KeyRound}
          title="API keys are admin-only"
          description="Only workspace owners and admins can create or manage API keys. Contact an admin if you need access."
          action={null}
        />
      </CardContent>
    </Card>
  )
}

function CreatedApiKey({
  rawKey,
  copied,
  hasCopiedKey,
  copyButtonRef,
  onCopy,
  onDismiss,
}: {
  rawKey: string
  copied: boolean
  hasCopiedKey: boolean
  copyButtonRef: Ref<HTMLButtonElement>
  onCopy: () => void
  onDismiss: (restoreFocus: boolean) => void
}) {
  return (
    <div className="border-primary/40 bg-primary/5 space-y-2 rounded-md border p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="size-4" aria-hidden="true" />
        Copy this key now — it will not be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code
          aria-label="API key shown once"
          tabIndex={0}
          onFocus={(event) => {
            const selection = window.getSelection()
            if (!selection) return
            const range = document.createRange()
            range.selectNodeContents(event.currentTarget)
            selection.removeAllRanges()
            selection.addRange(range)
          }}
          className="bg-muted min-w-0 flex-1 select-all rounded px-2 py-1.5 font-mono text-xs break-all"
        >
          {rawKey}
        </code>
        <Button ref={copyButtonRef} size="sm" variant="outline" onClick={onCopy}>
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          <span className="sr-only">Copy API key</span>
        </Button>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={!hasCopiedKey}
        aria-describedby={hasCopiedKey ? undefined : "api-key-copy-hint"}
        onClick={(event) => onDismiss(document.activeElement === event.currentTarget)}
      >
        I&apos;ve stored it safely
      </Button>
      <p id="api-key-existing-key-hint" className="text-muted-foreground text-xs">
        Store the previous key before creating another.
      </p>
      {!hasCopiedKey ? (
        <p id="api-key-copy-hint" className="text-xs text-amber-600 dark:text-amber-400">
          Copy the key first — dismissing this notice discards the only copy.
        </p>
      ) : null}
    </div>
  )
}

function ApiKeyListError({
  message,
  hasKeys,
  loading,
  onRetry,
}: {
  message: string
  hasKeys: boolean
  loading: boolean
  onRetry: () => Promise<void>
}) {
  return (
    <div role="alert" className="space-y-2 text-sm">
      <p className="text-destructive">
        {message}
        {hasKeys ? " The displayed keys may be out of date." : ""}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={() => void onRetry()}
      >
        {loading ? "Retrying…" : "Retry"}
      </Button>
    </div>
  )
}

function ApiKeyList({
  activeKeys,
  revokedKeys,
  onRevoke,
  now,
  stale,
}: {
  activeKeys: ApiKeyRow[]
  revokedKeys: ApiKeyRow[]
  onRevoke: (id: string) => Promise<void>
  now: number | null
  stale: boolean
}) {
  return (
    <ul className="divide-y">
      {activeKeys.map((key) => (
        <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{key.name}</p>
            <p className="text-muted-foreground font-mono text-xs">
              {key.prefix}…
              <span className="ml-2 font-sans">
                {key.lastUsedAt ? `last used ${formatDate(key.lastUsedAt)}` : "never used"}
              </span>
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {key.expiresAt === null
                ? "No expiry"
                : expiryTime(key.expiresAt) === null
                  ? "Expiry unavailable"
                  : `${now !== null && expiryTime(key.expiresAt)! <= now ? "Expired" : "Expires"} ${formatDateTime(key.expiresAt)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="muted">
              {key.scopes.includes("write") ? "read & write" : "read-only"}
            </Badge>
            {now !== null &&
              expiryTime(key.expiresAt) !== null &&
              expiryTime(key.expiresAt)! <= now && <Badge variant="muted">expired</Badge>}
            <InlineConfirm
              triggerLabel="Revoke"
              confirmLabel="Confirm revoke"
              message={`Revoke “${key.name}”?`}
              aria-label={`Revoke API key ${key.name}`}
              disabled={stale}
              onConfirm={() => onRevoke(key.id)}
            />
          </div>
        </li>
      ))}
      {revokedKeys.map((key) => (
        <li
          key={key.id}
          className="text-muted-foreground flex items-center justify-between gap-2 py-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm line-through">{key.name}</p>
            <p className="font-mono text-xs">{key.prefix}…</p>
          </div>
          <Badge variant="muted">revoked</Badge>
        </li>
      ))}
    </ul>
  )
}

export function ApiKeysSection({
  workspaceId,
  canManage,
}: {
  workspaceId: string
  canManage: boolean
}) {
  const [createdKeys, setCreatedKeys] = useState<Record<string, CreatedKey>>({})
  const [creatingWorkspaces, setCreatingWorkspaces] = useState<Set<string>>(new Set())
  const pendingCreates = useRef(new Set<string>())
  const createdKey = createdKeys[workspaceId] ?? null

  function startCreate() {
    if (pendingCreates.current.has(workspaceId)) return false
    pendingCreates.current.add(workspaceId)
    setCreatingWorkspaces(new Set(pendingCreates.current))
    return true
  }

  function finishCreate() {
    pendingCreates.current.delete(workspaceId)
    setCreatingWorkspaces(new Set(pendingCreates.current))
  }

  return (
    <>
      {canManage && Object.keys(createdKeys).some((id) => id !== workspaceId) && (
        <p role="status" className="text-muted-foreground mb-3 text-sm">
          A newly created key is waiting in another workspace. Switch back to save it.
        </p>
      )}
      <WorkspaceApiKeysSection
        key={`${workspaceId}:${canManage}`}
        workspaceId={workspaceId}
        canManage={canManage}
        creating={creatingWorkspaces.has(workspaceId)}
        createdKey={createdKey}
        startCreate={startCreate}
        finishCreate={finishCreate}
        onCreated={(key) => setCreatedKeys((current) => ({ ...current, [workspaceId]: key }))}
        onDiscard={() =>
          setCreatedKeys((current) => {
            const next = { ...current }
            delete next[workspaceId]
            return next
          })
        }
      />
    </>
  )
}

function WorkspaceApiKeysSection({
  workspaceId,
  canManage,
  creating,
  createdKey,
  startCreate,
  finishCreate,
  onCreated,
  onDiscard,
}: {
  workspaceId: string
  canManage: boolean
  creating: boolean
  createdKey: CreatedKey | null
  startCreate: () => boolean
  finishCreate: () => void
  onCreated: (key: CreatedKey) => void
  onDiscard: () => void
}) {
  const createTriggerRef = useRef<HTMLButtonElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const copyButtonRef = useRef<HTMLButtonElement>(null)
  const formGeneration = useRef(0)
  const draftRevision = useRef(0)
  const pendingSuccessFocus = useRef<number | null>(null)
  const pendingDismissFocus = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState("")
  const [scope, setScope] = useState<"read" | "write">("read")
  const [expiryHours, setExpiryHours] = useState(0)
  const { copied, hasCopiedKey, setHasCopiedKey, copyKey } = useApiKeyCopy(
    createdKey?.rawKey,
    setError
  )

  const { keys, loadingKeys, listError, now, load, mounted } = useApiKeysList(
    workspaceId,
    canManage
  )

  useEffect(() => {
    if (
      pendingSuccessFocus.current === formGeneration.current &&
      document.activeElement === document.body
    ) {
      copyButtonRef.current?.focus()
    }
    pendingSuccessFocus.current = null
    if (
      !createdKey &&
      pendingDismissFocus.current === formGeneration.current &&
      document.activeElement === document.body
    ) {
      if (showCreate) nameInputRef.current?.focus()
      else createTriggerRef.current?.focus()
    }
    pendingDismissFocus.current = null
  }, [createdKey, showCreate])

  if (!canManage) return renderAdminOnlyApiKeys()

  /**
   * Reset the create form to its defaults. Scope MUST be reset along with the
   * name: leaving the previous selection sticky silently grants write access to
   * a key the user believes is read-only (least-privilege default is "read").
   */
  function closeCreateForm() {
    formGeneration.current += 1
    setShowCreate(false)
    setName("")
    setScope("read")
    setExpiryHours(0)
  }

  async function handleCreate() {
    if (!name.trim() || createdKey || !startCreate()) return
    const focusAtSubmission = typeof document === "undefined" ? null : document.activeElement
    const restoreFocus = focusAtSubmission === createButtonRef.current && focusAtSubmission !== null
    const submittedGeneration = formGeneration.current
    const submittedDraftRevision = draftRevision.current
    setError(null)
    try {
      const created = await apiPost(
        "/api/api-keys",
        {
          workspaceId,
          name: name.trim(),
          scopes: scope === "write" ? ["read", "write"] : ["read"],
          ...(expiryHours > 0
            ? { expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString() }
            : {}),
        },
        { schema: createdKeySchema }
      )
      if (!mounted.current) {
        onCreated(created)
        return
      }
      const focusUnchanged =
        typeof document === "undefined" ||
        document.activeElement === document.body ||
        document.activeElement === createButtonRef.current ||
        document.activeElement === focusAtSubmission
      if (
        formGeneration.current === submittedGeneration &&
        draftRevision.current === submittedDraftRevision &&
        focusUnchanged
      ) {
        const focusCopy =
          restoreFocus &&
          (document.activeElement === document.body ||
            document.activeElement === createButtonRef.current)
        closeCreateForm()
        if (focusCopy) pendingSuccessFocus.current = formGeneration.current
      }
      onCreated(created)
      setHasCopiedKey(false)
      await load()
    } catch (err) {
      if (formGeneration.current === submittedGeneration) {
        setError(err instanceof ApiError ? err.message : "Failed to create API key")
        if (
          restoreFocus &&
          draftRevision.current === submittedDraftRevision &&
          document.activeElement === document.body
        )
          nameInputRef.current?.focus()
      }
    } finally {
      finishCreate()
    }
  }

  async function handleRevoke(id: string) {
    setError(null)
    try {
      await apiDelete(`/api/api-keys/${id}?workspaceId=${workspaceId}`)
      if (createdKey?.id === id) onDiscard()
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke API key")
    }
  }

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? []
  const revokedKeys = keys?.filter((k) => k.revokedAt) ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle as="h2" className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden="true" />
          API keys
        </CardTitle>
        <Button
          ref={createTriggerRef}
          size="sm"
          variant="outline"
          onClick={() => (showCreate ? closeCreateForm() : setShowCreate(true))}
          aria-expanded={showCreate}
          aria-controls="api-key-create-form"
          disabled={!!createdKey && !showCreate}
          aria-describedby={createdKey ? "api-key-existing-key-hint" : undefined}
        >
          <Plus className="mr-1 size-4" aria-hidden="true" />
          New key
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Connect the LyraShield MCP server, CLI or CI to this workspace. Keys are shown once at
          creation and can be revoked at any time.
        </p>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {listError ? (
          <ApiKeyListError
            message={listError}
            hasKeys={keys !== null}
            loading={loadingKeys}
            onRetry={load}
          />
        ) : null}

        <p role="status" className="sr-only">
          {createdKey
            ? copied
              ? "API key copied."
              : "Copy this key now — it will not be shown again."
            : ""}
        </p>
        {createdKey ? (
          <CreatedApiKey
            rawKey={createdKey.rawKey}
            copied={copied}
            hasCopiedKey={hasCopiedKey}
            copyButtonRef={copyButtonRef}
            onCopy={() => void copyKey()}
            onDismiss={(restoreFocus) => {
              pendingDismissFocus.current = restoreFocus ? formGeneration.current : null
              onDiscard()
            }}
          />
        ) : null}

        {showCreate ? (
          <div
            id="api-key-create-form"
            className="space-y-3 rounded-md border p-4"
            onChangeCapture={() => {
              draftRevision.current += 1
            }}
          >
            {renderApiKeyNameField(name, setName, nameInputRef)}
            {renderApiKeyExpiryField(expiryHours, creating, setExpiryHours)}
            {renderApiKeyScopeField(scope, setScope)}
            <div className="flex gap-2">
              <Button
                ref={createButtonRef}
                size="sm"
                onClick={() => void handleCreate()}
                disabled={creating || !name.trim() || !!createdKey}
                aria-describedby={createdKey ? "api-key-existing-key-hint" : undefined}
              >
                {creating ? <Spinner className="mr-1 size-4" /> : null}
                Create key
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  createTriggerRef.current?.focus()
                  closeCreateForm()
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {keys === null && !listError ? (
          <div className="flex items-center gap-2 py-2">
            <Spinner className="size-4" />
            <span className="text-muted-foreground text-sm">Loading keys…</span>
          </div>
        ) : keys === null ? null : activeKeys.length === 0 &&
          revokedKeys.length === 0 &&
          !listError &&
          !loadingKeys ? (
          <p className="text-muted-foreground text-sm">No API keys yet.</p>
        ) : (
          <ApiKeyList
            activeKeys={activeKeys}
            revokedKeys={revokedKeys}
            onRevoke={handleRevoke}
            now={now}
            stale={loadingKeys || listError !== null}
          />
        )}
      </CardContent>
    </Card>
  )
}
