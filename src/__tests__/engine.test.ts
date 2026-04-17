import { describe, it, expect, vi } from "vitest";
import { ConsensusEngine } from "../engine.js";
import { PERSONAS } from "../personas.js";
import type {
  ConsensusOptions,
  ModelCallRequest,
  ModelCallResponse,
  ModelCaller,
  Participant,
} from "../types.js";

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

function P(id: string, personaIdx = 0): Participant {
  const persona = PERSONAS[personaIdx % PERSONAS.length]!;
  return { id, modelId: `model-${id}`, persona };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function judgeBody(confidence: number): string {
  return `## Majority Position
They broadly agree on the main thrust.

## Minority Positions
No material dissent worth preserving.

## Unresolved Disputes
- None of substance

## Synthesis Confidence
JUDGE_CONFIDENCE: ${confidence}`;
}

interface FixedCaller {
  caller: ModelCaller;
  calls: ModelCallRequest[];
}

/**
 * Builds a deterministic ModelCaller that emits a fixed sequence of
 * confidence values per participant id. Judge calls return a well-formed
 * synthesis body. The returned `calls` array is mutated in place as the
 * engine runs, so tests can inspect it after the await.
 */
function fixedCaller(
  confidences: Record<string, readonly number[]>,
  judgeConfidence = 85,
): FixedCaller {
  const counters = new Map<string, number>();
  const calls: ModelCallRequest[] = [];
  const caller: ModelCaller = async (req) => {
    calls.push(req);
    if (req.participantId === "judge") {
      return { content: judgeBody(judgeConfidence) };
    }
    const idx = counters.get(req.participantId) ?? 0;
    counters.set(req.participantId, idx + 1);
    const seq = confidences[req.participantId] ?? [75];
    const conf = seq[Math.min(idx, seq.length - 1)]!;
    return {
      content: `Response from ${req.participantId} (round ${req.round} / ${req.phase}).\nCONFIDENCE: ${conf}`,
    };
  };
  return { caller, calls };
}

const BASE_PARTICIPANTS: readonly Participant[] = [P("p1", 0), P("p2", 1), P("p3", 6)];

function baseOptions(
  overrides: Partial<ConsensusOptions> = {},
): ConsensusOptions {
  return {
    question: "Should an early-stage startup adopt microservices from day one?",
    participants: [...BASE_PARTICIPANTS],
    maxRounds: 4,
    blindFirstRound: true,
    randomizeOrder: false,
    earlyStop: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — validation", () => {
  const { caller } = fixedCaller({});

  it("rejects an empty question", async () => {
    const engine = new ConsensusEngine(caller);
    await expect(engine.run(baseOptions({ question: "" }))).rejects.toThrow(
      /non-empty string/,
    );
  });

  it("rejects a whitespace-only question", async () => {
    const engine = new ConsensusEngine(caller);
    await expect(engine.run(baseOptions({ question: "   \t\n" }))).rejects.toThrow(
      /non-empty string/,
    );
  });

  it("rejects runs with fewer than 2 participants", async () => {
    const engine = new ConsensusEngine(caller);
    await expect(
      engine.run(baseOptions({ participants: [P("only")] })),
    ).rejects.toThrow(/at least 2 participants/);
  });

  it("rejects duplicate participant ids", async () => {
    const engine = new ConsensusEngine(caller);
    await expect(
      engine.run(baseOptions({ participants: [P("dup"), P("dup")] })),
    ).rejects.toThrow(/duplicate participant id/);
  });

  it("clamps maxRounds > 10 down to 10", async () => {
    const { caller: c } = fixedCaller({ p1: [70], p2: [70] });
    const engine = new ConsensusEngine(c);
    const result = await engine.run(
      baseOptions({
        maxRounds: 999,
        participants: [P("p1"), P("p2")],
        earlyStop: false,
      }),
    );
    expect(result.rounds.length).toBe(10);
  });

  it("clamps maxRounds < 1 up to 1", async () => {
    const { caller: c } = fixedCaller({ p1: [70], p2: [70] });
    const engine = new ConsensusEngine(c);
    const result = await engine.run(
      baseOptions({ maxRounds: 0, participants: [P("p1"), P("p2")] }),
    );
    expect(result.rounds.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Full happy-path run
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — full run", () => {
  it("returns a ConsensusResult with every field populated", async () => {
    const { caller } = fixedCaller({
      p1: [70, 72, 74, 75],
      p2: [65, 68, 70, 72],
      p3: [75, 73, 73, 74],
    });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(baseOptions());

    expect(result.question).toContain("microservices");
    expect(result.participants).toHaveLength(3);
    expect(result.rounds).toHaveLength(4);
    expect(result.roundsCompleted).toBe(4);
    expect(result.stopReason).toBe("max-rounds");
    expect(result.finalScore).toBeGreaterThan(0);
    expect(result.finalScore).toBeLessThanOrEqual(100);
    expect(result.startedAt).toBeLessThanOrEqual(result.completedAt);
    expect(result.durationMs).toBe(result.completedAt - result.startedAt);
  });

  it("schedules the correct phase and label for each round", async () => {
    const { caller } = fixedCaller({ p1: [70, 70, 70, 70], p2: [70, 70, 70, 70] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")] }),
    );
    expect(result.rounds.map((r) => r.phase)).toEqual([
      "initial-analysis",
      "counterarguments",
      "evidence-assessment",
      "synthesis",
    ]);
    expect(result.rounds.map((r) => r.label)).toEqual([
      "Initial Analysis",
      "Counterarguments",
      "Evidence Assessment",
      "Final Synthesis",
    ]);
  });

  it("persists per-round stats (averageConfidence, stddev, score, disagreements)", async () => {
    const { caller } = fixedCaller({
      p1: [90, 85],
      p2: [60, 70],
    });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")], maxRounds: 2 }),
    );

    const r1 = result.rounds[0]!;
    expect(r1.averageConfidence).toBeCloseTo(75);
    expect(r1.stddev).toBeCloseTo(15);
    expect(r1.score).toBe(Math.round(75 - 0.5 * 15));
    expect(r1.disagreements.length).toBeGreaterThan(0);
  });

  it("is reusable — running twice on the same engine yields independent results", async () => {
    const { caller } = fixedCaller({ p1: [80, 80], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);
    const r1 = await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")], maxRounds: 2 }),
    );
    const r2 = await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")], maxRounds: 2 }),
    );
    expect(r1.roundsCompleted).toBe(2);
    expect(r2.roundsCompleted).toBe(2);
    expect(r1.rounds[0]!.score).toBe(r2.rounds[0]!.score);
  });
});

// ─────────────────────────────────────────────────────────────
// Blind first round
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — blind first round", () => {
  it("runs round 1 participants concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const caller: ModelCaller = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(15);
      concurrent--;
      return { content: `x\nCONFIDENCE: 70` };
    };
    const engine = new ConsensusEngine(caller);
    await engine.run(baseOptions({ maxRounds: 1 }));
    expect(maxConcurrent).toBe(3);
  });

  it("round 1 system prompts contain no previous-responses block (true blind)", async () => {
    const prompts: string[] = [];
    const caller: ModelCaller = async (req) => {
      if (req.round === 1) prompts.push(req.system);
      return { content: `x\nCONFIDENCE: 70` };
    };
    const engine = new ConsensusEngine(caller);
    await engine.run(baseOptions({ maxRounds: 1 }));
    expect(prompts).toHaveLength(3);
    for (const p of prompts) {
      expect(p).not.toContain("PREVIOUS ROUND RESPONSES");
    }
  });

  it("with blindFirstRound=false, round 1 runs sequentially", async () => {
    const events: string[] = [];
    const caller: ModelCaller = async (req) => {
      events.push(`start:${req.participantId}`);
      await sleep(5);
      events.push(`end:${req.participantId}`);
      return { content: `x\nCONFIDENCE: 70` };
    };
    const engine = new ConsensusEngine(caller);
    await engine.run(
      baseOptions({
        maxRounds: 1,
        blindFirstRound: false,
        randomizeOrder: false,
      }),
    );
    expect(events).toEqual([
      "start:p1",
      "end:p1",
      "start:p2",
      "end:p2",
      "start:p3",
      "end:p3",
    ]);
  });

  it("marks the RoundResult as blind for round 1 only", async () => {
    const { caller } = fixedCaller({ p1: [70, 70], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")], maxRounds: 2 }),
    );
    expect(result.rounds[0]!.blind).toBe(true);
    expect(result.rounds[1]!.blind).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Sequential rounds 2+
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — sequential rounds (2+)", () => {
  it("round 2 participants run one at a time (no overlap)", async () => {
    let concurrent = 0;
    let maxConcurrentRound2 = 0;
    const caller: ModelCaller = async (req) => {
      if (req.round === 2) {
        concurrent++;
        maxConcurrentRound2 = Math.max(maxConcurrentRound2, concurrent);
      }
      await sleep(5);
      if (req.round === 2) concurrent--;
      return { content: `x\nCONFIDENCE: 70` };
    };
    const engine = new ConsensusEngine(caller);
    await engine.run(baseOptions({ maxRounds: 2 }));
    expect(maxConcurrentRound2).toBe(1);
  });

  it("later speakers in a round see earlier speakers' content from the same round", async () => {
    const promptsByParticipant = new Map<string, string>();
    // Tag content with round so we can distinguish r1-body-p2 (visible to all
    // in round 2) from r2-body-p2 (only visible to speakers AFTER p2).
    const caller: ModelCaller = async (req) => {
      if (req.round === 2) promptsByParticipant.set(req.participantId, req.system);
      return { content: `r${req.round}-body-${req.participantId}\nCONFIDENCE: 70` };
    };
    const engine = new ConsensusEngine(caller);
    await engine.run(baseOptions({ maxRounds: 2, randomizeOrder: false }));

    // With randomizeOrder=false the order is p1, p2, p3:
    //   p1 in round 2 sees ONLY round-1 responses (r1-body-*)
    //   p2 in round 2 additionally sees p1's round-2 response (r2-body-p1)
    //   p3 in round 2 additionally sees p1 and p2's round-2 responses

    // Everyone sees the full round-1 transcript
    for (const pid of ["p1", "p2", "p3"]) {
      expect(promptsByParticipant.get(pid)).toContain("r1-body-p1");
      expect(promptsByParticipant.get(pid)).toContain("r1-body-p2");
      expect(promptsByParticipant.get(pid)).toContain("r1-body-p3");
    }
    // But only later speakers see earlier round-2 responses
    expect(promptsByParticipant.get("p1")).not.toContain("r2-body-");
    expect(promptsByParticipant.get("p2")).toContain("r2-body-p1");
    expect(promptsByParticipant.get("p2")).not.toContain("r2-body-p2");
    expect(promptsByParticipant.get("p2")).not.toContain("r2-body-p3");
    expect(promptsByParticipant.get("p3")).toContain("r2-body-p1");
    expect(promptsByParticipant.get("p3")).toContain("r2-body-p2");
    expect(promptsByParticipant.get("p3")).not.toContain("r2-body-p3");
  });
});

// ─────────────────────────────────────────────────────────────
// Early stopping / convergence
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — early stopping", () => {
  it("stops when |Δscore| ≤ convergenceDelta between two rounds", async () => {
    // Flat confidences → rounds 1 and 2 produce identical scores → Δ=0 ≤ 3
    const { caller } = fixedCaller({
      p1: [70, 70, 70, 70],
      p2: [70, 70, 70, 70],
      p3: [70, 70, 70, 70],
    });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({ earlyStop: true, convergenceDelta: 3 }),
    );
    expect(result.stopReason).toBe("converged");
    expect(result.earlyStop?.round).toBe(2);
    expect(result.roundsCompleted).toBe(2);
  });

  it("does not stop early while scores are still moving", async () => {
    const { caller } = fixedCaller({
      p1: [50, 70, 90, 100],
      p2: [55, 75, 95, 100],
      p3: [45, 65, 85, 100],
    });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({ earlyStop: true, convergenceDelta: 3 }),
    );
    expect(result.stopReason).toBe("max-rounds");
    expect(result.roundsCompleted).toBe(4);
  });

  it("never checks convergence on round 1 (needs two rounds to compare)", async () => {
    const stops: unknown[] = [];
    const { caller } = fixedCaller({ p1: [70], p2: [70] });
    const engine = new ConsensusEngine(caller);
    engine.on("earlyStop", (e) => stops.push(e));
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
        earlyStop: true,
        convergenceDelta: 999,
      }),
    );
    expect(stops).toEqual([]);
  });

  it("never checks convergence on the final round (no successor)", async () => {
    // With maxRounds=2 and a flat delta, we'd normally converge. But the
    // check is skipped on the final round, so stopReason stays "max-rounds".
    const { caller } = fixedCaller({ p1: [70, 70], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 2,
        earlyStop: true,
        convergenceDelta: 3,
      }),
    );
    expect(result.stopReason).toBe("max-rounds");
    expect(result.roundsCompleted).toBe(2);
  });

  it("earlyStop: false keeps running even when scores are identical", async () => {
    const { caller } = fixedCaller({ p1: [70, 70, 70, 70], p2: [70, 70, 70, 70] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")], earlyStop: false }),
    );
    expect(result.roundsCompleted).toBe(4);
  });

  it("populates earlyStop metadata on convergence", async () => {
    const { caller } = fixedCaller({ p1: [70, 70, 70, 70], p2: [70, 70, 70, 70] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        earlyStop: true,
        convergenceDelta: 3,
      }),
    );
    expect(result.earlyStop).toBeDefined();
    expect(result.earlyStop?.round).toBe(2);
    expect(result.earlyStop?.delta).toBeLessThanOrEqual(3);
    expect(result.earlyStop?.reason).toMatch(/convergence threshold/i);
  });
});

