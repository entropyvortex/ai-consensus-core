// ─────────────────────────────────────────────────────────────
// Stats — averages, standard deviation, consensus score,
// disagreement detection.
// ─────────────────────────────────────────────────────────────

import type { Disagreement, Participant, ParticipantResponse } from "./types.js";

/** Arithmetic mean. Returns 0 for empty input. */
export function average(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * Population standard deviation (divides by N, not N-1).
 *
 * We use population stddev rather than sample stddev to stay aligned with
 * the roundtable reference implementation. The participant count is the
 * entire panel, not a sample from a larger distribution.
 */
export function stddev(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const mean = average(xs);
  let varSum = 0;
  for (const x of xs) {
    const d = x - mean;
    varSum += d * d;
  }
  return Math.sqrt(varSum / xs.length);
}

/**
 * Consensus score: `round(clamp(avg − 0.5·stddev, 0, 100))`.
 *
 * Penalizes disagreement (high stddev) against the pack's confidence.
 * Integer-rounded so early-stop deltas are stable.
 */
export function consensusScore(confidences: readonly number[]): number {
  if (confidences.length === 0) return 0;
  const avg = average(confidences);
  const sd = stddev(confidences);
  return Math.round(Math.max(0, Math.min(100, avg - sd * 0.5)));
}

/**
 * Pairwise disagreement detection. Any two non-errored responses whose
 * confidence differs by at least `threshold` (default 20) generates a
 * Disagreement entry. Deterministic (no text-based heuristic, no extra
 * LLM calls).
 */
export function detectDisagreements(params: {
  round: number;
  responses: readonly ParticipantResponse[];
  participants: readonly Participant[];
  threshold?: number;
}): Disagreement[] {
  const { round, responses, participants } = params;
  const threshold = params.threshold ?? 20;
  const out: Disagreement[] = [];
  for (let i = 0; i < responses.length; i++) {
    for (let j = i + 1; j < responses.length; j++) {
      const a = responses[i]!;
      const b = responses[j]!;
      if (a.error || b.error) continue;
      const delta = Math.abs(a.confidence - b.confidence);
      if (delta < threshold) continue;
      const pa = participants.find((p) => p.id === a.participantId);
      const pb = participants.find((p) => p.id === b.participantId);
      const label =
        pa && pb ? `${pa.persona.name} vs ${pb.persona.name}` : "Confidence split";
      out.push({
        id: `r${round}-${a.participantId}-${b.participantId}`,
        round,
        participantAId: a.participantId,
        participantBId: b.participantId,
        severity: delta,
        label,
      });
    }
  }
  return out;
}

/**
 * Fisher–Yates shuffle. Pure (returns a new array) and takes an injectable
 * RNG so callers can seed it for deterministic replay.
 */
export function shuffle<T>(input: readonly T[], rng: () => number = Math.random): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Small, allocation-free mulberry32 PRNG. Used only when the caller
 * passes `randomSeed` for deterministic runs — otherwise we use
 * `Math.random`. Not cryptographically secure; we don't need it to be.
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
