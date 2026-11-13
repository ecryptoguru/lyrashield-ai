import { evaluateScanSetup } from "./evaluator"

export async function GET(request: Request) {
  return (await evaluateScanSetup(request)).response
}
