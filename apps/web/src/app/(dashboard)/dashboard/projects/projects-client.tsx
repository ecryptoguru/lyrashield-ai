"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Plus, FolderKanban, Bug, Crosshair, Radar } from "lucide-react"

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

export function ProjectsClient({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    if (workspaceId) {
      fetchProjects()
    }
  }, [workspaceId])

  async function fetchProjects() {
    setLoading(true)
    try {
      const res = await fetch(`/api/projects?workspaceId=${workspaceId}`)
      const data = await res.json()
      if (data.success) {
        setProjects(data.data)
        setFetchError(null)
      } else {
        setFetchError(data.error?.message ?? "Failed to load projects")
      }
    } catch {
      setFetchError("Failed to load projects")
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, name, description: description || undefined }),
      })
      const data = await res.json()
      if (data.success) {
        setName("")
        setDescription("")
        setShowForm(false)
        fetchProjects()
        router.refresh()
      } else {
        setError(data.error?.message ?? "Failed to create project")
      }
    } catch {
      setError("Failed to create project")
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-sm text-muted-foreground">Loading projects...</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <p className="mb-4 text-sm text-destructive">{fetchError}</p>
        <button
          onClick={() => fetchProjects()}
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground">Organize your scan targets and findings</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Project
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Create Project</h2>
          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="mb-4">
            <label htmlFor="project-name" className="mb-1 block text-sm font-medium">Name</label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              autoFocus
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="My App"
            />
          </div>
          <div className="mb-4">
            <label htmlFor="project-description" className="mb-1 block text-sm font-medium">Description (optional)</label>
            <textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Brief description of this project"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false)
                setError(null)
              }}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <FolderKanban className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <h2 className="mb-2 text-lg font-semibold">No projects yet</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Create your first project to organize targets and scans.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Create project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <div
              key={project.id}
              className="cursor-pointer rounded-lg border p-6 transition-colors hover:border-primary/50"
              onClick={() => router.push(`/dashboard/targets?projectId=${project.id}`)}
            >
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">{project.name}</h3>
                <span className="rounded-full bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground">
                  Risk: {project.riskScore}
                </span>
              </div>
              {project.description && (
                <p className="mb-4 text-sm text-muted-foreground">{project.description}</p>
              )}
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Crosshair className="h-3 w-3" />
                  {project.targetCount} targets
                </span>
                <span className="flex items-center gap-1">
                  <Radar className="h-3 w-3" />
                  {project.scanCount} scans
                </span>
                <span className="flex items-center gap-1">
                  <Bug className="h-3 w-3" />
                  {project.findingCount} findings
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
