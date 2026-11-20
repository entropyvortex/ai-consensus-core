import { describe, it, expect } from "vitest";
import { AdjudicationEngine } from "../adjudication.js";
import {
  CANDIDATES,
  J,
  JUDGE_BODY,
  TAG_OF,
  labelFor,
  presentedIn,
  scriptedCaller,
  type JurorScript,
} from "./_adjudication-fixtures.js";
import type {
  AdjudicationCandidate,
  AdjudicationEventName,
  AdjudicationOptions,
  AdjudicationResult,
} from "../types.js";

const TASK = "Implement sum(a, b) in src/sum.ts";
const CLAUDE = "refs/heads/attempt-claude"; // content tag ALPHA
const CODEX = "refs/heads/attempt-codex"; // BETA
const GROK = "refs/heads/attempt-grok"; // GAMMA

function opts(overrides: Partial<AdjudicationOptions> = {}): AdjudicationOptions {
  return {
    task: TASK,
    candidates: CANDIDATES,
    jurors: [J("j1", 0), J("j2", 1), J("j3", 2)],
    randomSeed: 7,
    ...overrides,
  };
}

function same(prefer: string[], n = 3): Record<string, JurorScript> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`j${i + 1}`, { prefer }]));
}

function jurorCalls<T extends { participantId: string; phase: string }>(
  calls: T[],
  phase = "initial-analysis",
): T[] {
  return calls.filter((c) => c.participantId !== "judge" && c.phase === phase);
}

function stripTimes(r: AdjudicationResult): unknown {
  return JSON.parse(
    JSON.stringify(r, (k, v: unknown) =>
      ["startedAt", "completedAt", "durationMs"].includes(k) ? 0 : v,
    ),
  );
}

// ─────────────────────────────────────────────────────────────

describe("AdjudicationEngine — blinding and label mapping", () => {
  it("never shows a candidate id to any model, jurors or judge", async () => {
    const { caller, calls } = scriptedCaller(same(["ALPHA", "GAMMA", "BETA"]));
    await new AdjudicationEngine(caller).adjudicate(opts({ judge: { modelId: "judge-model" } }));
    expect(calls.length).toBe(4);
    for (const call of calls) {
      for (const c of CANDIDATES) {
        expect(call.system).not.toContain(c.id);
        expect(call.user).not.toContain(c.id);
      }
      expect(`${call.system}${call.user}`).not.toMatch(/attempt-|claude|codex|grok/i);
    }
  });

  it("shows each juror labels A, B, C in a per-juror shuffled order", async () => {
    const { caller, calls } = scriptedCaller(same(["ALPHA", "GAMMA", "BETA"]));
    const result = await new AdjudicationEngine(caller).adjudicate(opts());
    const orders = jurorCalls(calls).map((c) => {
      const shown = presentedIn(c.user);
      expect(shown.map((p) => p.label)).toEqual(["A", "B", "C"]);
      return shown.map((p) => /ALPHA|BETA|GAMMA/.exec(p.content)![0]).join(",");
    });
    expect(new Set(orders).size).toBeGreaterThan(1);
    // The recorded presentation matches what the juror was shown.
    for (const v of result.rounds[0]!.verdicts) {
      const call = calls.find((c) => c.participantId === v.jurorId)!;
      for (const { label, candidateId } of v.presentation) {
        expect(labelFor(call.user, TAG_OF[candidateId]!)).toBe(label);
      }
    }
  });

  it("maps every juror's labels back to the right candidate ids", async () => {
    const { caller } = scriptedCaller(same(["GAMMA", "ALPHA", "BETA"]));
    const result = await new AdjudicationEngine(caller).adjudicate(opts());
    for (const v of result.rounds[0]!.verdicts) expect(v.ranking).toEqual([GROK, CLAUDE, CODEX]);
    expect(result.ranking.map((r) => r.candidateId)).toEqual([GROK, CLAUDE, CODEX]);
    expect(result.ranking.map((r) => r.points)).toEqual([6, 3, 0]);
    expect(result.recommended).toBe(GROK);
    expect(result.verdict).toBe("winner");
    expect(result.agreement).toEqual({ kendallW: 1, threshold: 0.3, votes: 3 });
    expect(result.candidates.map((c) => [c.id, c.label])).toEqual([
      [CLAUDE, "A"],
      [CODEX, "B"],
      [GROK, "C"],
    ]);
  });

  it("is deterministic for a seed: same presentations, same result", async () => {
    const run = async (seed: number) => {
      const { caller, calls } = scriptedCaller(same(["ALPHA", "BETA", "GAMMA"]));
      const result = await new AdjudicationEngine(caller).adjudicate(opts({ randomSeed: seed }));
      return { result, users: jurorCalls(calls).map((c) => c.user) };
    };
    const a = await run(11);
    const b = await run(11);
    const c = await run(12);
    expect(b.users).toEqual(a.users);
    expect(stripTimes(b.result)).toEqual(stripTimes(a.result));
    expect(c.users).not.toEqual(a.users);
  });
});

