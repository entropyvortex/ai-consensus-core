import { describe, it, expect } from "vitest";
import {
  bordaCount,
  computeDissent,
  decideVerdict,
  findingWeights,
  kendallW,
  rankCandidates,
} from "../aggregation.js";
import type { RankedCandidate } from "../types.js";

const IDS = ["a", "b", "c"];

describe("bordaCount — contract: position p of n earns n-1-p, summed over rankings", () => {
  it("scores three rankings of three candidates", () => {
    const pts = bordaCount(
      [
        ["a", "b", "c"],
        ["a", "c", "b"],
        ["b", "a", "c"],
      ],
      IDS,
    );
    // a: 2+2+1, b: 1+0+2, c: 0+1+0
    expect(pts).toEqual({ a: 5, b: 3, c: 1 });
  });

  it("gives every candidate 0 with no rankings", () => {
    expect(bordaCount([], IDS)).toEqual({ a: 0, b: 0, c: 0 });
  });

  it("rejects a ranking that is not a full permutation", () => {
    expect(() => bordaCount([["a", "b"]], IDS)).toThrow(/permutation/);
    expect(() => bordaCount([["a", "a", "b"]], IDS)).toThrow(/permutation/);
    expect(() => bordaCount([["a", "b", "z"]], IDS)).toThrow(/permutation/);
  });

  it("rejects duplicate candidate ids", () => {
    expect(() => bordaCount([], ["a", "a"])).toThrow(/unique/);
  });
});

describe("kendallW — contract: 12S / (m²(n³−n)), null when undefined", () => {
  it("is 1 for identical rankings", () => {
    expect(kendallW([IDS, IDS, IDS], IDS)).toBe(1);
  });

  it("is 0 for two exactly opposite rankings", () => {
    expect(kendallW([["a", "b", "c"], ["c", "b", "a"]], IDS)).toBe(0);
  });

  it("matches hand-computed values", () => {
    // 3 jurors, 3 candidates, one swaps the top two: R = 4, 5, 9; S = 14; W = 168/216
    expect(kendallW([IDS, IDS, ["b", "a", "c"]], IDS)).toBeCloseTo(168 / 216, 10);
    // 3 jurors, 2 candidates, split 2–1: R = 4, 5; S = 0.5; W = 6/54
    expect(kendallW([["a", "b"], ["a", "b"], ["b", "a"]], ["a", "b"])).toBeCloseTo(1 / 9, 10);
    // 5 jurors, 2 candidates, 4–1: W = (3/5)²
    const four = Array.from({ length: 4 }, () => ["a", "b"]);
    expect(kendallW([...four, ["b", "a"]], ["a", "b"])).toBeCloseTo(0.36, 10);
  });

  it("is null for fewer than two rankings or fewer than two candidates", () => {
    expect(kendallW([IDS], IDS)).toBeNull();
    expect(kendallW([], IDS)).toBeNull();
    expect(kendallW([["a"], ["a"]], ["a"])).toBeNull();
  });

  it("measures the whole ordering, not the winner (high W with a split top)", () => {
    const ids = ["a", "b", "c", "d"];
    expect(kendallW([["a", "b", "c", "d"], ["b", "a", "c", "d"]], ids)).toBeCloseTo(0.9, 10);
  });
});

