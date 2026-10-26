import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import {
  connectorScopesForInstallationPermissions,
  listInstallationRepos,
  type InstallationInfo,
} from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

/** Provider proof is completed by the caller before this shared binding path. */
export async function bindGitHubInstallation({
  installation,
  workspaceId,
  userId,
  setupAction,
  returnPath,
  origin,
}: {
  installation: InstallationInfo
  workspaceId: string
  userId: string
  setupAction: string | null
  returnPath: string
  origin: URL
}) {
  const canonicalInstallationId = String(installation.id)
  // The recorded grant must reflect what the provider actually granted.
  // Connector tools fail closed on `capabilities.scopes`, so derive them
  // from the installation's permission set — never invent scopes here.
  //
  // Resource scoping decision (stale-selection safety): an installation
  // with repository_selection "all" reaches every current and future repo
  // provider-side, so the grant stays resource-unconstrained — a stored
  // list would be stale-narrow immediately and could never widen access.
  // For "selected" (and for any missing or unrecognized value — the
  // narrower reading fails closed) the grant snapshots the provider's own
  // repository list. Repos added to the selection later deny until the
  // workspace reconnects; repos removed provider-side keep denying at the
  // GitHub API even while the snapshot still names them, so a stale
  // snapshot cannot widen effective access.
  const scopes = connectorScopesForInstallationPermissions(installation.permissions)
  const repositorySelection = installation.repository_selection === "all" ? "all" : "selected"
  let resources: string[] | undefined
  if (repositorySelection === "selected") {
    const repos = await listInstallationRepos(Number(canonicalInstallationId))
    resources = repos.map((repo) => `repo:${repo.full_name}`)
  }
  const capabilities = {
    scopes,
    ...(resources !== undefined ? { resources } : {}),
  }

  const metadata = {
    installationId: Number(canonicalInstallationId),
    accountLogin: installation.account.login,
    accountId: installation.account.id,
    accountType: installation.account.type,
    repositorySelection,
    setupAction,
  }

  // AuditLog carries no unique constraints, so a P2002 raised anywhere in this
  // block can only have come from the Integration write.
  try {
    // Upsert uses the workspace-specific key and does not pass through the
    // read guard that hides disconnected rows. The separate global unique
    // constraint rejects an installation owned by any other workspace.
    const data = {
      name: installation.account.login,
      status: "active",
      deletedAt: null,
      capabilities,
      metadata,
    }
    const integration = await prisma.integration.upsert({
      where: {
        workspaceId_type_externalId: {
          workspaceId,
          type: "GITHUB",
          externalId: canonicalInstallationId,
        },
      },
      create: { workspaceId, type: "GITHUB", externalId: canonicalInstallationId, ...data },
      update: data,
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "integration.github.connected",
        resourceType: "integration",
        resourceId: integration.id,
      },
    })

    logger.info("GitHub App installation connected", {
      installationId: canonicalInstallationId,
      workspaceId,
      account: installation.account.login,
    })

    const redirectUrl = new URL(returnPath, origin)
    redirectUrl.searchParams.set("connected", "github")
    return NextResponse.redirect(redirectUrl)
  } catch (err) {
    // @@unique([type, externalId]) — this installation is already bound to a
    // different workspace. Do not disclose which one.
    if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
      logger.warn("GitHub installation already bound to another workspace", {
        installationId: canonicalInstallationId,
        workspaceId,
      })
      const redirectUrl = new URL(returnPath, origin)
      redirectUrl.searchParams.set("github", "already_claimed")
      return NextResponse.redirect(redirectUrl)
    }
    throw err
  }
}
