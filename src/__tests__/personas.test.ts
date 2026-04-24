import { describe, it, expect } from "vitest";
import { JUDGE_PERSONA } from "../personas.js";

describe("JUDGE_PERSONA", () => {
  it("has id 'judge' and a substantial prompt", () => {
    expect(JUDGE_PERSONA.id).toBe("judge");
    expect(JUDGE_PERSONA.systemPrompt.trim().length).toBeGreaterThan(100);
  });

  it("instructs the model to emit the four required headings", () => {
    // These headings are the parser's contract. If the prompt drifts out of
    // sync with extractJudgeSection's expectations, synthesis results go
    // blank with no obvious cause.
    for (const heading of [
      "Majority Position",
      "Minority Positions",
      "Unresolved Disputes",
      "Synthesis Confidence",
    ]) {
      expect(JUDGE_PERSONA.systemPrompt).toContain(heading);
    }
  });

  it("instructs the model to end with JUDGE_CONFIDENCE", () => {
    expect(JUDGE_PERSONA.systemPrompt).toContain("JUDGE_CONFIDENCE");
  });

  it("explicitly forbids picking a winner and collapsing minorities", () => {
    // These are the rules that make the judge useful instead of just another
    // debater. Worth asserting so the prompt can't be silently relaxed.
    expect(JUDGE_PERSONA.systemPrompt).toMatch(/not pick a winner/i);
    expect(JUDGE_PERSONA.systemPrompt).toMatch(/minority/i);
  });
});
