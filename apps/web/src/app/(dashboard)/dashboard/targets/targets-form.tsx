"use client"

import type { ReactNode } from "react"
import { Globe, GitBranch, Info } from "lucide-react"
import { Button, FormField, Input, Spinner, Select } from "@lyrashield/ui"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TARGET_SINGULAR } from "@/lib/terminology"
import type { GithubRepo, RepoFormState, UrlFormState } from "./targets-model"

/** Everything the GitHub repo picker needs — connection, list, and mode. */
export interface RepoPickerState {
  connected: boolean
  accountLogin: string | null
  repos: GithubRepo[]
  loading: boolean
  mode: "picker" | "manual"
  onModeChange: (mode: "picker" | "manual") => void
  selectedRepoId: string
  onSelectRepo: (repoId: string) => void
}

export function TargetCreatePanel({
  formType,
  onFormTypeChange,
  error,
  children,
}: {
  formType: "REPO" | "URL"
  onFormTypeChange: (type: "REPO" | "URL") => void
  error: string | null
  children: ReactNode
}) {
  return (
    <div className="bg-card mb-6 rounded-xl border p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap gap-2">
        <Button
          variant={formType === "REPO" ? "default" : "secondary"}
          onClick={() => onFormTypeChange("REPO")}
          size="sm"
        >
          <GitBranch className="h-4 w-4" aria-hidden="true" />
          Repository
        </Button>
        <Button
          variant={formType === "URL" ? "default" : "secondary"}
          onClick={() => onFormTypeChange("URL")}
          size="sm"
        >
          <Globe className="h-4 w-4" aria-hidden="true" />
          URL
        </Button>
      </div>

      {error && (
        <div
          className="bg-destructive/10 text-destructive mb-4 rounded-md p-3 text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      {children}
    </div>
  )
}

export function RepoTargetForm({
  picker,
  repoForm,
  onRepoFormChange,
  creating,
  onSubmit,
  onCancel,
}: {
  picker: RepoPickerState
  repoForm: RepoFormState
  onRepoFormChange: (patch: Partial<RepoFormState>) => void
  creating: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="space-y-4"
    >
      {picker.connected && picker.mode === "picker" && (
        <>
          <FormField label="Select repository" htmlFor="repo-select">
            {picker.loading ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner className="h-4 w-4" />
                Loading repositories...
              </div>
            ) : picker.repos.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No repositories found.{" "}
                <button
                  type="button"
                  onClick={() => picker.onModeChange("manual")}
                  className="text-primary hover:underline"
                >
                  Enter manually
                </button>
              </p>
            ) : (
              <Select
                id="repo-select"
                value={picker.selectedRepoId}
                onChange={(e) => picker.onSelectRepo(e.target.value)}
              >
                <option value="">Choose a repository...</option>
                {picker.repos.map((repo) => (
                  <option key={repo.id} value={String(repo.id)}>
                    {repo.fullName}
                    {repo.private ? " (private)" : ""}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <button
            type="button"
            onClick={() => picker.onModeChange("manual")}
            className="text-muted-foreground hover:text-foreground text-xs underline"
          >
            Enter repository manually
          </button>
        </>
      )}
      {(!picker.connected || picker.mode === "manual") && (
        <>
          <FormField label={`${TARGET_SINGULAR} name`} htmlFor="repo-name-input">
            <Input
              id="repo-name-input"
              type="text"
              value={repoForm.name}
              onChange={(e) => onRepoFormChange({ name: e.target.value })}
              required
              maxLength={100}
              autoFocus
              placeholder="My App Backend"
            />
          </FormField>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Repo Owner" htmlFor="repo-owner">
              <Input
                id="repo-owner"
                type="text"
                value={repoForm.repoOwner}
                onChange={(e) => onRepoFormChange({ repoOwner: e.target.value })}
                required
                placeholder={picker.accountLogin ?? "lyrashield"}
              />
            </FormField>
            <FormField label="Repo Name" htmlFor="repo-name-field">
              <Input
                id="repo-name-field"
                type="text"
                value={repoForm.repoName}
                onChange={(e) => onRepoFormChange({ repoName: e.target.value })}
                required
                placeholder="lyrashield"
              />
            </FormField>
          </div>
          <FormField label="Branch or tag (optional)" htmlFor="repo-ref">
            <p id="repo-ref-help" className="text-muted-foreground mb-1 text-xs">
              Leave blank to use the default branch, or enter an exact branch or release tag such as
              v0.1.17.
            </p>
            <Input
              id="repo-ref"
              type="text"
              value={repoForm.branch}
              onChange={(e) => onRepoFormChange({ branch: e.target.value })}
              maxLength={255}
              aria-describedby="repo-ref-help"
              autoComplete="off"
              spellCheck={false}
              placeholder="main or v0.1.17"
            />
          </FormField>
          {picker.connected && picker.mode === "manual" && (
            <button
              type="button"
              onClick={() => picker.onModeChange("picker")}
              className="text-muted-foreground hover:text-foreground text-xs underline"
            >
              Use repository picker
            </button>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={
            creating ||
            (!repoForm.name && !picker.selectedRepoId) ||
            (!picker.connected || picker.mode === "manual"
              ? !repoForm.repoOwner || !repoForm.repoName
              : false)
          }
        >
          {creating ? "Creating..." : `Create ${TARGET_SINGULAR}`}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function UrlTargetForm({
  urlForm,
  onUrlFormChange,
  creating,
  onSubmit,
  onCancel,
}: {
  urlForm: UrlFormState
  onUrlFormChange: (patch: Partial<UrlFormState>) => void
  creating: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="space-y-4"
    >
      <FormField label="Type" htmlFor="url-type">
        <div className="flex gap-2">
          <Button
            type="button"
            variant={urlForm.urlType === "WEB_APP" ? "default" : "secondary"}
            size="sm"
            onClick={() => onUrlFormChange({ urlType: "WEB_APP" })}
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            Web App
          </Button>
          <Button
            type="button"
            variant={urlForm.urlType === "API" ? "default" : "secondary"}
            size="sm"
            onClick={() => onUrlFormChange({ urlType: "API" })}
          >
            API
          </Button>
        </div>
      </FormField>
      <FormField label={`${TARGET_SINGULAR} name`} htmlFor="url-name">
        <Input
          id="url-name"
          type="text"
          value={urlForm.name}
          onChange={(e) => onUrlFormChange({ name: e.target.value })}
          required
          maxLength={100}
          autoFocus
          placeholder={urlForm.urlType === "API" ? "Production API" : "Staging Site"}
        />
      </FormField>
      <FormField label="URL" htmlFor="url-input">
        <Input
          id="url-input"
          type="url"
          value={urlForm.url}
          onChange={(e) => onUrlFormChange({ url: e.target.value })}
          required
          placeholder={
            urlForm.urlType === "API" ? "https://api.example.com" : "https://staging.example.com"
          }
        />
      </FormField>
      {urlForm.urlType === "API" && (
        <FormField label="OpenAPI / Swagger URL" htmlFor="api-spec-url">
          <p className="text-muted-foreground mb-1 text-xs">
            Required for Contract and Contract Behavior reviews. Public HTTPS URL with no query,
            fragment, or credentials.
          </p>
          <Input
            id="api-spec-url"
            type="url"
            value={urlForm.apiSpecUrl}
            onChange={(e) => onUrlFormChange({ apiSpecUrl: e.target.value })}
            placeholder="https://api.example.com/openapi.yaml"
          />
        </FormField>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={urlForm.ownershipAttested}
          onChange={(e) => onUrlFormChange({ ownershipAttested: e.target.checked })}
          className="mt-0.5"
          required
        />
        <span className="text-muted-foreground">
          I own or am authorized to scan this {TARGET_SINGULAR.toLowerCase()}.
        </span>
        <Tooltip>
          <TooltipTrigger aria-label="Why ownership attestation is required">
            <Info
              className="text-muted-foreground hover:text-foreground size-4"
              aria-hidden="true"
            />
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            LyraShield can only review targets you own or have permission to test. This attestation
            is recorded for your security audit log.
          </TooltipContent>
        </Tooltip>
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={creating || !urlForm.ownershipAttested}>
          {creating ? "Creating..." : `Create ${TARGET_SINGULAR}`}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
