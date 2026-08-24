import { describe, expect, it } from "vitest"
import {
  validatePlatformAdminCandidates,
  type PlatformAdminCandidate,
} from "./provision-platform-admins"

const valid: PlatformAdminCandidate[] = [
  {
    id: "user-1",
    email: "ecryptoguru@gmail.com",
    emailVerified: true,
    twoFactorEnabled: true,
    twoFactors: [{ id: "totp-1" }],
    platformRole: null,
  },
  {
    id: "user-2",
    email: "ankit@lyrashieldai.com",
    emailVerified: true,
    twoFactorEnabled: true,
    twoFactors: [{ id: "totp-2" }],
    platformRole: null,
  },
]

describe("platform admin provisioning preflight", () => {
  it("accepts exactly the two verified MFA accounts", () => {
    expect(validatePlatformAdminCandidates(valid, [])).toHaveLength(2)
  })

  it.each([
    ["missing", valid.slice(0, 1), []],
    ["duplicate", [...valid, { ...valid[0]!, id: "duplicate" }], []],
    ["unverified", [{ ...valid[0]!, emailVerified: false }, valid[1]!], []],
    ["without MFA", [{ ...valid[0]!, twoFactorEnabled: false }, valid[1]!], []],
    ["without verified TOTP", [{ ...valid[0]!, twoFactors: [] }, valid[1]!], []],
    [
      "duplicate verified TOTP",
      [
        {
          ...valid[0]!,
          twoFactors: [{ id: "totp-1" }, { id: "totp-duplicate" }],
        },
        valid[1]!,
      ],
      [],
    ],
    [
      "third operator",
      valid,
      [
        {
          ...valid[0]!,
          id: "user-3",
          email: "third@example.com",
          platformRole: "PLATFORM_OPERATOR",
        },
      ],
    ],
  ])("rejects %s state", (_label, candidates, operators) => {
    expect(() => validatePlatformAdminCandidates(candidates, operators)).toThrow()
  })
})
