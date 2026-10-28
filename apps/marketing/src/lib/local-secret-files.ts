import { scanTextForSecrets } from "./tool-checks"

export const SECRET_FILE_LIMIT = 20
export const SECRET_FILE_BYTES = 1_000_000

type LocalFile = Pick<File, "name" | "size" | "type" | "text">

/** Bounded local-only review. Counts describe the files actually read, never the whole selection. */
export async function reviewSecretFiles(files: readonly LocalFile[]): Promise<string[]> {
  if (!files.length) return ["No files selected. Choose up to 20 text files to review locally."]
  if (files.length > SECRET_FILE_LIMIT) {
    return [
      `${files.length} files selected; 0 scanned. Choose at most ${SECRET_FILE_LIMIT} files and try again. No files were read.`,
    ]
  }
  const messages: string[] = []
  let scanned = 0
  let matches = 0
  for (const file of files) {
    if (file.size > SECRET_FILE_BYTES) {
      messages.push(`${file.name}: skipped because it exceeds 1 MB.`)
      continue
    }
    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? ""
    const textName =
      file.name === ".env" ||
      file.name.startsWith(".env.") ||
      new Set([
        "env",
        "txt",
        "js",
        "jsx",
        "ts",
        "tsx",
        "json",
        "yaml",
        "yml",
        "toml",
        "md",
        "sql",
        "sh",
        "py",
        "go",
        "java",
        "rb",
        "php",
        "css",
        "html",
        "csv",
        "xml",
        "ini",
        "conf",
        "config",
      ]).has(extension)
    if (!textName || /^(?:image|audio|video|font)\//.test(file.type)) {
      messages.push(`${file.name}: skipped because it is not a supported text file.`)
      continue
    }
    try {
      const text = await file.text()
      if (text.includes("\u0000") || text.includes("\ufffd")) {
        messages.push(
          `${file.name}: skipped because it contains binary or unsupported text encoding. Use UTF-8 text.`
        )
        continue
      }
      scanned++
      for (const observation of scanTextForSecrets(text)) {
        matches++
        messages.push(
          `${file.name}: possible ${observation.kind} ${observation.preview}; rotate it if real.`
        )
      }
    } catch {
      messages.push(
        `${file.name}: could not be read. Re-select a readable UTF-8 text file and try again.`
      )
    }
  }
  const skipped = files.length - scanned
  return [
    `${files.length} selected; ${scanned} scanned; ${skipped} skipped.${skipped ? " Partial review: skipped files were not assessed." : ""}`,
    ...messages,
    ...(matches || !scanned
      ? []
      : [
          "No high-confidence patterns found in the scanned text files. This does not establish that they contain no secrets.",
        ]),
  ]
}