describe("AdjudicationEngine — abstentions", () => {
  it("counts malformed output and caller errors as abstentions, never a crash", async () => {
    const { caller } = scriptedCaller({
      j1: { raw: "I prefer the first one." },
      j2: { throws: "upstream 500" },
      j3: { prefer: ["ALPHA", "BETA", "GAMMA"] },
      j4: { prefer: ["ALPHA", "GAMMA", "BETA"] },
    });
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ jurors: [J("j1"), J("j2"), J("j3"), J("j4")] }),
    );
    const byId = Object.fromEntries(result.rounds[0]!.verdicts.map((v) => [v.jurorId, v]));
    expect(byId["j1"]!.status).toBe("abstained");
    expect(byId["j1"]!.abstainReason).toMatch(/not a single JSON object/);
    expect(byId["j1"]!.raw).toBe("I prefer the first one.");
    expect(byId["j2"]!.status).toBe("abstained");
    expect(byId["j2"]!.abstainReason).toBe("caller error: upstream 500");
    expect(byId["j3"]!.status).toBe("valid");
    expect(result.agreement.votes).toBe(2);
    expect(result.recommended).toBe(CLAUDE);
  });

  it("returns no clear winner (insufficient votes) and skips the judge when nobody votes", async () => {
    const { caller, calls } = scriptedCaller({
      j1: { raw: "{}" },
      j2: { raw: "{}" },
      j3: { raw: "{}" },
    });
    const result = await new AdjudicationEngine(caller).adjudicate(opts({ judge: { modelId: "jm" } }));
    expect(result.verdict).toBe("no-clear-winner");
    expect(result.noClearWinnerReason).toBe("insufficient-votes");
    expect(result.leader).toBeNull();
    expect(result.synthesis).toBeUndefined();
    expect(calls.some((c) => c.participantId === "judge")).toBe(false);
  });
});

describe("AdjudicationEngine — quote verification", () => {
  it("keeps findings whose quote is in the named candidate and reports the dropped count", async () => {
    const real = "return a - b; // BETA";
    const { caller } = scriptedCaller({
      j1: {
        prefer: ["ALPHA", "GAMMA", "BETA"],
        findings: [
          { tag: "BETA", quote: real },
          { tag: "BETA", quote: "return a * b; // made up" },
          { tag: "BETA", quote: "export const zero = 0;" }, // real, but from ALPHA
        ],
      },
      j2: { prefer: ["ALPHA", "GAMMA", "BETA"], findings: [{ tag: "BETA", quote: `  ${real}`, severity: "medium" }] },
      j3: { prefer: ["ALPHA", "GAMMA", "BETA"] },
    });
    const result = await new AdjudicationEngine(caller).adjudicate(opts());
    const codex = result.findings.find((f) => f.candidateId === CODEX)!;
    expect(codex.verified).toHaveLength(1);
    expect(codex.verified[0]).toMatchObject({ quote: real, severity: "high", reportedBy: ["j1", "j2"] });
    expect(codex.dropped).toBe(2);
    expect(result.droppedFindings).toBe(2);
    const j1 = result.rounds[0]!.verdicts.find((v) => v.jurorId === "j1")!;
    expect(j1.verifiedFindings).toHaveLength(1);
    expect(j1.droppedFindings).toHaveLength(2);
    expect(result.ranking.find((r) => r.candidateId === CODEX)!.findingWeight).toBe(3);
  });
});

