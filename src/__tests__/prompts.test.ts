import { describe, it, expect } from "vitest";
import { JUDGE_PERSONA, PERSONAS } from "../personas.js";
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  buildParticipantSystemPrompt,
  formatPreviousResponses,
  getRoundMeta,
} from "../prompts.js";
import type { Participant, ParticipantResponse } from "../types.js";

function makeResponse(
  pid: string,
  content: string,
  confidence: number,
): ParticipantResponse {
  return {
    participantId: pid,
    modelId: "m",
    personaId: "pessimist",
    round: 1,
    phase: "initial-analysis",
    content,
    confidence,
    startedAt: 0,
    completedAt: 0,
    durationMs: 0,
  };
}

describe("getRoundMeta", () => {
  it("round 1 → initial-analysis / Initial Analysis", () => {
    expect(getRoundMeta(1, 4)).toEqual({
      phase: "initial-analysis",
      label: "Initial Analysis",
    });
  });

  it("round 2 → counterarguments / Counterarguments", () => {
    expect(getRoundMeta(2, 4)).toEqual({
      phase: "counterarguments",
      label: "Counterarguments",
    });
  });

  it("round 3 → evidence-assessment / Evidence Assessment", () => {
    expect(getRoundMeta(3, 4)).toEqual({
      phase: "evidence-assessment",
      label: "Evidence Assessment",
    });
  });

  it("non-final round ≥4 → Synthesis & Refinement with round number", () => {
    expect(getRoundMeta(5, 7)).toEqual({
      phase: "synthesis",
      label: "Synthesis & Refinement (Round 5)",
    });
  });

  it("final round ≥4 → Final Synthesis", () => {
    expect(getRoundMeta(6, 6)).toEqual({
      phase: "synthesis",
      label: "Final Synthesis",
    });
  });
});

describe("formatPreviousResponses", () => {
  it("returns an empty string for no responses (round 1 / blind)", () => {
    // An empty block is critical for blind round 1: participants must not
    // see a fence with no content (which would be a weird signal to a model).
    expect(formatPreviousResponses([])).toBe("");
  });

  it("wraps responses in the PREVIOUS ROUND RESPONSES fence", () => {
    const out = formatPreviousResponses([
      makeResponse("p1", "my take", 80),
    ]);
    expect(out).toContain("--- PREVIOUS ROUND RESPONSES ---");
    expect(out).toContain("--- END PREVIOUS RESPONSES ---");
  });

  it("includes each response's participant id and confidence in the header", () => {
    const out = formatPreviousResponses([
      makeResponse("p1", "alpha", 80),
      makeResponse("p2", "beta", 65),
    ]);
    expect(out).toContain("[Participant p1 | Confidence: 80%]");
    expect(out).toContain("[Participant p2 | Confidence: 65%]");
  });

  it("separates multiple responses with a --- fence", () => {
    const out = formatPreviousResponses([
      makeResponse("p1", "alpha", 80),
      makeResponse("p2", "beta", 65),
    ]);
    expect(out).toContain("\n\n---\n\n");
  });
});

