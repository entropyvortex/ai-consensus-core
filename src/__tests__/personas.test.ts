import { describe, it, expect } from "vitest";
import {
  JUDGE_PERSONA,
  PERSONAS,
  getPersonaById,
  getPersonaOrDefault,
} from "../personas.js";

describe("PERSONAS", () => {
  it("contains exactly 7 debate personas", () => {
    expect(PERSONAS).toHaveLength(7);
  });

  it("preserves the roundtable-specified ids and order", () => {
    // Order matters: the PERSONAS[0] fallback in getPersonaOrDefault and the
    // UI's default selection both depend on "pessimist" being first. If this
    // drifts, downstream expectations break silently.
    expect(PERSONAS.map((p) => p.id)).toEqual([
      "pessimist",
      "first-principles",
      "vc-specialist",
      "scientific-skeptic",
      "optimistic-futurist",
      "devils-advocate",
      "domain-expert",
    ]);
  });

  it("gives every persona a non-empty systemPrompt, name, and description", () => {
    for (const p of PERSONAS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.systemPrompt.trim().length).toBeGreaterThan(20);
    }
  });

  it("has unique ids (no accidental collisions if the list is extended)", () => {
    const ids = PERSONAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not include the judge persona", () => {
    // JUDGE_PERSONA is a non-voting synthesizer. Leaking it into the
    // debate list would change run semantics and is explicitly guarded
    // against by the roundtable source.
    expect(PERSONAS.find((p) => p.id === "judge")).toBeUndefined();
  });
});

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

describe("getPersonaById", () => {
  it("returns the persona when the id exists", () => {
    expect(getPersonaById("pessimist")?.name).toBe("Risk Analyst");
    expect(getPersonaById("domain-expert")?.name).toBe("Domain Expert");
  });

  it("returns undefined for an unknown id", () => {
    expect(getPersonaById("does-not-exist")).toBeUndefined();
  });
});

describe("getPersonaOrDefault", () => {
  it("returns the persona when the id exists", () => {
    expect(getPersonaOrDefault("devils-advocate").id).toBe("devils-advocate");
  });

  it("falls back to the first persona on unknown id", () => {
    // Callers want a concrete Persona, not Persona | undefined. The fallback
    // removes an ergonomic wart from config loading code paths.
    expect(getPersonaOrDefault("unknown").id).toBe(PERSONAS[0]!.id);
  });
});