describe("AdjudicationEngine — verdict rules", () => {
  it("reports a Borda tie at the top as no clear winner even with high agreement", async () => {
    const { caller } = scriptedCaller({
      j1: { prefer: ["ALPHA", "BETA", "GAMMA"] },
      j2: { prefer: ["BETA", "ALPHA", "GAMMA"] },
    });
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ jurors: [J("j1"), J("j2")] }),
    );
    expect(result.agreement.kendallW).toBeCloseTo(0.75, 10);
    expect(result.verdict).toBe("no-clear-winner");
    expect(result.noClearWinnerReason).toBe("tie");
    expect(result.rounds).toHaveLength(1); // W ≥ threshold: no rebuttal
  });

  it("does not recommend a candidate with a failed check while another has none", async () => {
    const candidates: AdjudicationCandidate[] = CANDIDATES.map((c) =>
      c.id === CLAUDE ? { ...c, checks: [{ name: "tests", status: "failed", output: "1 failing" }] } : c,
    );
    const { caller, calls } = scriptedCaller(same(["ALPHA", "GAMMA", "BETA"]));
    const result = await new AdjudicationEngine(caller).adjudicate(opts({ candidates }));
    expect(result.ranking[0]).toMatchObject({ candidateId: CLAUDE, eligible: false, failedChecks: ["tests"] });
    expect(result.recommended).toBe(GROK);
    expect(result.leader).toBe(GROK);
    expect(result.candidates[0]!.checks).toEqual([{ name: "tests", status: "failed", output: "1 failing" }]);
    // Jurors saw the check.
    expect(jurorCalls(calls)[0]!.user).toContain("1 failing");
  });

  it("recommends the top candidate when every candidate failed a check", async () => {
    const candidates = CANDIDATES.map((c) => ({ ...c, checks: [{ name: "lint", status: "failed" as const }] }));
    const { caller } = scriptedCaller(same(["ALPHA", "GAMMA", "BETA"]));
    const result = await new AdjudicationEngine(caller).adjudicate(opts({ candidates }));
    expect(result.recommended).toBe(CLAUDE);
  });

  it("lists dissenting jurors against the leader", async () => {
    const { caller } = scriptedCaller({
      j1: { prefer: ["ALPHA", "BETA", "GAMMA"] },
      j2: { prefer: ["ALPHA", "GAMMA", "BETA"] },
      j3: { prefer: ["GAMMA", "ALPHA", "BETA"] },
    });
    const result = await new AdjudicationEngine(caller).adjudicate(opts({ maxRounds: 1 }));
    expect(result.leader).toBe(CLAUDE);
    expect(result.dissent).toEqual([{ jurorId: "j3", topPick: GROK }]);
  });
});

describe("AdjudicationEngine — rebuttal round", () => {
  const split: Record<string, JurorScript> = {
    j1: { prefer: ["ALPHA", "BETA", "GAMMA"], rebuttal: { prefer: ["ALPHA", "BETA", "GAMMA"] } },
    j2: { prefer: ["GAMMA", "BETA", "ALPHA"], rebuttal: { prefer: ["ALPHA", "BETA", "GAMMA"] } },
  };

  it("runs a rebuttal when agreement is below the threshold and uses the new rankings", async () => {
    const { caller, calls } = scriptedCaller(split);
    const engine = new AdjudicationEngine(caller);
    const triggered: number[] = [];
    engine.on("rebuttalTriggered", (e) => triggered.push(e.kendallW));
    const result = await engine.adjudicate(opts({ jurors: [J("j1"), J("j2")] }));
    expect(triggered).toEqual([0]);
    expect(result.rounds.map((r) => [r.kind, r.agreement.kendallW])).toEqual([
      ["blind", 0],
      ["rebuttal", 1],
    ]);
    expect(result.recommended).toBe(CLAUDE);
    const reb = jurorCalls(calls, "counterarguments");
    expect(reb).toHaveLength(2);
    // j1 sees j2's round-1 ranking translated into j1's own labels.
    const j1 = reb.find((c) => c.participantId === "j1")!;
    const translated = ["GAMMA", "BETA", "ALPHA"].map((t) => labelFor(j1.user, t)).join(" > ");
    expect(j1.user).toContain(`OTHER JURORS (anonymous; labels translated to yours):\n--- Juror 1 ---\nRanking: ${translated}`);
    const own = ["ALPHA", "BETA", "GAMMA"].map((t) => labelFor(j1.user, t)).join(" > ");
    expect(j1.user).toContain(`YOUR PREVIOUS VERDICT:\nRanking: ${own}`);
    expect(j1.system).toContain("REBUTTAL round");
  });

  it("does not run a rebuttal with maxRounds 1, and reports low agreement", async () => {
    const { caller, calls } = scriptedCaller(split);
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ jurors: [J("j1"), J("j2")], maxRounds: 1 }),
    );
    expect(jurorCalls(calls, "counterarguments")).toHaveLength(0);
    expect(result.noClearWinnerReason).toBe("low-agreement");
  });

  it("does not run a rebuttal when agreement already meets the threshold", async () => {
    const { caller, calls } = scriptedCaller(same(["ALPHA", "BETA", "GAMMA"]));
    await new AdjudicationEngine(caller).adjudicate(opts());
    expect(jurorCalls(calls, "counterarguments")).toHaveLength(0);
  });

  it("keeps a juror's previous ranking when it abstains in the rebuttal", async () => {
    const { caller } = scriptedCaller({
      j1: { prefer: ["ALPHA", "BETA", "GAMMA"], rebuttal: { raw: "oops" } },
      j2: { prefer: ["GAMMA", "BETA", "ALPHA"], rebuttal: { prefer: ["GAMMA", "BETA", "ALPHA"] } },
    });
    const result = await new AdjudicationEngine(caller).adjudicate(opts({ jurors: [J("j1"), J("j2")] }));
    expect(result.rounds[1]!.verdicts.find((v) => v.jurorId === "j1")!.status).toBe("abstained");
    expect(result.agreement.votes).toBe(2);
    expect(result.agreement.kendallW).toBe(0);
  });
});

