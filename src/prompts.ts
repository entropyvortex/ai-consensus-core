// ─────────────────────────────────────────────────────────────
// Prompts — faithful port of the CVP prompt templates.
// ─────────────────────────────────────────────────────────────
// The exact strings here shape model behavior. Any drift between
// this file and roundtable/lib/consensus-engine.ts will change
// run semantics, so edits should be deliberate.

import type { ParticipantResponse, Participant, Phase } from "./types.js";

export interface RoundMeta {
  phase: Phase;
  label: string;
}

/**
 * Map a round number to its phase and human label.
 *
 *   Round 1      → initial-analysis     "Initial Analysis"
 *   Round 2      → counterarguments     "Counterarguments"
 *   Round 3      → evidence-assessment  "Evidence Assessment"
 *   Round 4..N-1 → synthesis            "Synthesis & Refinement (Round N)"
 *   Round N      → synthesis            "Final Synthesis"
 */
export function getRoundMeta(round: number, totalRounds: number): RoundMeta {
  if (round === 1) return { phase: "initial-analysis", label: "Initial Analysis" };
  if (round === 2) return { phase: "counterarguments", label: "Counterarguments" };
  if (round === 3) return { phase: "evidence-assessment", label: "Evidence Assessment" };
  return {
    phase: "synthesis",
    label:
      round === totalRounds
        ? "Final Synthesis"
        : `Synthesis & Refinement (Round ${round})`,
  };
}

const PHASE_INSTRUCTIONS: Record<Phase, (round: number, totalRounds: number) => string> = {
  "initial-analysis": (round, total) =>
    `This is Round ${round}/${total}: INITIAL ANALYSIS.
Provide your initial analysis of the prompt. Share your perspective, key observations, and preliminary assessment. State your confidence level (0-100) at the end.`,

  counterarguments: (round, total) =>
    `This is Round ${round}/${total}: COUNTERARGUMENTS.
Review the initial analyses from all participants below. Identify weaknesses, biases, and blind spots. Offer substantive counterarguments. Challenge assumptions. State your updated confidence level (0-100) at the end.`,

  "evidence-assessment": (round, total) =>
    `This is Round ${round}/${total}: EVIDENCE ASSESSMENT.
Evaluate the strength of evidence and reasoning presented so far. Distinguish well-supported claims from speculation. Identify areas where consensus is forming and where disagreement remains substantive. State your confidence level (0-100) at the end.`,

  synthesis: (round, total) => {
    const isFinal = round === total;
    const header = isFinal ? "FINAL SYNTHESIS" : "SYNTHESIS & REFINEMENT";
    const directive = isFinal
      ? "Provide your final, considered position."
      : "Refine your position based on the strongest arguments presented.";
    return `This is Round ${round}/${total}: ${header}.
Synthesize the discussion so far into a coherent assessment. Acknowledge remaining uncertainties. ${directive} State your final confidence level (0-100) at the end.`;
  },
};

/**
 * Format the block of previous responses that a participant sees at the
 * start of rounds 2+. Matches roundtable's "PREVIOUS ROUND RESPONSES"
 * fence so models can't latch onto a different delimiter across versions.
 */
export function formatPreviousResponses(responses: readonly ParticipantResponse[]): string {
  if (responses.length === 0) return "";
  const blocks = responses.map(
    (r) => `[Participant ${r.participantId} | Confidence: ${r.confidence}%]\n${r.content}`,
  );
  return `\n\n--- PREVIOUS ROUND RESPONSES ---\n${blocks.join("\n\n---\n\n")}\n--- END PREVIOUS RESPONSES ---`;
}

/**
 * Build the full system prompt for a single participant call.
 *
 * Shape:
 *
 *     {persona.systemPrompt}
 *
 *     {phase instructions}{previous-responses block, if any}
 *
 *     IMPORTANT: End your response with a line in exactly this format:
 *     CONFIDENCE: [number 0-100]
 */
export function buildParticipantSystemPrompt(params: {
  personaSystemPrompt: string;
  phase: Phase;
  round: number;
  totalRounds: number;
  previousResponses: readonly ParticipantResponse[];
}): string {
  const instructions = PHASE_INSTRUCTIONS[params.phase](params.round, params.totalRounds);
  const previousContext = formatPreviousResponses(params.previousResponses);
  return `${params.personaSystemPrompt}

${instructions}${previousContext}

IMPORTANT: End your response with a line in exactly this format:
CONFIDENCE: [number 0-100]`;
}

/**
 * Build the judge's system prompt. We append the original user prompt to
 * the JUDGE_PERSONA's instructions so the model knows what was debated,
 * without having to infer it from participant text.
 */
export function buildJudgeSystemPrompt(params: {
  judgeSystemPrompt: string;
  question: string;
}): string {
  return `${params.judgeSystemPrompt}

The original prompt that was debated was:
"""
${params.question}
"""`;
}

/**
 * Build the judge's user content: the final-round responses, labelled with
 * persona name and model id, and with the trailing `CONFIDENCE: N` line
 * stripped from each body (the participant confidence is surfaced in the
 * heading instead).
 */
export function buildJudgeUserPrompt(params: {
  finalResponses: readonly ParticipantResponse[];
  participants: readonly Participant[];
}): string {
  const { finalResponses, participants } = params;
  const blocks = finalResponses.map((r) => {
    const p = participants.find((x) => x.id === r.participantId);
    const label = p
      ? `${p.persona.name} (${p.modelId})`
      : r.participantId;
    const body = r.content.replace(/\nCONFIDENCE:\s*\d+\s*$/i, "").trim();
    return `### ${label} — self-reported confidence ${r.confidence}%\n${body}`;
  });
  return `Below are the final-round responses from every participant. Synthesize them per your instructions.\n\n${blocks.join("\n\n---\n\n")}`;
}
