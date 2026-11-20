// ─────────────────────────────────────────────────────────────
// Cost cap — a USD ceiling priced by the caller.
// ─────────────────────────────────────────────────────────────
// The library ships no price table. Callers turn usage into an
// estimated USD cost, keep a running total, and call
// `assertWithinCostCap` at the checkpoints they choose (after a round,
// after the judge, …). AdjudicationEngine takes a `CostCap` directly.

/** Thrown when an estimated running cost crosses the configured cap. */
export class CostCapExceededError extends Error {
  constructor(
    public readonly runningCostUSD: number,
    public readonly capUSD: number,
  ) {
    super(`Cost cap exceeded: estimated $${runningCostUSD.toFixed(4)} > $${capUSD.toFixed(4)} cap`);
    this.name = "CostCapExceededError";
  }
}

/**
 * Throw {@link CostCapExceededError} when `runningCostUSD` is strictly
 * above `capUSD`. An undefined, zero or negative cap disables the check.
 */
export function assertWithinCostCap(runningCostUSD: number, capUSD: number | undefined): void {
  if (!capUSD || capUSD <= 0) return;
  if (runningCostUSD > capUSD) {
    throw new CostCapExceededError(runningCostUSD, capUSD);
  }
}
