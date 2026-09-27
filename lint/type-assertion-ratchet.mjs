import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const baseline = JSON.parse(readFileSync(new URL("./type-assertion-baseline.json", import.meta.url)))

function signature({ kind, sha256 }) {
  return `${kind}:${sha256}`
}

// Temporary DB-04..19 debt. Exact expression hashes and counts keep new assertions visible.
export function makeTypeAssertionRatchet(approved = baseline) {
  return {
    meta: {
      type: "problem",
      docs: { description: "Ratchet existing double-unknown and never assertions" },
      messages: {
        new: "Double-unknown or never assertion needs a guard or reviewed baseline entry.",
        stale: "Remove stale type assertion baseline entry {{entry}}.",
      },
    },
    create(context) {
      const file = relative(root, context.filename).split(sep).join("/")
      const allowed = new Map((approved[file] ?? []).map((entry) => [signature(entry), entry.count]))
      const seen = new Map()

      return {
        TSAsExpression(node) {
          const kind =
            node.typeAnnotation.type === "TSNeverKeyword"
              ? "never"
              : node.expression.type === "TSAsExpression" &&
                  node.expression.typeAnnotation.type === "TSUnknownKeyword"
                ? "double-unknown"
                : null
          if (!kind) return

          const sha256 = createHash("sha256")
            .update(context.sourceCode.getText(node))
            .digest("hex")
          const entry = signature({ kind, sha256 })
          const count = seen.get(entry) ?? 0
          if (count >= (allowed.get(entry) ?? 0)) context.report({ node, messageId: "new" })
          else seen.set(entry, count + 1)
        },
        "Program:exit"(node) {
          for (const [entry, count] of allowed) {
            if ((seen.get(entry) ?? 0) < count) {
              context.report({ node, messageId: "stale", data: { entry } })
            }
          }
        },
      }
    },
  }
}

export default {
  rules: { "no-new-unsafe-assertion": makeTypeAssertionRatchet() },
}