// ─────────────────────────────────────────────────────────────
// Judge synthesis
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — judge synthesis", () => {
  it("invokes the judge after the final round with participantId 'judge'", async () => {
    const { caller, calls } = fixedCaller({ p1: [70, 70], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 2,
        judge: { modelId: "judge-model" },
      }),
    );
    const judgeCalls = calls.filter((c) => c.participantId === "judge");
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]!.modelId).toBe("judge-model");
    expect(judgeCalls[0]!.phase).toBe("synthesis");
  });

  it("parses the four judge sections and the JUDGE_CONFIDENCE marker", async () => {
    const { caller } = fixedCaller({ p1: [70, 70], p2: [70, 70] }, 91);
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 2,
        judge: { modelId: "judge-model" },
      }),
    );
    expect(result.synthesis).toBeDefined();
    expect(result.synthesis!.judgeConfidence).toBe(91);
    expect(result.synthesis!.majorityPosition).toContain("broadly agree");
    expect(result.synthesis!.minorityPositions).toContain("No material dissent");
    expect(result.synthesis!.unresolvedDisputes).toContain("None");
  });

  it("does not run the judge when no judge option is provided", async () => {
    const { caller, calls } = fixedCaller({ p1: [70, 70], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")], maxRounds: 2 }),
    );
    expect(result.synthesis).toBeUndefined();
    expect(calls.find((c) => c.participantId === "judge")).toBeUndefined();
  });

  it("uses a separate judge caller when provided", async () => {
    const { caller: participantCaller, calls: pCalls } = fixedCaller({
      p1: [70, 70],
      p2: [70, 70],
    });
    const judgeCaller = vi.fn<(req: ModelCallRequest) => Promise<ModelCallResponse>>(
      async () => ({ content: judgeBody(77) }),
    );
    const engine = new ConsensusEngine(participantCaller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 2,
        judge: { modelId: "other-judge", caller: judgeCaller },
      }),
    );
    expect(judgeCaller).toHaveBeenCalledTimes(1);
    expect(result.synthesis?.modelId).toBe("other-judge");
    expect(result.synthesis?.judgeConfidence).toBe(77);
    // Main caller should NOT have been asked to do the judge work.
    expect(pCalls.find((c) => c.participantId === "judge")).toBeUndefined();
  });

  it("fires synthesisStart then synthesisComplete", async () => {
    const order: string[] = [];
    const { caller } = fixedCaller({ p1: [70, 70], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);
    engine.on("synthesisStart", () => order.push("start"));
    engine.on("synthesisComplete", () => order.push("complete"));
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 2,
        judge: { modelId: "j" },
      }),
    );
    expect(order).toEqual(["start", "complete"]);
  });
});

