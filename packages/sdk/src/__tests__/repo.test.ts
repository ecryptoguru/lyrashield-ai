import { describe, it, expect } from "vitest"
import { parseRepoIdentifier } from "../repo.js"

describe("parseRepoIdentifier", () => {
  it("parses a bare owner/repo as GitHub", () => {
    const repo = parseRepoIdentifier("ecryptoguru/lyrashield-ai")
    expect(repo).toEqual({
      repoProvider: "github",
      repoOwner: "ecryptoguru",
      repoName: "lyrashield-ai",
      repoFullName: "ecryptoguru/lyrashield-ai",
    })
  })

  it("parses an HTTPS URL", () => {
    const repo = parseRepoIdentifier("https://github.com/ecryptoguru/lyrashield-ai.git")
    expect(repo).toEqual({
      repoProvider: "github",
      repoOwner: "ecryptoguru",
      repoName: "lyrashield-ai",
      repoFullName: "ecryptoguru/lyrashield-ai",
    })
  })

  it("parses an SSH URL", () => {
    const repo = parseRepoIdentifier("git@github.com:ecryptoguru/lyrashield-ai.git")
    expect(repo).toEqual({
      repoProvider: "github",
      repoOwner: "ecryptoguru",
      repoName: "lyrashield-ai",
      repoFullName: "ecryptoguru/lyrashield-ai",
    })
  })

  it("parses a GitLab nested group", () => {
    const repo = parseRepoIdentifier("https://gitlab.com/group/subgroup/repo")
    expect(repo).toEqual({
      repoProvider: "gitlab",
      repoOwner: "group/subgroup",
      repoName: "repo",
      repoFullName: "group/subgroup/repo",
    })
  })

  it("rejects non-repo paths on GitHub", () => {
    expect(
      parseRepoIdentifier("https://github.com/ecryptoguru/lyrashield-ai/pulls/1")
    ).toBeUndefined()
  })

  it("rejects invalid strings", () => {
    expect(parseRepoIdentifier("not-a-repo")).toBeUndefined()
    expect(parseRepoIdentifier("a/b/c")).toBeUndefined()
    expect(parseRepoIdentifier("https://github.com/ecryptoguru")).toBeUndefined()
  })
})
