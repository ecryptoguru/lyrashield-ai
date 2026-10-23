import { describe, expect, it } from "vitest"
import { composerContentHash, parseComposerManifest } from "./composer-dependencies"

// Literal hashes were obtained from Composer 2.10.3 Locker::getContentHash
// in composer@sha256:b6dcd72ca98fa19d0e5b8476de179859704891fad06dd9e0b96833d4c430a5fc.
describe("Composer content hash compatibility", () => {
  it.each([
    [
      '{"extra":{"ratio":1e-7},"require":{"vendor/pkg":"^1.0"}}',
      "39962b84c9bd426eed346ccc919b33f2",
    ],
    [
      '{"extra":{"1":"a","0":"b"},"require":{"vendor/pkg":"^1.0"}}',
      "9634f73fe85d91386dcda949cd542d66",
    ],
    [
      '{"require":{"vendor/pkg":"^1.0"},"extra":{"1":"b","0":"a"}}',
      "ad6f9f540ecf5bdafc1b7c4dec63a3fb",
    ],
    ...[
      ["1e-5", "665330ca4f59bb2f3a12b91bb4ff3807"],
      ["1e-4", "9c27b318364ef7d94109f3550ff001de"],
      ["1e16", "0ff4b0fcf8ac06d56b4c33a0cbb1e8c9"],
      ["1e17", "520b2ad78a0351ca565c5c5327011285"],
      ["-0.0", "c152bcfd60bbe59f49a63882d1d9597b"],
      ["9007199254740993", "0857e0e37ad02580b6944355a908b834"],
      ["9223372036854775807", "0ff205c396ca3af3dba174c09b1490d4"],
      ["9223372036854775808", "358344889511394bbc54dd482164bff8"],
    ].map(([number, expected]) => [
      `{"require":{"vendor/pkg":"^1.0"},"extra":{"ratio":${number}}}`,
      expected,
    ]),
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
