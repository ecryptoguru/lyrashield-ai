import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}))

import { AiAssuranceClient } from "./ai-assurance-client"

describe("AiAssuranceClient", () => {
  it("renders all seven evidence-required controls with accessible roles", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      evidenceId: `ce-${i}`,
      controlId: `vibe-${34 + i}`,
      controlTitle: `Control ${i + 1}`,
      state: "EVIDENCE_REQUIRED" as const,
      status: null,
      versionId: null,
      version: null,
      attestation: null,
      expiresAt: null,
      reviewedById: null,
      reviewedAt: null,
      createdAt: null,
      createdById: null,
      artifacts: [] as {
        id: string
        filename: string
        mediaType: string
        byteLength: number
        checksum: string
      }[],
    }))

    const html = renderToString(
      <AiAssuranceClient
        workspaceId="ws-1"
        targetId="target-1"
        targets={[{ id: "target-1", name: "Target A" }]}
        initialItems={items}
        canManage
        canReview
        initialProfile={null}
        initialThreatModel={null}
      />
    )

    expect(html).toContain("AI assurance control evidence")
    for (let index = 1; index <= 7; index++) expect(html).toContain(`Control ${index}`)
    expect(html).toContain("Customer-declared")
    expect(html).toContain("not verification, certification, or data-lineage proof")
    expect(html).not.toContain("s3://")
    expect(html).not.toContain("storageUri")
  })

  it("shows accepted and submitted states without exposing raw artifact storage", () => {
    const items = [
      {
        evidenceId: "ce-1",
        controlId: "vibe-34",
        controlTitle: "Missing audit trails",
        state: "EVIDENCE_ACCEPTED" as const,
        status: "ACCEPTED" as const,
        versionId: "v-1",
        version: 1,
        attestation: "audit log present",
        expiresAt: null,
        reviewedById: null,
        reviewedAt: null,
        createdAt: new Date().toISOString(),
        createdById: "user-1",
        artifacts: [
          {
            id: "art-1",
            filename: "proof.pdf",
            mediaType: "application/pdf",
            byteLength: 1234,
            checksum: "sha-1",
          },
        ],
      },
    ]

    const html = renderToString(
      <AiAssuranceClient
        workspaceId="ws-1"
        targetId="target-1"
        targets={[{ id: "target-1", name: "Target A" }]}
        initialItems={items}
        canManage
        canReview
        initialProfile={null}
        initialThreatModel={null}
      />
    )

    expect(html).toContain("Accepted")
    expect(html).toContain("proof.pdf")
    expect(html).toMatch(/1234[\s\S]*bytes/)
    expect(html).not.toContain("s3://")
    expect(html).not.toContain("storageUri")
    expect(html).not.toContain("encryptionKeyRef")
  })

  it("shows a fallback when no target is selected", () => {
    const html = renderToString(
      <AiAssuranceClient
        workspaceId="ws-1"
        targetId={null}
        targets={[]}
        initialItems={[]}
        canManage
        canReview
        initialProfile={null}
        initialThreatModel={null}
      />
    )

    expect(html).toContain("No targets available")
  })

  it("does not render mutation controls for a view-only member", () => {
    const html = renderToString(
      <AiAssuranceClient
        workspaceId="ws-1"
        targetId="target-1"
        targets={[{ id: "target-1", name: "Target A" }]}
        initialItems={[
          {
            evidenceId: null,
            controlId: "vibe-34",
            controlTitle: "Missing audit trails",
            state: "EVIDENCE_REQUIRED",
            status: null,
            versionId: null,
            version: null,
            attestation: null,
            expiresAt: null,
            reviewedById: null,
            reviewedAt: null,
            createdAt: null,
            createdById: null,
            artifacts: [],
          },
        ]}
        canManage={false}
        canReview={false}
        initialProfile={null}
        initialThreatModel={null}
      />
    )

    expect(html).not.toContain("Manage")
    expect(html).not.toContain("Submit evidence")
  })
})