describe("AdjudicationEngine — judge synthesis", () => {
  it("runs the existing judge over the verdicts and parses its sections", async () => {
    const { caller, calls } = scriptedCaller(same(["ALPHA", "GAMMA", "BETA"]));
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ judge: { modelId: "judge-model" } }),
    );
    expect(result.synthesis).toMatchObject({
      modelId: "judge-model",
      majorityPosition: "Most jurors preferred A.",
      unresolvedDisputes: "- None",
      judgeConfidence: 77,
    });
    const judge = calls.find((c) => c.participantId === "judge")!;
    expect(judge.phase).toBe("synthesis");
    expect(judge.system).toContain("You are the Consensus Judge");
    expect(judge.system).toContain(TASK);
    expect(judge.user).toContain("Aggregate ranking: A (6 pts) > C (3 pts) > B (0 pts)");
    expect(judge.user).toContain("Ranking: A > C > B");
    expect(judge.user).not.toContain("export const sum");
  });

  it("records a judge error in the synthesis content instead of failing the run", async () => {
    const { caller } = scriptedCaller(same(["ALPHA", "GAMMA", "BETA"]), { throws: "judge down" });
    const result = await new AdjudicationEngine(caller).adjudicate(opts({ judge: { modelId: "jm" } }));
    expect(result.synthesis!.content).toBe("[Judge error from jm: judge down]");
    expect(result.verdict).toBe("winner");
  });

  it("uses judge.caller when provided", async () => {
    const jurors = scriptedCaller(same(["ALPHA", "GAMMA", "BETA"]));
    const judge = scriptedCaller({}, { body: JUDGE_BODY });
    await new AdjudicationEngine(jurors.caller).adjudicate(
      opts({ judge: { modelId: "jm", caller: judge.caller } }),
    );
    expect(jurors.calls.some((c) => c.participantId === "judge")).toBe(false);
    expect(judge.calls).toHaveLength(1);
  });
});

