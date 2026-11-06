// Only authenticated, signed revocations for a registration that has not arrived
// reach this store. Never evict a live hold: its request can still arrive late.
export class RelayOwnerRevocations {
  private readonly expiries = new Map<string, number>()
  private overflowUntil = 0

  constructor(private readonly capacity = 4096) {}

  revoke(scanId: string, ownerId: string, expiry: number): void {
    const key = `${scanId}:${ownerId}`
    const previous = this.expiries.get(key)
    if (previous !== undefined) {
      this.expiries.set(key, Math.max(previous, expiry))
      return
    }
    const now = Date.now()
    if (this.expiries.size >= this.capacity && this.overflowUntil <= now) this.sweep(now)
    if (this.expiries.size >= this.capacity) {
      // Only new owned admissions consult this fence. Live streams continue.
      this.overflowUntil = Math.max(this.overflowUntil, expiry)
      return
    }
    this.expiries.set(key, expiry)
  }

  deniesAdmission(scanId: string, ownerId: string, now = Date.now()): boolean {
    return this.overflowUntil > now || (this.expiries.get(`${scanId}:${ownerId}`) ?? 0) > now
  }

  sweep(now: number): void {
    for (const [key, expiry] of this.expiries) {
      if (expiry <= now) this.expiries.delete(key)
    }
  }
}
