"use client"

import { useState, useEffect, useCallback } from "react"
import { UserPlus, Mail, Clock, Users } from "lucide-react"
import { Button, Badge, FormField, Input, Select, Spinner } from "@lyrashield/ui"
import { apiGet, apiPost } from "@/lib/api-client"

interface Member {
  id: string
  userId: string
  name: string
  email: string
  image: string | null
  role: string
  status: string
  createdAt: string
}

interface Invitation {
  id: string
  email: string
  role: string
  status: string
  expiresAt: string
  createdAt: string
}

export function TeamClient({
  workspaceId,
  initialData,
}: {
  workspaceId: string
  initialData?: { members: Member[]; invitations: Invitation[] }
}) {
  const [members, setMembers] = useState<Member[]>(initialData?.members ?? [])
  const [invitations, setInvitations] = useState<Invitation[]>(initialData?.invitations ?? [])
  const [loading, setLoading] = useState(!initialData)
  const [showInvite, setShowInvite] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("MEMBER")
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchMembers = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ members: Member[]; invitations: Invitation[] }>(
        `/api/team?workspaceId=${workspaceId}`
      )
      setMembers(data.members)
      setInvitations(data.invitations)
      setFetchError(null)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to load team members")
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (initialData) return
    queueMicrotask(() => {
      void fetchMembers()
    })
  }, [fetchMembers, initialData])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true)
    setError(null)
    try {
      await apiPost("/api/team", { workspaceId, email, role })
      setEmail("")
      setRole("MEMBER")
      setShowInvite(false)
      await fetchMembers()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to invite member")
    } finally {
      setInviting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12" aria-busy="true">
        <Spinner className="h-6 w-6" />
        <p className="text-muted-foreground text-sm">Loading team...</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <p className="text-destructive mb-4 text-sm" role="alert">
          {fetchError}
        </p>
        <Button variant="secondary" onClick={() => fetchMembers()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team Members</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage who has access to this workspace
          </p>
        </div>
        <Button onClick={() => setShowInvite(!showInvite)} className="shrink-0">
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Invite Member
        </Button>
      </div>

      {showInvite && (
        <form
          onSubmit={handleInvite}
          className="bg-card mb-6 rounded-xl border p-4 shadow-sm sm:p-6"
        >
          <h2 className="mb-4 text-lg font-semibold">Invite Team Member</h2>
          {error && (
            <div
              className="bg-destructive/10 text-destructive mb-4 rounded-md p-3 text-sm"
              role="alert"
            >
              {error}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Email" htmlFor="invite-email">
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                placeholder="teammate@example.com"
              />
            </FormField>
            <FormField label="Role" htmlFor="invite-role">
              <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
                <option value="VIEWER">Viewer</option>
                <option value="SECURITY_ADMIN">Security Admin</option>
                <option value="APPSEC_MANAGER">AppSec Manager</option>
                <option value="DEVELOPER">Developer</option>
                <option value="AUDITOR">Auditor</option>
                <option value="BILLING_ADMIN">Billing Admin</option>
                <option value="EXTERNAL_PENTESTER">External Pentester</option>
              </Select>
            </FormField>
          </div>
          <div className="mt-4 flex gap-2">
            <Button type="submit" disabled={inviting}>
              {inviting ? "Inviting..." : "Send Invite"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setShowInvite(false)
                setError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="mb-6 overflow-x-auto rounded-xl border shadow-sm">
        <div className="border-b p-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="text-primary h-5 w-5" aria-hidden="true" />
            Members ({members.length})
          </h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted/30 border-b">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Name</th>
              <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Email</th>
              <th className="px-4 py-3 text-left font-semibold">Role</th>
              <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium">{m.name}</td>
                <td className="text-muted-foreground hidden px-4 py-3 sm:table-cell">{m.email}</td>
                <td className="px-4 py-3">
                  <Badge
                    variant={m.role === "OWNER" ? "default" : m.role === "ADMIN" ? "info" : "muted"}
                  >
                    {m.role}
                  </Badge>
                </td>
                <td className="text-muted-foreground hidden px-4 py-3 sm:table-cell">
                  {new Date(m.createdAt).toLocaleDateString("en-US", { timeZone: "UTC" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {invitations.length > 0 && (
        <div className="overflow-x-auto rounded-xl border shadow-sm">
          <div className="border-b p-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Mail className="text-primary h-5 w-5" aria-hidden="true" />
              Pending Invitations ({invitations.length})
            </h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/30 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Email</th>
                <th className="px-4 py-3 text-left font-semibold">Role</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Expires</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{inv.email}</td>
                  <td className="px-4 py-3">
                    <Badge variant="muted">{inv.role}</Badge>
                  </td>
                  <td className="text-muted-foreground hidden px-4 py-3 sm:table-cell">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden="true" />
                      {new Date(inv.expiresAt).toLocaleDateString("en-US", { timeZone: "UTC" })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
