import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Persona
// ─────────────────────────────────────────────────────────────

export const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  emoji: z.string().optional(),
  color: z.string().optional(),
  description: z.string(),
  systemPrompt: z.string().min(1),
});

export type Persona = z.infer<typeof PersonaSchema>;

// ─────────────────────────────────────────────────────────────
// Participant
// ─────────────────────────────────────────────────────────────

export const ParticipantSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  persona: PersonaSchema,
  label: z.string().optional(),
});

export type Participant = z.infer<typeof ParticipantSchema>;

// ─────────────────────────────────────────────────────────────
// Phases
// ─────────────────────────────────────────────────────────────

export const PHASES = [
  "initial-analysis",
  "counterarguments",
  "evidence-assessment",
  "synthesis",
] as const;

export type Phase = (typeof PHASES)[number];

// ─────────────────────────────────────────────────────────────
// Token usage (reported by a ModelCaller if it has the data)
// ─────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ─────────────────────────────────────────────────────────────
// ModelCaller — the one extension point of the library
// ─────────────────────────────────────────────────────────────

export interface ModelCallRequest {
  /** Participant that originated the request, or "judge" for the synthesizer. */
  participantId: string;
  /** Opaque provider model id (e.g. "claude-opus-4-5", "gpt-4o"). */
  modelId: string;
  /** 1-based round index. Judge calls use the final round number. */
  round: number;
  /** Phase of this call; "synthesis" is used for the judge. */
  phase: Phase;
  /** Full system prompt (persona + round instructions). */
  system: string;
  /** The user's question (CVP) or synthesis context (judge). */
  user: string;
  /** Sampling temperature hint — 0.7 for participants, 0.3 for judge. */
  temperature: number;
  /** Maximum output token hint. */
  maxOutputTokens: number;
  /** Propagates cancellation. Honor this. */
  signal?: AbortSignal;
  /** Optional streaming sink; callers MAY call this with partial tokens. */
  onToken?: (token: string) => void;
}

export interface ModelCallResponse {
  /** Full assistant content, including the trailing `CONFIDENCE: N` line. */
  content: string;
  /** Optional token usage, if the provider surfaces it. */
  usage?: TokenUsage;
}

export type ModelCaller = (request: ModelCallRequest) => Promise<ModelCallResponse>;

// ─────────────────────────────────────────────────────────────
// Per-participant response
// ─────────────────────────────────────────────────────────────

