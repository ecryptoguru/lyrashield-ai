export function canPurchaseMinutePack(input: {
  effectivePlan: string
  trialState: { isExpired: boolean }
}): boolean {
  return !(input.effectivePlan === "FREE" && input.trialState.isExpired)
}
