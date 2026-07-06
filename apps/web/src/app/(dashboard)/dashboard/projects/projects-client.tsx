"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Plus, FolderKanban, Bug, Crosshair, Radar } from "lucide-react"
import { Button, Badge, EmptyState, FormField, Input, Textarea, Spinner, LoadMore } from "@lyrashield/ui"
import { apiGetPaginated, apiPost } from "@/lib/api-client"

interface Project {
  id: string
  name: string
  description: string | null
  riskScore: number
  createdAt: string
  targetCount: number
  scanCount: number
  findingCount: number
}

export function ProjectsClient({ workspaceId, initialData, initialNextCursor }: { workspaceId: string; initialData?: Project[]; initialNextCursor?: string | null }) {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>(initialData ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor ?? null)
  const [loading, setLoading] = useState(!initialData)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchProjects = useCallback(async () => {
    setLoading(true)
    try {
      const result = await apiGetPaginated<Project>(`/api/projects`, { workspaceId })
      setProjects(result.items)
      setNextCursor(result.nextCursor)
      setFetchError(null)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to load projects")
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (initialData) return
    if (workspaceId) {
      queueMicrotask(() => {
        void fetchProjects()
      })
    }
  }, [workspaceId, fetchProjects, initialData])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      await apiPost("/api/projects", { workspaceId, name, description: description || undefined })
      setName("")
      setDescription("")
      setShowForm(false)
      await fetchProjects()
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project")
    } finally {
      setCreating(false)
    }
  }

  const loadMore = useCallback(async (cursor: string) => {
    return apiGetPaginated<Project>(`/api/projects`, { workspaceId, cursor })
  }, [workspaceId])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12" aria-busy="true">
        <Spinner className="h-6 w-6" />
        <p className="text-sm text-muted-foreground">Loading projects...</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <p className="mb-4 text-sm text-destructive" role="alert">{fetchError}</p>
        <Button variant="secondary" onClick={() => fetchProjects()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">Organize your scan targets and findings</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)} className="shrink-0">
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Project
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold">Create Project</h2>
          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {error}
            </div>
          )}
          <div className="mb-4">
            <FormField label="Name" htmlFor="project-name">
              <Input
                id="project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
                autoFocus
                placeholder="My App"
              />
            </FormField>
          </div>
          <div className="mb-4">
            <FormField label="Description (optional)" htmlFor="project-description">
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Brief description of this project"
              />
            </FormField>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => {
              setShowForm(false)
              setError(null)
            }}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create your first project to organize targets and scans."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create project
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/dashboard/targets?projectId=${project.id}`}
              className="group block rounded-xl border bg-card p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">{project.name}</h3>
                <Badge variant={project.riskScore > 0 ? "warning" : "muted"}>Risk: {project.riskScore}</Badge>
              </div>
              {project.description && (
                <p className="mb-4 text-sm text-muted-foreground">{project.description}</p>
              )}
              <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Crosshair className="h-3 w-3" aria-hidden="true" />
                  {project.targetCount} targets
                </span>
                <span className="flex items-center gap-1">
                  <Radar className="h-3 w-3" aria-hidden="true" />
                  {project.scanCount} scans
                </span>
                <span className="flex items-center gap-1">
                  <Bug className="h-3 w-3" aria-hidden="true" />
                  {project.findingCount} findings
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <LoadMore
        cursor={nextCursor}
        onLoadMore={loadMore}
        onItems={(items) => setProjects((prev) => [...prev, ...items as Project[]])}
        onNextCursor={setNextCursor}
      />
    </div>
  )
}
