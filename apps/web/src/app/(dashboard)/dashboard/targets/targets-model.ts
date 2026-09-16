import { paginatedResponseSchema, targetSchema } from "@/lib/api-schemas"

export interface Target {
  id: string
  name: string
  type: string
  url: string | null
  apiSpecUrl: string | null
  repoFullName: string | null
  branch: string | null
  environment: string
  status: string
  lastScanAt: string | null
  project: { id: string; name: string } | null
  scanCount: number
  findingCount: number
  createdAt: string
  domainVerificationStatus?: string
}

export interface GithubRepo {
  id: number
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
  installationId: string
}

export const targetsPaginatedSchema = paginatedResponseSchema(targetSchema)

export interface RepoFormState {
  name: string
  repoOwner: string
  repoName: string
  branch: string
  installationId: string
}

export interface UrlFormState {
  name: string
  url: string
  apiSpecUrl: string
  urlType: "WEB_APP" | "API"
  ownershipAttested: boolean
}

export const EMPTY_REPO_FORM: RepoFormState = {
  name: "",
  repoOwner: "",
  repoName: "",
  branch: "",
  installationId: "",
}

export const EMPTY_URL_FORM: UrlFormState = {
  name: "",
  url: "",
  apiSpecUrl: "",
  urlType: "WEB_APP",
  ownershipAttested: false,
}
