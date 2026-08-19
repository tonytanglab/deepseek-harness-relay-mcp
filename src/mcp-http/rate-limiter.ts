export class PrincipalRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>()

  constructor(private readonly capacity: number, private readonly now: () => number = Date.now) {}

  take(principal: string): boolean {
    const current = this.now()
    const existing = this.buckets.get(principal) ?? { tokens: this.capacity, updatedAt: current }
    const elapsed = Math.max(0, current - existing.updatedAt)
    const replenished = Math.min(this.capacity, existing.tokens + elapsed * this.capacity / 60_000)
    if (replenished < 1) {
      this.buckets.set(principal, { tokens: replenished, updatedAt: current })
      return false
    }
    this.buckets.set(principal, { tokens: replenished - 1, updatedAt: current })
    return true
  }
}
