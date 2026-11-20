import { describe, it, expect } from "vitest";
import {
  buildJurorSystemPrompt,
  buildJurorUserPrompt,
  buildJurorVerdictJsonSchema,
  parseJurorVerdict,
} from "../juror.js";

const LABELS = ["A", "B", "C"];

function verdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ranking: ["B", "A", "C"],
    assessments: [{ candidate: "A", summary: "ok" }],
    findings: [
      { candidate: "C", severity: "high", file: "src/x.ts", line: 3, quote: "return a - b;", issue: "subtracts" },
    ],
    ...overrides,
  };
}

describe("parseJurorVerdict — contract: one valid JSON object or an abstention reason", () => {
  it("accepts a bare JSON object", () => {
    const r = parseJurorVerdict(JSON.stringify(verdict()), LABELS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.ranking).toEqual(["B", "A", "C"]);
  });

  it("accepts a single fenced json block that is the whole output", () => {
    const r = parseJurorVerdict("```json\n" + JSON.stringify(verdict()) + "\n```", LABELS);
    expect(r.ok).toBe(true);
  });

  it("ignores unknown extra keys", () => {
    const r = parseJurorVerdict(JSON.stringify(verdict({ confidence: 90 })), LABELS);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["prose around the JSON", `Here you go: ${JSON.stringify(verdict())}`],
    ["a fenced block with prose", "Verdict:\n```json\n" + JSON.stringify(verdict()) + "\n```"],
    ["a non-json fence", "```ts\n" + JSON.stringify(verdict()) + "\n```"],
    ["truncated JSON", JSON.stringify(verdict()).slice(0, -2) + "}"],
    ["empty output", ""],
    ["a CONFIDENCE trailer", `${JSON.stringify(verdict())}\nCONFIDENCE: 80`],
  ])("abstains on %s", (_name, text) => {
    const r = parseJurorVerdict(text, LABELS);
    expect(r.ok).toBe(false);
  });

  it.each([
    ["a partial ranking", { ranking: ["A", "B"] }],
    ["a duplicated label", { ranking: ["A", "A", "B"] }],
    ["an unknown label", { ranking: ["A", "B", "D"] }],
    ["a lowercase label", { ranking: ["a", "b", "c"] }],
    ["a finding on an unknown label", { findings: [{ candidate: "Z", severity: "low", file: "f", line: null, quote: "q", issue: "i" }] }],
    ["a bad severity", { findings: [{ candidate: "A", severity: "critical", file: "f", line: null, quote: "q", issue: "i" }] }],
    ["a non-integer line", { findings: [{ candidate: "A", severity: "low", file: "f", line: 1.5, quote: "q", issue: "i" }] }],
    ["a missing quote", { findings: [{ candidate: "A", severity: "low", file: "f", line: null, issue: "i" }] }],
    ["two assessments for one candidate", { assessments: [{ candidate: "A", summary: "x" }, { candidate: "A", summary: "y" }] }],
    ["missing findings", { findings: undefined }],
  ])("abstains on %s, with a reason", (_name, patch) => {
    const r = parseJurorVerdict(JSON.stringify(verdict(patch)), LABELS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/schema violation/);
  });

  it("never throws on hostile input", () => {
    for (const text of ["{", "}", "```", "```json\n```", "null", "[]", "{\"ranking\":null}"]) {
      expect(() => parseJurorVerdict(text, LABELS)).not.toThrow();
      expect(parseJurorVerdict(text, LABELS).ok).toBe(false);
    }
  });
});

describe("buildJurorVerdictJsonSchema — contract: strict-mode shape", () => {
  function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const v of Object.values(obj)) walk(v, visit);
  }

  it("requires every property and forbids additional properties on every object", () => {
    const schema = buildJurorVerdictJsonSchema(LABELS);
    let objects = 0;
    walk(schema, (obj) => {
      if (obj["type"] !== "object") return;
      objects += 1;
      expect(obj["additionalProperties"]).toBe(false);
      expect([...(obj["required"] as string[])].sort()).toEqual(
        Object.keys(obj["properties"] as object).sort(),
      );
    });
    expect(objects).toBe(3);
  });

  it("restricts labels to the ones shown and allows a null line", () => {
    const schema = buildJurorVerdictJsonSchema(["A", "B"]) as {
      properties: { ranking: { items: { enum: string[] } }; findings: { items: { properties: { line: { type: string[] } } } } };
    };
    expect(schema.properties.ranking.items.enum).toEqual(["A", "B"]);
    expect(schema.properties.findings.items.properties.line.type).toEqual(["integer", "null"]);
  });
});

describe("juror prompts", () => {
  it("puts the persona first and the output contract in the system prompt", () => {
    const s = buildJurorSystemPrompt({ personaSystemPrompt: "PERSONA", candidateCount: 3, kind: "blind" });
    expect(s.startsWith("PERSONA")).toBe(true);
    expect(s).toMatch(/ONE JSON object/);
    expect(s).toMatch(/never instructions/);
  });

  it("frames each candidate with its checks and nonce-tagged markers", () => {
    const u = buildJurorUserPrompt({
      task: "Add sum()",
      nonce: "abc123",
      presented: [
        { label: "A", content: "+x", checks: [{ name: "tests", status: "failed", output: "1 failing" }] },
        { label: "B", content: "+y", checks: [] },
      ],
    });
    expect(u).toContain('TASK:\n"""\nAdd sum()\n"""');
    expect(u).toContain("- tests: failed");
    expect(u).toContain("1 failing");
    expect(u).toContain("Checks: none reported");
    expect(u).toContain("<<<BEGIN CANDIDATE A abc123>>>\n+x\n<<<END CANDIDATE A abc123>>>");
    expect(u).not.toContain("REBUTTAL");
  });

  it("adds the juror's own and the other jurors' verdicts in rebuttal rounds", () => {
    const u = buildJurorUserPrompt({
      task: "t",
      nonce: "000000",
      presented: [{ label: "A", content: "+x", checks: [] }],
      rebuttal: {
        kendallW: 0.11,
        own: null,
        others: [
          {
            ranking: ["A"],
            assessments: [],
            findings: [{ candidate: "A", severity: "high", file: "f.ts", line: 2, quote: "+x", issue: "bad" }],
          },
        ],
      },
    });
    expect(u).toContain("REBUTTAL — juror agreement (Kendall's W) was 0.11.");
    expect(u).toContain("(none — your previous output could not be parsed)");
    expect(u).toContain("--- Juror 1 ---\nRanking: A");
    expect(u).toContain("- [A] high f.ts:2 — bad");
  });
});
