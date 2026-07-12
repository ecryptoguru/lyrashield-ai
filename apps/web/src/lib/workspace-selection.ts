export function selectActiveWorkspaceId(
  memberships: ReadonlyArray<{ workspaceId: string }>,
  requestedWorkspaceId?: string
): string | null {
  if (
    requestedWorkspaceId &&
    memberships.some((membership) => membership.workspaceId === requestedWorkspaceId)
  ) {
    return requestedWorkspaceId
  }

  return memberships[0]?.workspaceId ?? null
}
