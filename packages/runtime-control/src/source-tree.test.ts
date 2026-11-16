import { execFileSync } from "node:child_process"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { readSourceTree } from "./source-tree"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lyra-source-tree-"))
  roots.push(root)
  mkdirSync(join(root, "pkg"), { mode: 0o700 })
  writeFileSync(join(root, "README.md"), "readme\n", { mode: 0o600 })
  writeFileSync(join(root, "pkg/mod.py"), "x = 1\n", { mode: 0o600 })
  return root
}
const options = { ownerUid: process.getuid!(), immutable: false }
it("preserves the engine's full D/F byte format and includes ignored files", () => {
  const root = fixture()
  expect(readSourceTree(root, options).stagedTreeDigest).toBe(
    "ab93f8d25dd1885e3e5d09b9bcfc70aa8f312d3b03766d49daa6d09230dd6e84"
  )
  writeFileSync(join(root, ".gitignore"), "ignored.py\n", { mode: 0o600 })
  writeFileSync(join(root, "ignored.py"), "first\n", { mode: 0o600 })
  const first = readSourceTree(root, options)
  writeFileSync(join(root, "ignored.py"), "other\n", { mode: 0o600 })
  expect(readSourceTree(root, options).stagedTreeDigest).not.toBe(first.stagedTreeDigest)
})
it("matches Python's Unicode ordering, directory records and binary source bytes", () => {
  const root = fixture()
  for (const name of ["\ue000", "𐀀", ".git", "empty"]) mkdirSync(join(root, name), { mode: 0o700 })
  writeFileSync(join(root, "\ue000", "binary"), Buffer.from([0, 255, 128]), { mode: 0o600 })
  const script = `import hashlib,os,sys
root=sys.argv[1]; digest=hashlib.sha256()
for base,dirs,files in os.walk(root,followlinks=False):
 dirs.sort()
 for marker,names in ((b'D',dirs),(b'F',sorted(files))):
  for name in names:
   path=os.path.join(base,name); relative=os.path.relpath(path,root).encode('utf-8')
   digest.update(marker+len(relative).to_bytes(8,'big')+relative)
   if marker==b'F':
    with open(path,'rb') as source:
     data=source.read(); digest.update(len(data).to_bytes(8,'big')+data)
print(digest.hexdigest())`
  const python = execFileSync("python3", ["-c", script, root], { timeout: 10000, maxBuffer: 1024 })
    .toString()
    .trim()
  expect(readSourceTree(root, options).stagedTreeDigest).toBe(python)
})
it.each(["symlink", "hardlink", "permissions", "owner"])(
  "rejects unsafe %s source input",
  (kind) => {
    const root = fixture()
    if (kind === "symlink") symlinkSync("/etc/hosts", join(root, "linked"))
    if (kind === "hardlink") linkSync(join(root, "README.md"), join(root, "linked"))
    if (kind === "permissions") chmodSync(join(root, "README.md"), 0o666)
    expect(() =>
      readSourceTree(
        root,
        kind === "owner" ? { ...options, ownerUid: options.ownerUid + 1 } : options
      )
    ).toThrow()
  }
)
it("requires immutable root ownership and Linux for protected mount verification", () => {
  const root = fixture()
  expect(() => readSourceTree(root, { ownerUid: 0, immutable: true })).toThrow()
})
