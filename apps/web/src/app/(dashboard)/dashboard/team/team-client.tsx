"use client"

import { useState, useEffect, useCallback } from "react"
import { UserPlus, Mail, Clock, Users } from "lucide-react"
import { Button, Badge, FormField, Input, Select } from "@lyrashield/ui"

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
      const res = await fetch(`/api/team?workspaceId=${workspaceId}`)
      const data = await res.json()
      if (data.success) {
        setMembers(data.data.members)
        setInvitations(data.data.invitations)
        setFetchError(null)
      } else {
        setFetchError(data.error?.message ?? "Failed to load team members")
      }
    } catch {
      setFetchError("Failed to load team members")
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
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, email, role }),
      })
      const data = await res.json()
      if (data.success) {
        setEmail("")
        setRole("MEMBER")
        setShowInvite(false)
        await fetchMembers()
      } else {
        setError(data.error?.message ?? "Failed to invite member")
      }
    } catch {
      setError("Failed to invite member")
    } finally {
      setInviting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading team...</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <p className="mb-4 text-sm text-destructive" role="alert">{fetchError}</p>
        <Button variant="secondary" onClick={() => fetchMembers()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team Members</h1>
          <p className="text-sm text-muted-foreground">Manage who has access to this workspace</p>
        </div>
        <Button onClick={() => setShowInvite(!showInvite)}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Invite Member
        </Button>
      </div>

      {showInvite && (
        <form onSubmit={handleInvite} className="mb-6 rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Invite Team Member</h2>
          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
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
              <Select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
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
            <Button type="button" variant="secondary" onClick={() => {
              setShowInvite(false)
              setError(null)
            }}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="mb-6 rounded-lg border">
        <div className="border-b p-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-5 w-5" aria-hidden="true" />
            Members ({members.length})
          </h2>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Email</th>
              <th className="px-4 py-3 text-left font-medium">Role</th>
              <th className="px-4 py-3 text-left font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium">{m.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{m.email}</td>
                <td className="px-4 py-3">
                  <Badge variant={
                    m.role === "OWNER" ? "info" :
                    m.role === "ADMIN" ? "info" :
                    "muted"
                  }>
                    {m.role}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {invitations.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b p-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Mail className="h-5 w-5" aria-hidden="true" />
              Pending Invitations ({invitations.length})
            </h2>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Email</th>
                <th className="px-4 py-3 text-left font-medium">Role</th>
                <th className="px-4 py-3 text-left font-medium">Expires</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{inv.email}</td>
                  <td className="px-4 py-3">
                    <Badge variant="muted">{inv.role}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden="true" />
                      {new Date(inv.expiresAt).toLocaleDateString()}
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
