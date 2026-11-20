// ─────────────────────────────────────────────────────────────
// Aggregation — Borda count, Kendall's W, deterministic ranking,
// and the verdict rule for attempt adjudication.
// ─────────────────────────────────────────────────────────────
// Pure functions over candidate ids. Every ranking passed in must be a
// full permutation of the candidate ids (the juror parser guarantees
// this; direct callers get an Error otherwise).

import type {
  AdjudicationCandidate,
  AdjudicationFinding,
  FindingSeverity,
  NoClearWinnerReason,
  RankedCandidate,
} from "./types.js";

/** Neutral labels, assigned by position. Caps the candidate count at 26. */
export const CANDIDATE_LABELS: readonly string[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/** Weight of one verified finding in the tie-break and `findingWeight`. */
export const SEVERITY_WEIGHT: Readonly<Record<FindingSeverity, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

function assertPermutations(
  rankings: readonly (readonly string[])[],
  candidateIds: readonly string[],
): void {
  const ids = new Set(candidateIds);
  if (ids.size !== candidateIds.length) {
    throw new Error("aggregation: candidate ids must be unique.");
  }
  rankings.forEach((ranking, i) => {
    const seen = new Set(ranking);
    const ok =
      ranking.length === candidateIds.length &&
      seen.size === ranking.length &&
      ranking.every((id) => ids.has(id));
    if (!ok) {
      throw new Error(`aggregation: ranking ${i} is not a permutation of the candidate ids.`);
    }
  });
}

/**
 * Borda count. A candidate in position p (0-based) of a ranking over n
 * candidates earns n-1-p points; points are summed over every ranking.
 * Returns a record keyed by candidate id (every id present, 0 if no votes).
 */
export function bordaCount(
  rankings: readonly (readonly string[])[],
  candidateIds: readonly string[],
): Record<string, number> {
  assertPermutations(rankings, candidateIds);
  const n = candidateIds.length;
  const points = new Map<string, number>(candidateIds.map((id) => [id, 0]));
  for (const ranking of rankings) {
    ranking.forEach((id, pos) => {
      points.set(id, (points.get(id) ?? 0) + (n - 1 - pos));
    });
  }
  return Object.fromEntries(points);
}

/**
 * Kendall's coefficient of concordance for m complete rankings of n items:
 *
 *     W = 12·S / (m²·(n³ − n)),  S = Σᵢ (Rᵢ − m(n+1)/2)²
 *
 * where Rᵢ is the sum of the 1-based ranks item i received. 1 means every
 * ranking is identical; 0 means no agreement at all. W measures agreement
 * on the whole ordering, not on the winner. Returns null for fewer than
 * two rankings or fewer than two candidates, where W is undefined.
 */
export function kendallW(
  rankings: readonly (readonly string[])[],
  candidateIds: readonly string[],
): number | null {
  assertPermutations(rankings, candidateIds);
  const m = rankings.length;
  const n = candidateIds.length;
  if (m < 2 || n < 2) return null;
  const rankSums = new Map<string, number>(candidateIds.map((id) => [id, 0]));
  for (const ranking of rankings) {
    ranking.forEach((id, pos) => {
      rankSums.set(id, (rankSums.get(id) ?? 0) + pos + 1);
    });
  }
  const mean = (m * (n + 1)) / 2;
  let s = 0;
  for (const sum of rankSums.values()) s += (sum - mean) ** 2;
  const w = (12 * s) / (m * m * (n ** 3 - n));
  return Math.min(1, Math.max(0, w));
}

/** Severity-weighted finding count per candidate id. */
export function findingWeights(
  findings: readonly Pick<AdjudicationFinding, "candidateId" | "severity">[],
): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const f of findings) {
    out[f.candidateId] = (out[f.candidateId] ?? 0) + SEVERITY_WEIGHT[f.severity];
  }
  return out;
}

