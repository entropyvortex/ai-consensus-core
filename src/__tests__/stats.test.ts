import { describe, it, expect } from "vitest";
import {
  average,
  consensusScore,
  detectDisagreements,
  mulberry32,
  shuffle,
  stddev,
} from "../stats.js";
import { PERSONAS } from "../personas.js";
import type { Participant, ParticipantResponse } from "../types.js";

function makeResponse(
  overrides: Partial<ParticipantResponse> & {
    participantId: string;
    confidence: number;
  },
): ParticipantResponse {
  return {
    modelId: "m",
    personaId: "pessimist",
    round: 1,
    phase: "initial-analysis",
    content: `x\nCONFIDENCE: ${overrides.confidence}`,
    startedAt: 0,
    completedAt: 0,
    durationMs: 0,
    ...overrides,
  };
}

describe("average", () => {
  it("returns the arithmetic mean", () => {
    expect(average([10, 20, 30])).toBe(20);
  });

  it("returns 0 for an empty array (avoids NaN leaking into scores)", () => {
    expect(average([])).toBe(0);
  });

  it("handles a single element", () => {
    expect(average([42])).toBe(42);
  });

  it("handles floats", () => {
    expect(average([1.5, 2.5, 3.5])).toBeCloseTo(2.5);
  });
});

describe("stddev", () => {
  it("returns 0 when all values are identical", () => {
    expect(stddev([50, 50, 50, 50])).toBe(0);
  });

  it("matches the population-stddev formula for a known case", () => {
    // [1,2,3,4,5]: mean=3, population variance = 2, σ = √2
    expect(stddev([1, 2, 3, 4, 5])).toBeCloseTo(Math.SQRT2);
  });

  it("uses population N (not sample N-1)", () => {
    // [100, 0]: mean=50, pop variance=2500 → σ=50. Sample σ would be ~70.7.
    // We deliberately match the roundtable reference, which uses population σ
    // because the panel is the whole population, not a sample.
    expect(stddev([100, 0])).toBeCloseTo(50);
  });

  it("returns 0 for an empty array", () => {
    expect(stddev([])).toBe(0);
  });
});

describe("consensusScore", () => {
  it("returns the mean when all participants agree (σ=0)", () => {
    expect(consensusScore([80, 80, 80])).toBe(80);
  });

  it("penalises disagreement by 0.5·σ", () => {
    // avg=50, σ=50 → 50 - 25 = 25
    expect(consensusScore([100, 0])).toBe(25);
  });

  it("clamps the score to [0, 100]", () => {
    expect(consensusScore([100, 100])).toBe(100);
    expect(consensusScore([0, 0])).toBe(0);
  });

  it("rounds to an integer", () => {
    // avg=85, σ=5, score=82.5 → Math.round rounds half toward +∞ → 83
    const s = consensusScore([90, 80]);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBe(83);
  });

  it("returns 0 for an empty array (no data → no consensus)", () => {
    expect(consensusScore([])).toBe(0);
  });
});

describe("detectDisagreements", () => {
  const participants: Participant[] = [
    { id: "a", modelId: "m", persona: PERSONAS[0]! }, // Risk Analyst
    { id: "b", modelId: "m", persona: PERSONAS[1]! }, // First-Principles
    { id: "c", modelId: "m", persona: PERSONAS[6]! }, // Domain Expert
  ];

  it("flags pairs whose confidence delta is at or above the default threshold (20)", () => {
    const out = detectDisagreements({
      round: 2,
      participants,
      responses: [
        makeResponse({ participantId: "a", confidence: 90 }),
        makeResponse({ participantId: "b", confidence: 50 }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe(40);
    expect(out[0]!.label).toBe("Risk Analyst vs First-Principles Engineer");
    expect(out[0]!.id).toBe("r2-a-b");
  });

  it("ignores pairs below the threshold", () => {
    const out = detectDisagreements({
      round: 1,
      participants,
      responses: [
        makeResponse({ participantId: "a", confidence: 80 }),
        makeResponse({ participantId: "b", confidence: 65 }),
      ],
    });
    expect(out).toHaveLength(0);
  });

  it("treats a delta exactly equal to the threshold as a disagreement (≥20)", () => {
    // The implementation uses `delta < threshold ? continue` so delta === 20
    // IS flagged. This matches the spec wording "≥20 confidence difference".
    const out = detectDisagreements({
      round: 1,
      participants,
      responses: [
        makeResponse({ participantId: "a", confidence: 80 }),
        makeResponse({ participantId: "b", confidence: 60 }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe(20);
  });

  it("excludes errored responses entirely", () => {
    // A failed provider call contributes confidence=0 with error set. Those
    // should not generate spurious disagreements against working peers.
    const out = detectDisagreements({
      round: 1,
      participants,
      responses: [
        makeResponse({ participantId: "a", confidence: 90 }),
        makeResponse({ participantId: "b", confidence: 0, error: "provider 503" }),
      ],
    });
    expect(out).toHaveLength(0);
  });

  it("emits n·(n−1)/2 pairs when every pair diverges", () => {
    const out = detectDisagreements({
      round: 1,
      participants,
      responses: [
        makeResponse({ participantId: "a", confidence: 100 }),
        makeResponse({ participantId: "b", confidence: 50 }),
        makeResponse({ participantId: "c", confidence: 0 }),
      ],
    });
    expect(out).toHaveLength(3);
  });

  it("respects a custom threshold", () => {
    const out = detectDisagreements({
      round: 1,
      participants,
      threshold: 5,
      responses: [
        makeResponse({ participantId: "a", confidence: 80 }),
        makeResponse({ participantId: "b", confidence: 73 }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe(7);
  });

  it('falls back to the neutral "Confidence split" label when participants are not provided', () => {
    const out = detectDisagreements({
      round: 1,
      participants: [],
      responses: [
        makeResponse({ participantId: "x", confidence: 90 }),
        makeResponse({ participantId: "y", confidence: 50 }),
      ],
    });
    expect(out[0]!.label).toBe("Confidence split");
  });
});

describe("shuffle", () => {
  it("does not mutate the input array", () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    shuffle(input);
    expect(input).toEqual(snapshot);
  });

  it("returns a permutation of the input", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });

  it("is deterministic when given a seeded RNG", () => {
    const a = shuffle([1, 2, 3, 4, 5], mulberry32(42));
    const b = shuffle([1, 2, 3, 4, 5], mulberry32(42));
    expect(a).toEqual(b);
  });

  it("handles empty and single-element arrays without error", () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle([7])).toEqual([7]);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed across independent instances", () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    for (let i = 0; i < 50; i++) {
      expect(r1()).toBe(r2());
    }
  });

  it("produces values in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("advances independently for each instance", () => {
    // Two instances with the same seed should stay in lock-step when drawn
    // alternately, proving they don't share hidden state.
    const r1 = mulberry32(99);
    const r2 = mulberry32(99);
    r1(); // advance only r1
    expect(r1()).not.toBe(r2());
  });
});
