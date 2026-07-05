async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Seed script must NOT run in production — it creates a predictable demo@lyrashield.ai OWNER account."
    )
  }

  const { PrismaClient } = await import("../src/generated/prisma")
  const { PrismaPg } = await import("@prisma/adapter-pg")

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  console.log("Seeding database...")

  // Create a demo user (references Better Auth user table)
  const demoUser = await prisma.user.upsert({
    where: { email: "demo@lyrashield.ai" },
    update: {},
    create: {
      id: "demo-user-id",
      name: "Demo User",
      email: "demo@lyrashield.ai",
      emailVerified: true,
    },
  })

  // Create a demo workspace
  const demoWorkspace = await prisma.workspace.upsert({
    where: { slug: "demo-workspace" },
    update: {},
    create: {
      name: "Demo Workspace",
      slug: "demo-workspace",
      mode: "VIBE",
      plan: "FREE",
    },
  })

  // Create owner membership
  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: demoWorkspace.id,
        userId: demoUser.id,
      },
    },
    update: {},
    create: {
      workspaceId: demoWorkspace.id,
      userId: demoUser.id,
      role: "OWNER",
      status: "active",
    },
  })

  // Create a default project
  const demoProject = await prisma.project.upsert({
    where: {
      id: "demo-project-id",
    },
    update: {},
    create: {
      id: "demo-project-id",
      workspaceId: demoWorkspace.id,
      name: "Demo Project",
      description: "A demo project for testing",
      ownerUserId: demoUser.id,
    },
  })

  // Create a default policy
  await prisma.policy.upsert({
    where: {
      id: "demo-policy-id",
    },
    update: {},
    create: {
      id: "demo-policy-id",
      workspaceId: demoWorkspace.id,
      name: "Default Policy",
      description: "Default scan policy with safe settings",
      networkEgressPolicy: "target_only",
      destructiveTestsAllowed: false,
      approvalRequired: false,
      maxDurationMinutes: 60,
      piiRedactionEnabled: true,
      evidenceRetentionDays: 30,
    },
  })

  console.log("Seed complete:", {
    user: demoUser.id,
    workspace: demoWorkspace.id,
    project: demoProject.id,
  })

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error("Seed failed:", e)
  process.exit(1)
})