export interface ParticipantResponse {
  participantId: string;
  modelId: string;
  personaId: string;
  round: number;
  phase: Phase;
  content: string;
  /** 0-100, parsed from the `CONFIDENCE: N` trailing line. Defaults to 50 if absent. */
  confidence: number;
  /** If the ModelCaller threw or reported an error, present and non-empty. Responses with errors are excluded from consensus score and disagreement detection. */
  error?: string;
  usage?: TokenUsage;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// Disagreement (confidence-split heuristic)
// ─────────────────────────────────────────────────────────────

export interface Disagreement {
  /** Stable id: `r<round>-<a>-<b>`. */
  id: string;
  round: number;
  participantAId: string;
  participantBId: string;
  /** Absolute confidence delta (0-100). */
  severity: number;
  /** Short human label (e.g. "Risk Analyst vs Optimistic Futurist"). */
  label: string;
}

// ─────────────────────────────────────────────────────────────
// Round result
// ─────────────────────────────────────────────────────────────

export interface RoundResult {
  round: number;
  phase: Phase;
  label: string;
  blind: boolean;
  responses: ParticipantResponse[];
  averageConfidence: number;
  stddev: number;
  /** Consensus score: `round(clamp(avg - 0.5 * stddev, 0, 100))`. */
  score: number;
  disagreements: Disagreement[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// Synthesis (judge) result
// ─────────────────────────────────────────────────────────────

export interface SynthesisResult {
  modelId: string;
  content: string;
  majorityPosition: string;
  minorityPositions: string;
  unresolvedDisputes: string;
  /** 0-100, from the `JUDGE_CONFIDENCE: N` trailing line. Defaults to 50 if absent. */
  judgeConfidence: number;
  usage?: TokenUsage;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// Final consensus result
// ─────────────────────────────────────────────────────────────

export type StopReason = "max-rounds" | "converged" | "aborted";

export interface ConsensusResult {
  question: string;
  participants: Participant[];
  rounds: RoundResult[];
  roundsCompleted: number;
  finalScore: number;
  finalAverageConfidence: number;
  finalStddev: number;
  stopReason: StopReason;
  earlyStop?: {
    round: number;
    delta: number;
    reason: string;
  };
  synthesis?: SynthesisResult;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// Engine options
// ─────────────────────────────────────────────────────────────

export interface ConsensusOptions {
  /** The question/prompt to run consensus on. Required, non-empty. */
  question: string;
  /** Ordered list of participants. At least two are required. */
  participants: Participant[];
  /** Max number of rounds. Bounded to [1, 10]. Defaults to 4. */
  maxRounds?: number;
  /** Enable early stopping when |Δscore| ≤ `convergenceDelta`. Defaults to true. */
  earlyStop?: boolean;
  /** Convergence threshold (consensus-score delta). Defaults to 3. */
  convergenceDelta?: number;
  /** Confidence-delta threshold for disagreement detection. Defaults to 20. */
  disagreementThreshold?: number;
  /** Run round 1 in parallel with no cross-visibility. Defaults to true. */
  blindFirstRound?: boolean;
  /** Shuffle speaking order on rounds 2+. Defaults to true. */
  randomizeOrder?: boolean;
  /** Temperature for participant calls. Defaults to 0.7. */
  participantTemperature?: number;
  /** Max output tokens per participant call. Defaults to 1500. */
  maxOutputTokens?: number;
  /** Optional judge synthesis. If provided, runs after the final round. */
  judge?: {
    /** Judge model id (passed to the ModelCaller). */
    modelId: string;
    /** Optional override. If omitted, the engine's default ModelCaller is used. */
    caller?: ModelCaller;
    /** Temperature for judge. Defaults to 0.3. */
    temperature?: number;
    /** Max output tokens for judge. Defaults to 1500. */
    maxOutputTokens?: number;
  };
  /** Non-negative integer. If set, uses a seeded PRNG so round-order randomization is deterministic. */
  randomSeed?: number;
  /** Propagates cancellation to every ModelCaller and aborts the loop. */
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────
// Engine event payloads
// ─────────────────────────────────────────────────────────────

export interface RoundStartEvent {
  round: number;
  phase: Phase;
  label: string;
  blind: boolean;
  participantIds: string[];
}

export interface ParticipantStartEvent {
  round: number;
  phase: Phase;
  participantId: string;
  modelId: string;
  personaId: string;
}

export interface ParticipantTokenEvent {
  round: number;
  participantId: string;
  token: string;
}

export interface ParticipantCompleteEvent {
  round: number;
  phase: Phase;
  response: ParticipantResponse;
}

export interface ConfidenceUpdateEvent {
  round: number;
  participantId: string;
  confidence: number;
  /** Running mean of all confidences seen so far in this round (including this one). */
  runningAverage: number;
}

export interface DisagreementDetectedEvent {
  round: number;
  disagreement: Disagreement;
}

export interface RoundCompleteEvent {
  round: number;
  phase: Phase;
  averageConfidence: number;
  stddev: number;
  score: number;
  disagreements: Disagreement[];
  responses: ParticipantResponse[];
  durationMs: number;
}

export interface EarlyStopEvent {
  round: number;
  delta: number;
  reason: string;
}

export interface SynthesisStartEvent {
  modelId: string;
}

export interface SynthesisTokenEvent {
  token: string;
}

export interface SynthesisCompleteEvent {
  synthesis: SynthesisResult;
}

export interface FinalResultEvent {
  result: ConsensusResult;
}

// ─────────────────────────────────────────────────────────────
// Event map (for typed EventEmitter)
// ─────────────────────────────────────────────────────────────

export interface ConsensusEventMap {
  roundStart: (event: RoundStartEvent) => void;
  participantStart: (event: ParticipantStartEvent) => void;
  participantToken: (event: ParticipantTokenEvent) => void;
  participantComplete: (event: ParticipantCompleteEvent) => void;
  confidenceUpdate: (event: ConfidenceUpdateEvent) => void;
  disagreementDetected: (event: DisagreementDetectedEvent) => void;
  roundComplete: (event: RoundCompleteEvent) => void;
  earlyStop: (event: EarlyStopEvent) => void;
  synthesisStart: (event: SynthesisStartEvent) => void;
  synthesisToken: (event: SynthesisTokenEvent) => void;
  synthesisComplete: (event: SynthesisCompleteEvent) => void;
  finalResult: (event: FinalResultEvent) => void;
  error: (error: Error) => void;
}

export type ConsensusEventName = keyof ConsensusEventMap;
