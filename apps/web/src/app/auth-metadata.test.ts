import { describe, expect, it } from "vitest"
import { metadata as forgotPasswordMetadata } from "./forgot-password/layout"
import { metadata as oauthMetadata } from "./oauth/layout"
import { metadata as resetPasswordMetadata } from "./reset-password/layout"
import { metadata as signInMetadata } from "./sign-in/layout"
import { metadata as signUpMetadata } from "./sign-up/layout"
import { metadata as twoFactorMetadata } from "./two-factor/layout"

describe("authentication utility metadata", () => {
  it("keeps every credential and OAuth utility out of search indexes", () => {
    for (const metadata of [
      signInMetadata,
      signUpMetadata,
      forgotPasswordMetadata,
      resetPasswordMetadata,
      twoFactorMetadata,
      oauthMetadata,
    ]) {
      expect(metadata.robots).toMatchObject({ index: false, follow: false })
    }
  })
})