// ─────────────────────────────────────────────────────────────
// Disagreement detection
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — disagreement detection", () => {
  it("emits disagreementDetected for each pair above the default threshold", async () => {
    const events: Array<{ pair: string; delta: number }> = [];
    const { caller } = fixedCaller({
      p1: [90, 90],
      p2: [30, 30],
      p3: [70, 70],
    });
    const engine = new ConsensusEngine(caller);
    engine.on("disagreementDetected", (e) => {
      events.push({ pair: e.disagreement.label, delta: e.disagreement.severity });
    });
    await engine.run(baseOptions({ maxRounds: 1 }));

    // Pairs: 90-30=60, 90-70=20, 30-70=40 → all three ≥ 20
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.delta).sort((a, b) => a - b)).toEqual([20, 40, 60]);
  });

  it("respects a custom disagreementThreshold", async () => {
    const counts: number[] = [];
    const { caller } = fixedCaller({ p1: [90], p2: [85], p3: [80] });
    const engine = new ConsensusEngine(caller);
    engine.on("disagreementDetected", () => counts.push(1));
    await engine.run(
      baseOptions({
        maxRounds: 1,
        disagreementThreshold: 3,
      }),
    );
    expect(counts.length).toBeGreaterThan(0);
  });

  it("populates RoundResult.disagreements with stable ids", async () => {
    const { caller } = fixedCaller({ p1: [90], p2: [30], p3: [70] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(baseOptions({ maxRounds: 1 }));
    const ids = result.rounds[0]!.disagreements.map((d) => d.id);
    expect(ids.every((id) => id.startsWith("r1-"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("emits no disagreementDetected events when everyone agrees", async () => {
    const { caller } = fixedCaller({ p1: [80, 80], p2: [80, 80], p3: [80, 80] });
    const engine = new ConsensusEngine(caller);
    const events: unknown[] = [];
    engine.on("disagreementDetected", (e) => events.push(e));
    await engine.run(baseOptions({ maxRounds: 2 }));
    expect(events).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — events", () => {
  it("fires events in the expected order for a happy-path round", async () => {
    const log: string[] = [];
    const { caller } = fixedCaller({ p1: [70, 70], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);

    engine.on("roundStart", (e) => log.push(`roundStart:${e.round}`));
    engine.on("participantStart", (e) =>
      log.push(`participantStart:${e.round}:${e.participantId}`),
    );
    engine.on("participantComplete", (e) =>
      log.push(`participantComplete:${e.round}:${e.response.participantId}`),
    );
    engine.on("confidenceUpdate", (e) =>
      log.push(`confidenceUpdate:${e.round}:${e.participantId}`),
    );
    engine.on("roundComplete", (e) => log.push(`roundComplete:${e.round}`));
    engine.on("finalResult", () => log.push("finalResult"));

    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
      }),
    );

    expect(log[0]).toBe("roundStart:1");
    expect(log[log.length - 1]).toBe("finalResult");
    expect(log.filter((x) => x === "roundComplete:1")).toHaveLength(1);
    expect(log.filter((x) => x === "finalResult")).toHaveLength(1);

    for (const id of ["p1", "p2"]) {
      const startIdx = log.indexOf(`participantStart:1:${id}`);
      const endIdx = log.indexOf(`participantComplete:1:${id}`);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
    }
  });

  it("fires finalResult exactly once per run", async () => {
    const { caller } = fixedCaller({ p1: [70, 70], p2: [70, 70] });
    const engine = new ConsensusEngine(caller);
    const spy = vi.fn();
    engine.on("finalResult", spy);
    await engine.run(
      baseOptions({ participants: [P("p1"), P("p2")], maxRounds: 2 }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("confidenceUpdate.runningAverage reflects sequential arrivals", async () => {
    const { caller } = fixedCaller({ p1: [80], p2: [60], p3: [90] });
    const engine = new ConsensusEngine(caller);
    const updates: Array<{ id: string; avg: number }> = [];
    engine.on("confidenceUpdate", (e) => {
      updates.push({ id: e.participantId, avg: e.runningAverage });
    });
    await engine.run(
      baseOptions({
        maxRounds: 1,
        blindFirstRound: false,
        randomizeOrder: false,
      }),
    );
    // Sequential order: p1 (80), p2 (60), p3 (90)
    // Running averages: 80, 70, (80+60+90)/3 = 76.67
    expect(updates.map((u) => u.id)).toEqual(["p1", "p2", "p3"]);
    expect(updates[0]!.avg).toBeCloseTo(80);
    expect(updates[1]!.avg).toBeCloseTo(70);
    expect(updates[2]!.avg).toBeCloseTo(76.666, 1);
  });

  it("forwards streamed tokens via participantToken when the caller streams", async () => {
    const tokens: string[] = [];
    const caller: ModelCaller = async (req) => {
      req.onToken?.("Hello ");
      req.onToken?.("world.");
      return { content: "Hello world.\nCONFIDENCE: 80" };
    };
    const engine = new ConsensusEngine(caller);
    engine.on("participantToken", (e) => tokens.push(e.token));
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
      }),
    );
    // Two participants × two tokens each
    expect(tokens).toHaveLength(4);
    expect(tokens.every((t) => t === "Hello " || t === "world.")).toBe(true);
  });

  it("emits participantToken in order from a single participant", async () => {
    const tokens: string[] = [];
    const caller: ModelCaller = async (req) => {
      for (const t of ["one ", "two ", "three"]) req.onToken?.(t);
      return { content: "one two three\nCONFIDENCE: 80" };
    };
    const engine = new ConsensusEngine(caller);
    engine.on("participantToken", (e) => {
      if (e.participantId === "p1") tokens.push(e.token);
    });
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
        blindFirstRound: false,
        randomizeOrder: false,
      }),
    );
    expect(tokens).toEqual(["one ", "two ", "three"]);
  });
});

// ─────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — cancellation", () => {
  it("returns a clean aborted result when the signal is pre-aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { caller } = fixedCaller({ p1: [80], p2: [80] });
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        signal: ac.signal,
      }),
    );
    expect(result.stopReason).toBe("aborted");
    expect(result.roundsCompleted).toBe(0);
  });

  it("returns an aborted result when the signal fires mid-run", async () => {
    const ac = new AbortController();
    const caller: ModelCaller = (req) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(
          () => resolve({ content: "x\nCONFIDENCE: 70" }),
          80,
        );
        req.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    const engine = new ConsensusEngine(caller);

    setTimeout(() => ac.abort(), 15);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 3,
        signal: ac.signal,
      }),
    );
    expect(result.stopReason).toBe("aborted");
  });

  it("still emits finalResult on abort (so observers can clean up)", async () => {
    const ac = new AbortController();
    ac.abort();
    const { caller } = fixedCaller({ p1: [80], p2: [80] });
    const engine = new ConsensusEngine(caller);
    const spy = vi.fn();
    engine.on("finalResult", spy);
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        signal: ac.signal,
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("propagates the signal into the ModelCaller via req.signal", async () => {
    const seen = vi.fn();
    const ac = new AbortController();
    const caller: ModelCaller = async (req) => {
      seen(req.signal);
      return { content: "x\nCONFIDENCE: 70" };
    };
    const engine = new ConsensusEngine(caller);
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
        signal: ac.signal,
      }),
    );
    // Every ModelCaller call should have received the same AbortSignal.
    expect(seen).toHaveBeenCalled();
    for (const call of seen.mock.calls) {
      expect(call[0]).toBe(ac.signal);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Error handling (partial failures)
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — error handling", () => {
  it("one failing ModelCaller does not crash the run", async () => {
    const caller: ModelCaller = async (req) => {
      if (req.participantId === "p2") throw new Error("provider meltdown");
      return { content: "x\nCONFIDENCE: 80" };
    };
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2"), P("p3")],
        maxRounds: 2,
      }),
    );
    expect(result.stopReason).toBe("max-rounds");
    expect(result.roundsCompleted).toBe(2);
  });

  it("errored responses are captured with error message and confidence 0", async () => {
    const caller: ModelCaller = async (req) => {
      if (req.participantId === "p2") throw new Error("boom");
      return { content: "x\nCONFIDENCE: 80" };
    };
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
      }),
    );
    const p2 = result.rounds[0]!.responses.find(
      (r) => r.participantId === "p2",
    );
    expect(p2?.error).toContain("boom");
    expect(p2?.confidence).toBe(0);
  });

  it("errored responses are excluded from the consensus score", async () => {
    const caller: ModelCaller = async (req) => {
      if (req.participantId === "p2") throw new Error("boom");
      return { content: "x\nCONFIDENCE: 80" };
    };
    const engine = new ConsensusEngine(caller);
    const result = await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
      }),
    );
    // Only p1 counts. Score should be ~80, not the ~40 avg of 80 and 0.
    expect(result.finalScore).toBe(80);
  });

  it("errored responses are excluded from disagreement detection", async () => {
    const caller: ModelCaller = async (req) => {
      if (req.participantId === "p2") throw new Error("boom");
      return { content: "x\nCONFIDENCE: 90" };
    };
    const engine = new ConsensusEngine(caller);
    let disagreements = 0;
    engine.on("disagreementDetected", () => disagreements++);
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
      }),
    );
    expect(disagreements).toBe(0);
  });

  it("errored participants still fire participantComplete (observers need it)", async () => {
    const completed: string[] = [];
    const caller: ModelCaller = async (req) => {
      if (req.participantId === "p2") throw new Error("boom");
      return { content: "x\nCONFIDENCE: 80" };
    };
    const engine = new ConsensusEngine(caller);
    engine.on("participantComplete", (e) => completed.push(e.response.participantId));
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
      }),
    );
    expect(completed).toContain("p1");
    expect(completed).toContain("p2");
  });

  it("does not fire confidenceUpdate for errored responses", async () => {
    const updates: string[] = [];
    const caller: ModelCaller = async (req) => {
      if (req.participantId === "p2") throw new Error("boom");
      return { content: "x\nCONFIDENCE: 80" };
    };
    const engine = new ConsensusEngine(caller);
    engine.on("confidenceUpdate", (e) => updates.push(e.participantId));
    await engine.run(
      baseOptions({
        participants: [P("p1"), P("p2")],
        maxRounds: 1,
      }),
    );
    // confidenceUpdate only fires for successful confidence parses.
    expect(updates).toContain("p1");
    expect(updates).not.toContain("p2");
  });
});