describe("AdjudicationEngine — budget", () => {
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

  it("stops before dispatch when the worst-case round exceeds maxTokens", async () => {
    const { caller, calls } = scriptedCaller(same(["ALPHA", "BETA", "GAMMA"]));
    const engine = new AdjudicationEngine(caller);
    const stops: string[] = [];
    engine.on("budgetStop", (e) => stops.push(e.reason));
    const result = await engine.adjudicate(opts({ budget: { maxTokens: 100 } }));
    expect(calls).toHaveLength(0);
    expect(result.stopReason).toBe("token-budget");
    expect(stops).toEqual(["token-budget"]);
    expect(result.rounds).toEqual([]);
    expect(result.noClearWinnerReason).toBe("incomplete");
  });

  it("cancels in-flight jurors after a post-call breach and returns a partial result", async () => {
    const { caller, calls } = scriptedCaller({
      j1: { prefer: ["ALPHA", "BETA", "GAMMA"], usage: { inputTokens: 9e6, outputTokens: 1, totalTokens: 9e6 + 1 } },
      j2: { prefer: ["ALPHA", "BETA", "GAMMA"], delayMs: 200 },
      j3: { prefer: ["ALPHA", "BETA", "GAMMA"], delayMs: 200 },
    });
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ judge: { modelId: "jm" }, budget: { maxTokens: 1_000_000 } }),
    );
    expect(result.stopReason).toBe("token-budget");
    expect(result.rounds[0]!.verdicts.map((v) => v.status)).toEqual(["valid", "cancelled", "cancelled"]);
    expect(result.noClearWinnerReason).toBe("incomplete");
    expect(calls.some((c) => c.participantId === "judge")).toBe(false);
    expect(result.usage.totalTokens).toBe(9e6 + 1);
  });

  it("skips the judge when only the judge would cross the ceiling, keeping the verdict", async () => {
    const scripts = Object.fromEntries(
      ["j1", "j2", "j3"].map((id) => [id, { prefer: ["ALPHA", "BETA", "GAMMA"], usage }]),
    );
    const dry = scriptedCaller(scripts);
    await new AdjudicationEngine(dry.caller).adjudicate(opts({ maxOutputTokens: 10 }));
    const worstRound = jurorCalls(dry.calls).reduce(
      (a, c) => a + Math.ceil((c.system.length + c.user.length) / 4) + 10,
      0,
    );
    const { caller, calls } = scriptedCaller(scripts);
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ maxOutputTokens: 10, judge: { modelId: "jm" }, budget: { maxTokens: worstRound + 50 } }),
    );
    expect(calls.some((c) => c.participantId === "judge")).toBe(false);
    expect(result.stopReason).toBe("token-budget");
    expect(result.verdict).toBe("winner");
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 15, totalTokens: 45, calls: 3 });
  });

  it("reports a breach caused by the judge's reported usage while keeping its synthesis", async () => {
    const { caller } = scriptedCaller(
      Object.fromEntries(["j1", "j2", "j3"].map((id) => [id, { prefer: ["ALPHA", "BETA", "GAMMA"], usage }])),
      { usage: { inputTokens: 5e6, outputTokens: 1, totalTokens: 5e6 + 1 } },
    );
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ judge: { modelId: "jm" }, budget: { maxTokens: 1_000_000 } }),
    );
    expect(result.synthesis?.judgeConfidence).toBe(77);
    expect(result.stopReason).toBe("token-budget");
    expect(result.verdict).toBe("winner");
  });

  it("honours the deadline even when a caller ignores its signal", async () => {
    const { caller, calls } = scriptedCaller({
      j1: { prefer: ["ALPHA", "BETA", "GAMMA"] },
      j2: { hang: true },
      j3: { prefer: ["ALPHA", "BETA", "GAMMA"] },
    });
    const t0 = Date.now();
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ judge: { modelId: "jm" }, budget: { deadlineMs: 50 } }),
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.stopReason).toBe("deadline");
    expect(result.rounds[0]!.verdicts.map((v) => v.status)).toEqual(["valid", "cancelled", "valid"]);
    expect(result.rounds[0]!.verdicts[1]!.abstainReason).toBe("cancelled: deadline");
    expect(result.agreement.votes).toBe(2);
    expect(calls.some((c) => c.participantId === "judge")).toBe(false);
  });

  it("enforces a caller-priced cost cap", async () => {
    const { caller, calls } = scriptedCaller(same(["ALPHA", "BETA", "GAMMA"]));
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ budget: { costCap: { limitUSD: 0.01, estimateUSD: () => 0.02 } } }),
    );
    expect(calls).toHaveLength(0);
    expect(result.stopReason).toBe("cost-cap");
    expect(result.usage.costUSD).toBe(0);
  });

  it("totals usage, estimating chars/4 for calls that report none", async () => {
    const { caller } = scriptedCaller(
      { j1: { prefer: ["ALPHA", "BETA", "GAMMA"], usage }, j2: { prefer: ["ALPHA", "BETA", "GAMMA"] } },
      { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
    );
    const result = await new AdjudicationEngine(caller).adjudicate(
      opts({ jurors: [J("j1"), J("j2")], judge: { modelId: "jm" } }),
    );
    expect(result.usage.calls).toBe(3);
    expect(result.usage.estimatedCalls).toBe(1);
    expect(result.usage.inputTokens).toBeGreaterThan(110);
    expect(result.usage.costUSD).toBeUndefined();
  });
});