describe("buildParticipantSystemPrompt", () => {
  const persona = PERSONAS[0]!; // Risk Analyst

  it("includes the persona system prompt verbatim", () => {
    const out = buildParticipantSystemPrompt({
      personaSystemPrompt: persona.systemPrompt,
      phase: "initial-analysis",
      round: 1,
      totalRounds: 4,
      previousResponses: [],
    });
    expect(out).toContain(persona.systemPrompt);
  });

  it("includes the correct phase instructions for each phase", () => {
    const at = (phase: Parameters<typeof buildParticipantSystemPrompt>[0]["phase"]) =>
      buildParticipantSystemPrompt({
        personaSystemPrompt: persona.systemPrompt,
        phase,
        round: 1,
        totalRounds: 4,
        previousResponses: [],
      });
    expect(at("initial-analysis")).toContain("INITIAL ANALYSIS");
    expect(at("counterarguments")).toContain("COUNTERARGUMENTS");
    expect(at("evidence-assessment")).toContain("EVIDENCE ASSESSMENT");
    expect(at("synthesis")).toMatch(/FINAL SYNTHESIS|SYNTHESIS & REFINEMENT/);
  });

  it("always ends with the CONFIDENCE marker instruction (parser contract)", () => {
    // This is the handshake between prompt and parser. If it ever drifts,
    // every extractConfidence call silently returns 50 and the whole score
    // collapses to the mean — a very subtle failure mode.
    const out = buildParticipantSystemPrompt({
      personaSystemPrompt: persona.systemPrompt,
      phase: "initial-analysis",
      round: 1,
      totalRounds: 4,
      previousResponses: [],
    });
    expect(out).toMatch(/CONFIDENCE: \[number 0-100\]\s*$/);
  });

  it("omits the previous-responses block when the list is empty", () => {
    const out = buildParticipantSystemPrompt({
      personaSystemPrompt: persona.systemPrompt,
      phase: "initial-analysis",
      round: 1,
      totalRounds: 4,
      previousResponses: [],
    });
    expect(out).not.toContain("PREVIOUS ROUND RESPONSES");
  });

  it("includes the previous-responses block for non-blind rounds", () => {
    const out = buildParticipantSystemPrompt({
      personaSystemPrompt: persona.systemPrompt,
      phase: "counterarguments",
      round: 2,
      totalRounds: 4,
      previousResponses: [makeResponse("p1", "hi\nCONFIDENCE: 80", 80)],
    });
    expect(out).toContain("PREVIOUS ROUND RESPONSES");
    expect(out).toContain("[Participant p1 | Confidence: 80%]");
  });

  it("labels the current round as k/N", () => {
    const out = buildParticipantSystemPrompt({
      personaSystemPrompt: persona.systemPrompt,
      phase: "counterarguments",
      round: 2,
      totalRounds: 4,
      previousResponses: [],
    });
    expect(out).toContain("Round 2/4");
  });
});

describe("buildJudgeSystemPrompt", () => {
  it("wraps the original question in triple quotes", () => {
    const out = buildJudgeSystemPrompt({
      judgeSystemPrompt: JUDGE_PERSONA.systemPrompt,
      question: "Is X better than Y?",
    });
    expect(out).toContain('"""\nIs X better than Y?\n"""');
  });

  it("preserves the full JUDGE_PERSONA system prompt", () => {
    const out = buildJudgeSystemPrompt({
      judgeSystemPrompt: JUDGE_PERSONA.systemPrompt,
      question: "Q",
    });
    expect(out).toContain(JUDGE_PERSONA.systemPrompt);
  });
});

describe("buildJudgeUserPrompt", () => {
  const participants: Participant[] = [
    { id: "p1", modelId: "claude-opus-4-5", persona: PERSONAS[0]! },
    { id: "p2", modelId: "gpt-4o", persona: PERSONAS[1]! },
  ];

  it("labels each response with persona name and model id", () => {
    const out = buildJudgeUserPrompt({
      participants,
      finalResponses: [
        makeResponse("p1", "body A\nCONFIDENCE: 80", 80),
        makeResponse("p2", "body B\nCONFIDENCE: 65", 65),
      ],
    });
    expect(out).toContain("### Risk Analyst (claude-opus-4-5)");
    expect(out).toContain("### First-Principles Engineer (gpt-4o)");
  });

  it("surfaces each participant's self-reported confidence in the heading", () => {
    const out = buildJudgeUserPrompt({
      participants,
      finalResponses: [makeResponse("p1", "body\nCONFIDENCE: 80", 80)],
    });
    expect(out).toContain("self-reported confidence 80%");
  });

  it("strips the trailing CONFIDENCE marker from each quoted body", () => {
    // The heading already surfaces the confidence. Leaving the literal marker
    // in the body risks the judge hallucinating it as its own output.
    const out = buildJudgeUserPrompt({
      participants,
      finalResponses: [makeResponse("p1", "body A\nCONFIDENCE: 80", 80)],
    });
    expect(out).not.toMatch(/\n\s*CONFIDENCE:\s*80/);
    expect(out).toContain("body A");
  });

  it("falls back to the participant id when the participant is not found", () => {
    const out = buildJudgeUserPrompt({
      participants: [],
      finalResponses: [makeResponse("stranger", "orphan body", 70)],
    });
    expect(out).toContain("### stranger");
  });

  it("separates responses with a --- fence", () => {
    const out = buildJudgeUserPrompt({
      participants,
      finalResponses: [
        makeResponse("p1", "a", 80),
        makeResponse("p2", "b", 70),
      ],
    });
    expect(out).toContain("\n\n---\n\n");
  });
});