describe("rankCandidates — contract: points ↓, first places ↓, finding weight ↑, id ↑", () => {
  const cands = IDS.map((id) => ({ id }));

  it("orders by Borda points and assigns 1-based ranks and canonical labels", () => {
    const r = rankCandidates({ candidates: cands, rankings: [["c", "a", "b"], ["c", "b", "a"]] });
    expect(r.map((x) => x.candidateId)).toEqual(["c", "a", "b"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r.find((x) => x.candidateId === "a")!.label).toBe("A");
    expect(r.find((x) => x.candidateId === "c")!.label).toBe("C");
  });

  it("breaks a points tie by first-place votes", () => {
    // a and b both score 4 points; a has one first place, b none.
    const ids = ["a", "b", "c", "d"];
    const rankings = [
      ["a", "d", "c", "b"], // a 3, b 0
      ["c", "b", "a", "d"], // a 1, b 2
      ["d", "b", "c", "a"], // a 0, b 2
    ];
    const pts = bordaCount(rankings, ids);
    expect(pts["a"]).toBe(pts["b"]); // 4 = 4
    const r = rankCandidates({ candidates: ids.map((id) => ({ id })), rankings });
    const order = r.map((x) => x.candidateId);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(r.find((x) => x.candidateId === "a")!.firstPlaceVotes).toBe(1);
  });

  it("then by severity-weighted verified findings (fewer is better)", () => {
    const rankings = [["a", "b", "c"], ["b", "a", "c"]];
    const r = rankCandidates({
      candidates: cands,
      rankings,
      findings: [
        { candidateId: "a", severity: "high" },
        { candidateId: "b", severity: "low" },
      ],
    });
    expect(r[0]!.candidateId).toBe("b");
    expect(r[0]!.findingWeight).toBe(1);
    expect(r[1]!.findingWeight).toBe(3);
  });

  it("then by candidate id, independent of input order", () => {
    const rankings = [["a", "b", "c"], ["b", "a", "c"]];
    const forward = rankCandidates({ candidates: cands, rankings }).map((x) => x.candidateId);
    const reversed = rankCandidates({ candidates: [...cands].reverse(), rankings }).map(
      (x) => x.candidateId,
    );
    expect(forward).toEqual(["a", "b", "c"]);
    expect(reversed).toEqual(forward);
  });

  it("marks failed-check candidates ineligible unless every candidate failed", () => {
    const some = rankCandidates({
      candidates: [
        { id: "a", checks: [{ name: "tests", status: "failed" }] },
        { id: "b", checks: [{ name: "tests", status: "passed" }] },
        { id: "c", checks: [{ name: "tests", status: "unknown" }] },
      ],
      rankings: [IDS],
    });
    expect(some.map((r) => [r.candidateId, r.eligible, r.failedChecks])).toEqual([
      ["a", false, ["tests"]],
      ["b", true, []],
      ["c", true, []],
    ]);
    const all = rankCandidates({
      candidates: IDS.map((id) => ({ id, checks: [{ name: "build", status: "failed" as const }] })),
      rankings: [IDS],
    });
    expect(all.every((r) => r.eligible)).toBe(true);
  });
});

describe("findingWeights", () => {
  it("weights high 3, medium 2, low 1", () => {
    expect(
      findingWeights([
        { candidateId: "a", severity: "high" },
        { candidateId: "a", severity: "medium" },
        { candidateId: "b", severity: "low" },
      ]),
    ).toEqual({ a: 5, b: 1 });
  });
});

function row(id: string, points: number, eligible = true): RankedCandidate {
  return {
    candidateId: id,
    label: id.toUpperCase(),
    rank: 0,
    points,
    firstPlaceVotes: 0,
    findingWeight: 0,
    failedChecks: eligible ? [] : ["tests"],
    eligible,
  };
}

describe("decideVerdict — contract: complete, ≥2 votes, W ≥ threshold, strict points lead", () => {
  const base = { kendallW: 0.8, votes: 3, threshold: 0.3, complete: true };

  it("recommends a leader that satisfies every condition", () => {
    const d = decideVerdict({ ...base, ranking: [row("a", 5), row("b", 3)] });
    expect(d).toEqual({ verdict: "winner", recommended: "a", leader: "a" });
  });

  it("reports a points tie at the top as no clear winner, whatever the tie-break", () => {
    const d = decideVerdict({ ...base, ranking: [row("a", 4), row("b", 4)] });
    expect(d.verdict).toBe("no-clear-winner");
    expect(d.reason).toBe("tie");
    expect(d.leader).toBe("a");
    expect(d.recommended).toBeNull();
  });

  it("reports low agreement below the threshold", () => {
    const d = decideVerdict({ ...base, kendallW: 0.29, ranking: [row("a", 5), row("b", 1)] });
    expect(d.reason).toBe("low-agreement");
  });

  it("reports insufficient votes with fewer than two votes", () => {
    const d = decideVerdict({ ...base, votes: 1, kendallW: null, ranking: [row("a", 2), row("b", 0)] });
    expect(d.reason).toBe("insufficient-votes");
    expect(decideVerdict({ ...base, votes: 0, kendallW: null, ranking: [row("a", 0)] }).leader).toBeNull();
  });

  it("reports an incomplete first round before anything else", () => {
    const d = decideVerdict({ ...base, complete: false, votes: 0, kendallW: null, ranking: [row("a", 0)] });
    expect(d.reason).toBe("incomplete");
  });

  it("never recommends an ineligible candidate; the best eligible one leads", () => {
    const d = decideVerdict({ ...base, ranking: [row("a", 6, false), row("b", 3), row("c", 1)] });
    expect(d).toEqual({ verdict: "winner", recommended: "b", leader: "b" });
  });

  it("compares the leader only against other eligible candidates", () => {
    const d = decideVerdict({ ...base, ranking: [row("a", 6, false), row("b", 3), row("c", 3)] });
    expect(d.reason).toBe("tie");
    expect(d.leader).toBe("b");
  });
});

describe("computeDissent — contract: jurors whose top pick differs from the leader", () => {
  it("lists dissenting jurors with their top pick", () => {
    expect(
      computeDissent(
        [
          { jurorId: "j1", ranking: ["a", "b"] },
          { jurorId: "j2", ranking: ["b", "a"] },
        ],
        "a",
      ),
    ).toEqual([{ jurorId: "j2", topPick: "b" }]);
  });

  it("is empty without a leader", () => {
    expect(computeDissent([{ jurorId: "j1", ranking: ["a"] }], null)).toEqual([]);
  });
});