describe("AdjudicationEngine — abort", () => {
  it("returns an aborted result without calling anyone when the signal is already aborted", async () => {
    const { caller, calls } = scriptedCaller(same(["ALPHA", "BETA", "GAMMA"]));
    const ac = new AbortController();
    ac.abort();
    const result = await new AdjudicationEngine(caller).adjudicate(opts({ signal: ac.signal }));
    expect(calls).toHaveLength(0);
    expect(result.stopReason).toBe("aborted");
  });

  it("keeps finished verdicts and cancels the rest on a mid-round abort", async () => {
    const { caller, calls } = scriptedCaller({
      j1: { prefer: ["ALPHA", "BETA", "GAMMA"] },
      j2: { prefer: ["ALPHA", "BETA", "GAMMA"], delayMs: 500 },
      j3: { prefer: ["ALPHA", "BETA", "GAMMA"], delayMs: 500 },
    });
    const ac = new AbortController();
    const engine = new AdjudicationEngine(caller);
    engine.on("jurorComplete", (e) => {
      if (e.verdict.jurorId === "j1") ac.abort();
    });
    const result = await engine.adjudicate(opts({ signal: ac.signal, judge: { modelId: "jm" } }));
    expect(result.stopReason).toBe("aborted");
    expect(result.rounds[0]!.verdicts.map((v) => v.status)).toEqual(["valid", "cancelled", "cancelled"]);
    expect(calls.every((c) => c.signal?.aborted)).toBe(true);
    expect(calls.some((c) => c.participantId === "judge")).toBe(false);
  });
});

describe("AdjudicationEngine — events", () => {
  it("emits the lifecycle in order", async () => {
    const { caller } = scriptedCaller(same(["ALPHA", "BETA", "GAMMA"], 2));
    const engine = new AdjudicationEngine(caller);
    const seen: string[] = [];
    const names: AdjudicationEventName[] = [
      "roundStart",
      "jurorStart",
      "jurorComplete",
      "roundComplete",
      "synthesisStart",
      "synthesisComplete",
      "finalResult",
    ];
    for (const name of names) engine.on(name, () => seen.push(name));
    const tokens: string[] = [];
    engine.on("jurorToken", (e) => tokens.push(e.jurorId));
    await engine.adjudicate(opts({ jurors: [J("j1"), J("j2")], judge: { modelId: "jm" } }));
    expect(seen).toEqual([
      "roundStart",
      "jurorStart",
      "jurorStart",
      "jurorComplete",
      "jurorComplete",
      "roundComplete",
      "synthesisStart",
      "synthesisComplete",
      "finalResult",
    ]);
    expect(tokens.sort()).toEqual(["j1", "j2"]);
  });
});

describe("AdjudicationEngine — validation", () => {
  const { caller } = scriptedCaller({});
  const engine = new AdjudicationEngine(caller);

  it.each<[string, Partial<AdjudicationOptions>, RegExp]>([
    ["an empty task", { task: "  " }, /task/],
    ["one candidate", { candidates: CANDIDATES.slice(0, 1) }, /at least 2 candidates/],
    [
      "27 candidates",
      { candidates: Array.from({ length: 27 }, (_, i) => ({ id: `c${i}`, content: "" })) },
      /at most 26/,
    ],
    ["duplicate candidate ids", { candidates: [CANDIDATES[0]!, CANDIDATES[0]!] }, /duplicate candidate/],
    ["one juror", { jurors: [J("j1")] }, /at least 2 jurors/],
    ["a juror named judge", { jurors: [J("j1"), J("judge")] }, /reserved/],
    ["duplicate juror ids", { jurors: [J("j1"), J("j1")] }, /duplicate juror/],
    ["a threshold above 1", { agreementThreshold: 1.5 }, /agreementThreshold/],
    ["a zero deadline", { budget: { deadlineMs: 0 } }, /deadlineMs/],
    ["a negative seed", { randomSeed: -1 }, /randomSeed/],
    [
      "an invalid check status",
      { candidates: [{ id: "x", content: "", checks: [{ name: "t", status: "broken" as never }] }, CANDIDATES[1]!] },
      /check 0 is invalid/,
    ],
  ])("rejects %s", async (_name, patch, re) => {
    await expect(engine.adjudicate(opts(patch))).rejects.toThrow(re);
  });
});