// ─────────────────────────────────────────────────────────────
// Deterministic replay
// ─────────────────────────────────────────────────────────────

describe("ConsensusEngine — deterministic replay", () => {
  async function captureRound2Order(seed: number): Promise<string[]> {
    const order: string[] = [];
    const caller: ModelCaller = async (req) => {
      if (req.round === 2) order.push(req.participantId);
      return { content: "x\nCONFIDENCE: 70" };
    };
    const engine = new ConsensusEngine(caller);
    await engine.run({
      question: "q",
      participants: [P("p1"), P("p2"), P("p3"), P("p4", 3)],
      maxRounds: 2,
      blindFirstRound: true,
      randomizeOrder: true,
      earlyStop: false,
      randomSeed: seed,
    });
    return order;
  }

  it("same randomSeed yields the same speaking order on rounds 2+", async () => {
    const a = await captureRound2Order(12345);
    const b = await captureRound2Order(12345);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
  });

  it("different seeds generally produce different orders", async () => {
    // With 4! = 24 possible orderings, four distinct seeds are
    // overwhelmingly likely to produce ≥ 2 distinct orders. If this ever
    // fails reliably, the seeded PRNG has regressed.
    const orders = await Promise.all(
      [1, 2, 3, 7].map((s) => captureRound2Order(s)),
    );
    const unique = new Set(orders.map((o) => o.join(",")));
    expect(unique.size).toBeGreaterThan(1);
  });
});
