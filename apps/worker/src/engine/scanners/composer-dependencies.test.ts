import { describe, expect, it } from "vitest"
import { composerContentHash, parseComposerManifest } from "./composer-dependencies"

// Literal hashes were obtained from Composer 2.10.3 Locker::getContentHash
// in composer@sha256:b6dcd72ca98fa19d0e5b8476de179859704891fad06dd9e0b96833d4c430a5fc.
describe("Composer content hash compatibility", () => {
  it.each([
    ["{}", "d751713988987e9331980363e24189ce"],
    ['{"require":{"vendor/pkg":"^1.0"}}', "744566ed8d27e73853a77d1b6ae30afc"],
    ['{"extra":{},"require":{"vendor/pkg":"^1.0"}}', "40cbebeac77285dc6bc70ee6b9f07f1b"],
    [
      '{"require":{"vendor/pkg":"^1.0"},"config":{"platform":{"php":"8.3"}},"extra":{"label":"café"}}',
      "3f16d196d709b813ed63de7f3ac1314c",
    ],
  ])("matches Composer for %s", (content, expected) => {
    expect(composerContentHash(parseComposerManifest(content!))).toBe(expected)
  })
})