/**
 * Aggregate ranking. Order, most significant first:
 *   1. Borda points (descending)
 *   2. first-place votes (descending)
 *   3. severity-weighted verified findings (ascending)
 *   4. candidate id (ascending, by UTF-16 code unit — locale-independent)
 *
 * The order does not depend on input order. Eligibility (the failed-check
 * rule) is reported per candidate but never reorders the ranking.
 */
export function rankCandidates(params: {
  candidates: readonly Pick<AdjudicationCandidate, "id" | "checks">[];
  rankings: readonly (readonly string[])[];
  findings?: readonly Pick<AdjudicationFinding, "candidateId" | "severity">[];
}): RankedCandidate[] {
  const { candidates, rankings } = params;
  const ids = candidates.map((c) => c.id);
  const points = bordaCount(rankings, ids);
  const weights = findingWeights(params.findings ?? []);
  const firsts = new Map<string, number>();
  for (const ranking of rankings) {
    const top = ranking[0];
    if (top !== undefined) firsts.set(top, (firsts.get(top) ?? 0) + 1);
  }
  const failed = candidates.map((c) =>
    (c.checks ?? []).filter((check) => check.status === "failed").map((check) => check.name),
  );
  const someoneClean = failed.some((names) => names.length === 0);

  const rows = candidates.map((c, i) => ({
    candidateId: c.id,
    label: CANDIDATE_LABELS[i] ?? String(i),
    rank: 0,
    points: points[c.id] ?? 0,
    firstPlaceVotes: firsts.get(c.id) ?? 0,
    findingWeight: weights[c.id] ?? 0,
    failedChecks: failed[i] ?? [],
    eligible: (failed[i] ?? []).length === 0 || !someoneClean,
  }));
  rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.firstPlaceVotes - a.firstPlaceVotes ||
      a.findingWeight - b.findingWeight ||
      (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0),
  );
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  return rows;
}

export interface VerdictDecision {
  verdict: "winner" | "no-clear-winner";
  recommended: string | null;
  leader: string | null;
  reason?: NoClearWinnerReason;
}

/**
 * The verdict rule. The leader is the best-ranked eligible candidate (a
 * candidate with a failed check is ineligible unless every candidate failed
 * one). It is recommended only when all of these hold:
 *
 *   - `complete`: every juror returned a first-round verdict (not cancelled)
 *   - at least two votes were counted
 *   - Kendall's W ≥ `threshold`
 *   - the leader has strictly more Borda points than the next eligible
 *     candidate (a points tie is "no clear winner", whatever the tie-break)
 *
 * Reasons are reported in that order of precedence.
 */
export function decideVerdict(params: {
  ranking: readonly RankedCandidate[];
  kendallW: number | null;
  votes: number;
  threshold: number;
  complete: boolean;
}): VerdictDecision {
  const { ranking, kendallW: w, votes, threshold, complete } = params;
  const eligible = ranking.filter((r) => r.eligible);
  const leaderRow = votes > 0 ? eligible[0] : undefined;
  const leader = leaderRow?.candidateId ?? null;
  const noWinner = (reason: NoClearWinnerReason): VerdictDecision => ({
    verdict: "no-clear-winner",
    recommended: null,
    leader,
    reason,
  });
  if (!complete) return noWinner("incomplete");
  if (votes < 2 || w === null || !leaderRow) return noWinner("insufficient-votes");
  if (w < threshold) return noWinner("low-agreement");
  const runnerUp = eligible[1];
  if (runnerUp && runnerUp.points >= leaderRow.points) return noWinner("tie");
  return { verdict: "winner", recommended: leader, leader };
}

/** Jurors whose top pick differs from the leader. */
export function computeDissent(
  votes: readonly { jurorId: string; ranking: readonly string[] }[],
  leader: string | null,
): Array<{ jurorId: string; topPick: string }> {
  if (leader === null) return [];
  const out: Array<{ jurorId: string; topPick: string }> = [];
  for (const v of votes) {
    const top = v.ranking[0];
    if (top !== undefined && top !== leader) out.push({ jurorId: v.jurorId, topPick: top });
  }
  return out;
}
