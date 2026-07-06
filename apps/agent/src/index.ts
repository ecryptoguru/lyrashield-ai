export { ActionRegistry } from "./registry"
export { signServiceToken, verifyServiceToken } from "./service-token"
export {
  listTargetsAction,
  runScanAction,
  getScanStatusAction,
  listFindingsAction,
  getFindingAction,
  explainFindingAction,
} from "./actions"
export { explainFinding, type PlainLanguageFinding } from "./plain-language-bridge"
export { enqueueScanJob } from "./queue"

import { ActionRegistry } from "./registry"
import {
  listTargetsAction,
  runScanAction,
  getScanStatusAction,
  listFindingsAction,
  getFindingAction,
  explainFindingAction,
} from "./actions"

export function createAgentRegistry(): ActionRegistry {
  const registry = new ActionRegistry()
  registry.register(listTargetsAction)
  registry.register(runScanAction)
  registry.register(getScanStatusAction)
  registry.register(listFindingsAction)
  registry.register(getFindingAction)
  registry.register(explainFindingAction)
  return registry
}
