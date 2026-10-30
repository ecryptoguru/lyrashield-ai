import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { writeFile, mkdir } from "fs/promises"
import * as fsPromises from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { scanIac } from "./iac-scanner"
import type { ScannerDiscovery } from "../scanner-coverage"

const TEST_DIR = join(tmpdir(), "lyrashield-iac-test-" + Date.now())
const INLINE_SECRET_FIXTURE = ["password = ", '"', "correct-horse-staple", '"'].join("")

async function setupRepo(files: Record<string, string>): Promise<string> {
  await mkdir(TEST_DIR, { recursive: true })
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(TEST_DIR, filePath)
    await mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true })
    await writeFile(fullPath, content, "utf-8")
  }
  return TEST_DIR
}

function cleanupRepo(): void {
  rmSync(TEST_DIR, { recursive: true, force: true })
}

describe("scanIac", () => {
  beforeEach(() => {
    cleanupRepo()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    cleanupRepo()
  })

  it("flags Dockerfile risks and leaves pinned builds alone", async () => {
    const dir = await setupRepo({
      Dockerfile: [
        "FROM node",
        "RUN curl https://get.example.sh | sh",
        "ENV DATABASE_PASSWORD=hunter2",
        "USER root",
      ].join("\n"),
      "deploy/Dockerfile.web": "FROM node:20-alpine\nUSER app\n",
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    const ids = findings.map((f) => f.id)
    expect(ids.some((id) => id.startsWith("iac-dockerfile-latest-base"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-dockerfile-curl-pipe-shell"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-dockerfile-secret-env"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-dockerfile-user-root"))).toBe(true)
    // The pinned image must not trip the unpinned-base rule.
    expect(findings.filter((f) => f.id.includes("Dockerfile.web"))).toEqual([])
  })

  it("flags privileged/host-mode compose services and committed env secrets", async () => {
    const dir = await setupRepo({
      "docker-compose.yml": [
        "services:",
        "  db:",
        "    image: postgres:16",
        "    privileged: true",
        "    network_mode: host",
        "    environment:",
        "      POSTGRES_PASSWORD: supersecret123",
        "      API_KEY: ${API_KEY}",
      ].join("\n"),
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    const ids = findings.map((f) => f.id)
    expect(ids.some((id) => id.startsWith("iac-compose-privileged"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-compose-host-network"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-compose-secret-env"))).toBe(true)
    // Interpolated secrets are not committed values.
    expect(findings.filter((f) => f.poc_description?.includes("API_KEY"))).toEqual([])
  })

  it("flags k8s privilege risks and the missing-securityContext absence", async () => {
    const dir = await setupRepo({
      "deploy/app.yaml": [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        "      - name: app",
        "        image: app:1",
        "        volumeMounts:",
        "        - name: host",
        "          mountPath: /host",
        "      volumes:",
        "      - name: host",
        "        hostPath:",
        "          path: /etc",
      ].join("\n"),
      "deploy/role.yaml": [
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: ClusterRole",
        "rules:",
        "- apiGroups: ['*']",
        "  resources: ['*']",
        "  verbs: ['*']",
      ].join("\n"),
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    const ids = findings.map((f) => f.id)
    expect(ids.some((id) => id.startsWith("iac-k8s-hostpath"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-k8s-wildcard-rbac"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-k8s-missing-security-context"))).toBe(true)
  })

  it("flags Terraform public exposure, wildcard IAM, and inline secrets", async () => {
    const dir = await setupRepo({
      "infra/main.tf": [
        'resource "aws_security_group" "web" {',
        "  ingress {",
        '    cidr_blocks = ["0.0.0.0/0"]',
        "  }",
        "}",
        'resource "aws_s3_bucket_acl" "data" {',
        '  acl = "public-read"',
        "}",
        'resource "aws_iam_policy" "admin" {',
        '  actions = ["*"]',
        "}",
        'variable "db_password" { default = "correct-horse-staple" }',
      ].join("\n"),
      "infra/safe.tf": [
        'resource "aws_s3_bucket" "logs" {',
        "  bucket = var.logs_bucket",
        "}",
      ].join("\n"),
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    const ids = findings.map((f) => f.id)
    expect(ids.some((id) => id.startsWith("iac-tf-open-ingress"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-tf-public-acl"))).toBe(true)
    expect(ids.some((id) => id.startsWith("iac-tf-inline-secret"))).toBe(true)
    // `var.` references are not committed literals.
    expect(findings.filter((f) => f.id.includes("safe.tf"))).toEqual([])
  })

  it("requires the existing resource contexts for RBAC and Terraform exposure rules", async () => {
    const dir = await setupRepo({
      "deploy/config.yaml": "apiVersion: v1\nkind: ConfigMap\ndata:\n  wildcard: '*'",
      "infra/values.tf": 'locals {\n  cidr_blocks = ["0.0.0.0/0"]\n  Principal = "*"\n}',
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(
      findings.filter((finding) =>
        ["iac-k8s-wildcard-rbac", "iac-tf-open-ingress", "iac-tf-public-bucket-policy"].some(
          (prefix) => finding.id.startsWith(prefix)
        )
      )
    ).toEqual([])
  })

  it("does not treat sensitive=true as removal of a committed Terraform secret", async () => {
    const dir = await setupRepo({
      "main.tf": 'variable "password" { default = "correct-horse-staple" sensitive = true }',
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(findings.some((finding) => finding.id.startsWith("iac-tf-inline-secret"))).toBe(true)
  })

  it("binds secret defaults to their own Terraform variable block", async () => {
    const dir = await setupRepo({
      "main.tf": [
        'variable "password" {',
        '  description = "Braces in docs: } {"',
        '  default = "correct-horse-staple"',
        "  validation {",
        "    condition = true",
        '    error_message = "Invalid password"',
        "  }",
        "}",
        'variable "region" {',
        '  default = "us-east-1"',
        "}",
        '// variable "api_token" {',
        'variable "instance_name" {',
        '  default = "production-web"',
        "}",
      ].join("\n"),
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    const defaults = findings.filter((finding) =>
      finding.id.startsWith("iac-tf-variable-secret-default")
    )
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.code_locations?.[0]?.start_line).toBe(3)
  })

  it("emits a discovery receipt and skips non-IaC yaml", async () => {
    const dir = await setupRepo({
      Dockerfile: "FROM node:20\nUSER app\n",
      "config/settings.yaml": "feature_flag: true\n",
    })
    const discovery: ScannerDiscovery = {}
    await scanIac({ repoPath: dir, workspaceDir: dir, discovery })
    const receipt = discovery.iac as {
      filesScanned: number
      bytesScanned: number
      skippedByReason: Record<string, number>
    }
    expect(receipt.filesScanned).toBe(1)
    expect(receipt.skippedByReason.notIacContent).toBe(1)
  })

  it("ignores fixture directories", async () => {
    const dir = await setupRepo({
      "fixtures/docker-compose.yml": "services:\n  x:\n    privileged: true",
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(findings).toEqual([])
  })

  it("records incomplete coverage when repository discovery fails", async () => {
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    await scanIac({ repoPath: TEST_DIR, workspaceDir: TEST_DIR, coverageIssues, discovery })
    expect(discovery.iac?.filesScanned).toBe(0)
    expect(discovery.iac?.skippedByReason.unreadable).toBe(1)
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "iac", status: "partial" })
    )
  })

  it("records incomplete coverage when an eligible file cannot be read", async () => {
    const dir = await setupRepo({ "app.tf": INLINE_SECRET_FIXTURE })
    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(new Error("read failed"))
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    await scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues, discovery })
    expect(discovery.iac?.filesScanned).toBe(0)
    expect(discovery.iac?.skippedByReason.unreadable).toBe(1)
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "iac", status: "partial" })
    )
  })

  it("marks per-file finding caps as bounded coverage", async () => {
    const dir = await setupRepo({
      "app.tf": Array(101).fill(INLINE_SECRET_FIXTURE).join("\n"),
    })
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues, discovery })
    expect(findings).toHaveLength(100)
    expect(discovery.iac?.skippedByReason.findingLimit).toBe(1)
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "iac", status: "bounded", subject: "app.tf" })
    )
  })

  it("counts only inspected files after reaching the total finding cap", async () => {
    const content = Array(101).fill(INLINE_SECRET_FIXTURE).join("\n")
    const files = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [
        `app-${String(index).padStart(2, "0")}.tf`,
        content,
      ])
    )
    const dir = await setupRepo(files)
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues, discovery })
    expect(findings).toHaveLength(5000)
    expect(discovery.iac?.filesScanned).toBe(50)
    expect(discovery.iac?.bytesScanned).toBe(50 * Buffer.byteLength(content))
    expect(discovery.iac?.skippedByReason.findingLimit).toBe(51)
  })
})

describe("contextual IaC accuracy", () => {
  afterEach(cleanupRepo)
  beforeEach(cleanupRepo)
  it.each([
    "FROM node:24 AS build\nUSER root\nFROM build AS final\nUSER app\n",
    "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nUSER app\n",
    "FROM node:24 AS build\nUSER app\nFROM build\n",
  ])(
    "does not call a stage alias, unresolved image or superseded root user unsafe: %s",
    async (content) => {
      const dir = await setupRepo({ Dockerfile: content })
      const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
      expect(
        findings.filter(
          (f) =>
            f.id.startsWith("iac-dockerfile-latest-base") ||
            f.id.startsWith("iac-dockerfile-user-root")
        )
      ).toEqual([])
    }
  )
  it("resets USER for an independent final stage", async () => {
    const dir = await setupRepo({ Dockerfile: "FROM node:24 AS build\nUSER app\nFROM node:24\n" })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(findings.filter((f) => f.id.startsWith("iac-dockerfile-user-root"))).toHaveLength(1)
  })
  it("detects list/mapping credential literals but excludes secret-file paths and non-environment keys", async () => {
    const dir = await setupRepo({
      "compose.yml":
        "services:\n  app:\n    environment:\n      - PASSWORD=value123\n      - TOKEN_FILE=/run/secrets/token\n  other:\n    environment:\n      API_KEY: literal123\n      PASSWORD_FILE: /run/secrets/pwd\n    labels:\n      SECRET: harmless-label\n",
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(
      findings
        .filter((f) => f.id.startsWith("iac-compose-secret-env"))
        .map((f) => f.code_locations?.[0]?.start_line)
    ).toEqual([4, 8])
  })
  it("reports inbound public CIDRs without mislabeling outbound access", async () => {
    const dir = await setupRepo({
      "main.tf":
        'resource "aws_security_group" "app" {\n  ingress {\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n  egress {\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\nresource "aws_security_group_rule" "out" {\n  type = "egress"\n  cidr_blocks = ["0.0.0.0/0"]\n}\nresource "aws_security_group_rule" "in" {\n  cidr_blocks = ["0.0.0.0/0"]\n  type = "ingress"\n}\n',
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(
      findings
        .filter((f) => f.id.startsWith("iac-tf-open-ingress"))
        .map((f) => f.code_locations?.[0]?.start_line)
    ).toEqual([3, 14])
  })
})

it("does not lose the absence of a non-root user when the final stage inherits a stage alias", async () => {
  cleanupRepo()
  try {
    const dir = await setupRepo({
      Dockerfile: "FROM node:24 AS build\nRUN echo build\nFROM build\n",
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(findings.filter((f) => f.id.startsWith("iac-dockerfile-user-root"))).toHaveLength(1)
  } finally {
    cleanupRepo()
  }
})

it.each([
  ["FROM node:24 AS build\nUSER app\nFROM 0\n", []],
  ["FROM localhost:5000/image\nUSER app\n", ["iac-dockerfile-latest-base"]],
  ["FROM node:24\nENV TOKEN_FILE=/run/secrets/token\nUSER app\n", []],
])(
  "keeps stage indices and registry ports distinct from image tags: %s",
  async (content, expected) => {
    cleanupRepo()
    try {
      const dir = await setupRepo({ Dockerfile: content })
      const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
      expect(findings.map((f) => f.id.split("-Dockerfile")[0])).toEqual(expected)
    } finally {
      cleanupRepo()
    }
  }
)

it("recognizes quoted Compose credential keys without treating quoted _FILE keys as credentials", async () => {
  cleanupRepo()
  try {
    const dir = await setupRepo({
      "compose.yml":
        'services:\n  app:\n    environment:\n      "PASSWORD": literal123\n      "TOKEN_FILE": /run/secrets/token\n',
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    expect(
      findings
        .filter((f) => f.id.startsWith("iac-compose-secret-env"))
        .map((f) => f.code_locations?.[0]?.start_line)
    ).toEqual([4])
  } finally {
    cleanupRepo()
  }
})
