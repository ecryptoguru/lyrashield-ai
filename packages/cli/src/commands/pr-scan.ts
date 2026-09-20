import { handleScan } from "./scan.js"
import type { Output } from "../output.js"

function hasOption(args: string[], long: string, short: string): boolean {
  return args.some(
    (arg) => arg === long || arg === short || arg.startsWith(`${long}=`) || arg.startsWith(short)
  )
}

export async function handlePrScan(args: string[], output: Output): Promise<number> {
  // `lyrashield pr-scan` is a convenience alias for `lyrashield scan --goal CHECK_PR`.
  // `--base`/`--head` pass straight through to `scan`, which submits them as a
  // recorded Review Changes (diff-scope) run — distinct from the advisory,
  // non-recorded `check-diff` command.
  const autoGoal = hasOption(args, "--goal", "-g") ? [] : ["--goal", "CHECK_PR"]
  const autoMode = hasOption(args, "--mode", "-m") ? [] : ["--mode", "QUICK"]
  return handleScan([...autoGoal, ...autoMode, ...args], output)
}
