import { describe, it, expect } from "vitest";
import {
  mergeFindings,
  normalizeQuote,
  quoteAppearsIn,
  stripDiffMarkers,
  verifyFindings,
} from "../verification.js";
import type { AdjudicationFinding } from "../types.js";

const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,3 +1,4 @@",
  " export function x(a: number) {",
  "-  return a;",
  "+  if (a < 0) throw new Error('neg');",
  "+  return a * 2;",
  " }",
].join("\n");

function F(candidateId: string, quote: string, extra: Partial<AdjudicationFinding> = {}): AdjudicationFinding {
  return { candidateId, quote, severity: "medium", file: "src/x.ts", line: null, issue: "bug", ...extra };
}

describe("quoteAppearsIn — contract: verbatim after whitespace normalization", () => {
  it("finds a quote copied verbatim from the diff, markers included", () => {
    expect(quoteAppearsIn("+  return a * 2;", DIFF)).toBe(true);
  });

  it("finds a multi-line quote with the diff markers omitted", () => {
    expect(quoteAppearsIn("if (a < 0) throw new Error('neg');\n  return a * 2;", DIFF)).toBe(true);
  });

  it("tolerates whitespace differences", () => {
    expect(quoteAppearsIn("if (a <  0)\tthrow new Error('neg');", DIFF)).toBe(true);
  });

  it("rejects a fabricated or paraphrased quote", () => {
    expect(quoteAppearsIn("return a * 3;", DIFF)).toBe(false);
    expect(quoteAppearsIn("throws on negative input", DIFF)).toBe(false);
  });

  it("rejects quotes shorter than the minimum length", () => {
    expect(quoteAppearsIn("a * 2", DIFF)).toBe(false);
    expect(quoteAppearsIn("a * 2", DIFF, 3)).toBe(true);
  });
});

describe("verifyFindings — contract: a finding counts only if its quote is in the candidate it names", () => {
  const candidates = [
    { id: "x", content: DIFF },
    { id: "y", content: "+const y = computeSomethingElse();" },
  ];

  it("splits verified from dropped and preserves order", () => {
    const { verified, dropped } = verifyFindings(
      [
        F("x", "return a * 2;"),
        F("x", "return a * 3;"),
        F("y", "computeSomethingElse()"),
        F("y", "return a * 2;"), // real quote, wrong candidate
        F("zz", "return a * 2;"), // unknown candidate
      ],
      candidates,
    );
    expect(verified.map((f) => [f.candidateId, f.quote])).toEqual([
      ["x", "return a * 2;"],
      ["y", "computeSomethingElse()"],
    ]);
    expect(dropped).toHaveLength(3);
  });
});

describe("normalizeQuote / stripDiffMarkers", () => {
  it("collapses whitespace runs and trims", () => {
    expect(normalizeQuote("  a\n\t b  ")).toBe("a b");
  });

  it("strips one leading marker per line but keeps file headers", () => {
    expect(stripDiffMarkers("--- a/f\n+++ b/f\n+x\n-y\n z")).toBe("--- a/f\n+++ b/f\nx\ny\nz");
  });
});

describe("mergeFindings — contract: one entry per candidate, file and quote", () => {
  it("merges reporters, keeps the highest severity and the first issue text", () => {
    const merged = mergeFindings([
      { jurorId: "j1", finding: F("x", "return a * 2;", { severity: "low", issue: "first" }) },
      { jurorId: "j2", finding: F("x", "return  a * 2;", { severity: "high", issue: "second" }) },
      { jurorId: "j2", finding: F("x", "return a * 2;", { file: "other.ts" }) },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ severity: "high", issue: "first", reportedBy: ["j1", "j2"] });
    expect(merged[1]!.file).toBe("other.ts");
  });
});
