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
  /**
   * Tools this participant is allowed to invoke during its turn. The library
   * forwards the list to the ModelCaller verbatim — semantics (dispatch,
   * loop, error handling) live in the engine when `ConsensusOptions.toolExecutor`
   * is provided. Empty/undefined ⇒ classic text-only debate (0.10 behaviour).
   */
  tools: z.array(z.lazy(() => ToolDefinitionSchema)).optional(),
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
// Tool calling
// ─────────────────────────────────────────────────────────────
// Engine-orchestrated tool calling sits between the ModelCaller and the
// host. The library never parses tool arguments, never invokes a tool, and
// never decides what tools a participant has — it just plumbs:
//
//   1. `Participant.tools` flows into each `ModelCallRequest.tools`.
//   2. If the response carries `toolCalls`, the engine dispatches each one
//      to `ConsensusOptions.toolExecutor` (host-supplied) and feeds results
//      back into a follow-up call via `ModelCallRequest.toolCallTurns`.
//   3. The loop terminates when the model returns a response with no
//      `toolCalls`, or when `maxToolIterations` is hit.
//
// Hosts that don't supply a `toolExecutor` see no behaviour change — every
// new field is optional and the engine's flow degrades to 0.10 verbatim.

/** OpenAI-style tool definition (function-call shape). */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /**
   * JSON Schema (object). The library does not validate or interpret the
   * schema — it forwards verbatim to the ModelCaller, which is responsible
   * for translating it into whatever the underlying provider expects.
   */
  parameters: z.unknown(),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/** A tool-call request emitted by an assistant turn. */
export interface ToolCall {
  /** Unique id assigned by the model — round-trip back in tool results. */
  id: string;
  /** Tool name; must match a `ToolDefinition.name` from the request. */
  name: string;
  /**
   * Already JSON-parsed arguments. Callers MUST parse the model's raw
   * argument string before populating this; the library never parses.
   */
  arguments: unknown;
}

/** Result of executing a tool call. Either a content string or an error. */
export type ToolExecutionResult = { content: string } | { error: string };

/**
 * One turn of tool-call dispatch. The engine appends one entry per iteration
 * of the tool loop, in order, and forwards the accumulated history on each
 * follow-up `ModelCallRequest`.
 */
export interface ToolCallTurn {
  /** The tool calls the assistant requested in this turn. */
  toolCalls: readonly ToolCall[];
  /** Results, in the same order as `toolCalls`. */
  toolResults: readonly ToolExecutionResult[];
}

/** Context passed to the host's `ToolExecutor` so it knows what's running. */
export interface ToolCallContext {
  participantId: string;
  round: number;
  phase: Phase;
  signal?: AbortSignal;
}

/**
 * Host-supplied tool executor. The engine awaits this once per tool call.
 * Throw on unrecoverable errors; return `{ error }` to feed an error string
 * back into the conversation as a normal tool result (model can recover).
 */
export type ToolExecutor = (
  call: ToolCall,
  ctx: ToolCallContext,
) => Promise<ToolExecutionResult>;

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
  /**
   * Tools available for this turn. Forwarded verbatim from `Participant.tools`
   * (and only for participant calls — judge calls never carry tools). Absent
   * when the participant declares no tools.
   */
  tools?: readonly ToolDefinition[];
  /**
   * Tool-call history for this single participant turn, populated by the
   * engine when re-invoking the caller after dispatching tool calls. Each
   * entry is one round-trip through the tool loop. Absent on the first call
   * of a turn.
   *
   * Callers MUST translate this into whatever the provider expects (e.g.
   * for OpenAI, append assistant + tool messages to the conversation).
   */
  toolCallTurns?: readonly ToolCallTurn[];
}

export interface ModelCallResponse {
  /** Full assistant content, including the trailing `CONFIDENCE: N` line. */
  content: string;
  /** Optional token usage, if the provider surfaces it. */
  usage?: TokenUsage;
  /**
   * Tool calls the model wants to dispatch this turn. If non-empty AND the
   * engine has a `toolExecutor`, the engine runs each call and re-invokes
   * the caller with the results in `ModelCallRequest.toolCallTurns`. If empty
   * or absent, the engine treats `content` as the participant's final turn.
   *
   * If the engine has no `toolExecutor` configured but the response carries
   * `toolCalls`, they are ignored and `content` is used as-is — preserves
   * 0.10 backward compatibility for callers that opt into tool streaming
   * but don't wire an executor.
   */
  toolCalls?: readonly ToolCall[];
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
    /**
     * Override the judge system prompt. Defaults to `JUDGE_PERSONA.systemPrompt`.
     *
     * Contract: the override must instruct the model to emit the same four
     * `## Majority Position` / `## Minority Positions` / `## Unresolved Disputes`
     * / `## Synthesis Confidence` headings and a trailing `JUDGE_CONFIDENCE: N`
     * line. `extractJudgeSection` and `extractJudgeConfidence` key off those
     * markers — break the contract and the corresponding fields on
     * `SynthesisResult` will come back empty / default to 50.
     */
    systemPrompt?: string;
  };
  /** Non-negative integer. If set, uses a seeded PRNG so round-order randomization is deterministic. */
  randomSeed?: number;
  /** Propagates cancellation to every ModelCaller and aborts the loop. */
  signal?: AbortSignal;
  /**
   * Host-supplied tool executor. When set, the engine drives the tool-call
   * loop for participants whose `tools` list is non-empty: dispatches each
   * `ToolCall` returned by the model, feeds results back via
   * `ModelCallRequest.toolCallTurns`, and emits `toolCallStart` /
   * `toolCallComplete` / `toolError` events.
   *
   * When omitted, the engine ignores any `toolCalls` in `ModelCallResponse`
   * and treats `content` as the participant's final turn — exact 0.10 behaviour.
   */
  toolExecutor?: ToolExecutor;
  /**
   * Maximum tool-loop iterations per participant turn. After this many
   * round-trips through the executor, the engine breaks out and uses the
   * last response's `content` as the participant's turn — even if the model
   * still wants to call more tools. Defaults to 8. Bounded to [1, 32].
   */
  maxToolIterations?: number;
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

// ── Tool-calling events ─────────────────────────────────────

export interface ToolCallStartEvent {
  participantId: string;
  round: number;
  phase: Phase;
  /** 1-based iteration counter within this participant's tool loop. */
  iteration: number;
  call: ToolCall;
}

export interface ToolCallCompleteEvent {
  participantId: string;
  round: number;
  phase: Phase;
  iteration: number;
  call: ToolCall;
  durationMs: number;
  /** True when the executor returned `{ content }`; false when it returned `{ error }`. */
  ok: boolean;
  /** Truncated preview of the result payload (first 200 chars). */
  preview: string;
}

export interface ToolErrorEvent {
  participantId: string;
  round: number;
  phase: Phase;
  iteration: number;
  call: ToolCall;
  error: string;
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
  toolCallStart: (event: ToolCallStartEvent) => void;
  toolCallComplete: (event: ToolCallCompleteEvent) => void;
  toolError: (event: ToolErrorEvent) => void;
  error: (error: Error) => void;
}

export type ConsensusEventName = keyof ConsensusEventMap;

// ─────────────────────────────────────────────────────────────
// Cost cap (shared by AdjudicationEngine and standalone callers)
// ─────────────────────────────────────────────────────────────

/**
 * Caller-priced spending cap. The library has no price table: `estimateUSD`
 * turns one call's usage into an estimated USD cost, and the running total
 * is compared against `limitUSD`.
 */
export interface CostCap {
  /** Hard ceiling in USD. Must be > 0. */
  limitUSD: number;
  /** Estimated USD cost of a single call. */
  estimateUSD: (modelId: string, usage: TokenUsage) => number;
}

// ─────────────────────────────────────────────────────────────
// Claim-level contradiction extraction
// ─────────────────────────────────────────────────────────────

/**
 * One claim-level contradiction extracted from a completed run. Unlike
 * the confidence-spread `Disagreement`, a claim is a semantic
 * contradiction extracted from the response text.
 */
export interface ClaimContradiction {
  id: string;
  /** One-line summary of what the contradiction is about. */
  claim: string;
  /** Each side lists the participants that took it and a verbatim quote. */
  sides: Array<{
    stance: string;
    participantIds: string[];
    quote: string;
  }>;
}

/** Result of the claim-extraction pass. */
export interface ClaimDigest {
  modelId: string;
  contradictions: ClaimContradiction[];
  /** Raw model output, kept for transparency / fallback rendering. */
  rawContent: string;
  /** Set when the extractor call failed (the digest is then empty). */
  error?: string;
  usage?: TokenUsage;
}

// ─────────────────────────────────────────────────────────────
// Attempt adjudication
// ─────────────────────────────────────────────────────────────
// Judges N candidate solutions to one task: one blind parallel round of
// jurors, deterministic aggregation (Borda + Kendall's W), an optional
// rebuttal round when agreement is low, then the non-voting judge.

export const CHECK_STATUSES = ["passed", "failed", "unknown"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Evidence the caller attaches to a candidate (build, tests, lint…). */
export const CandidateCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(CHECK_STATUSES),
  /** Optional excerpt of the check's output, shown to jurors verbatim. */
  output: z.string().optional(),
});

export type CandidateCheck = z.infer<typeof CandidateCheckSchema>;

export const AdjudicationCandidateSchema = z.object({
  /** Caller's stable id (e.g. a git ref). Never shown to any model. */
  id: z.string().min(1),
  /** The candidate solution, e.g. a unified diff. Shown under a neutral label. */
  content: z.string(),
  checks: z.array(CandidateCheckSchema).optional(),
});

export type AdjudicationCandidate = z.infer<typeof AdjudicationCandidateSchema>;

export const FINDING_SEVERITIES = ["high", "medium", "low"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** A juror finding after label mapping (candidate ids, not juror labels). */
export interface AdjudicationFinding {
  candidateId: string;
  severity: FindingSeverity;
  file: string;
  /** 1-based line, or null when the juror could not tell. Not verified. */
  line: number | null;
  /** Verbatim snippet the juror quoted from the candidate. */
  quote: string;
  issue: string;
}

/** A verified finding, deduplicated across jurors and rounds. */
export interface VerifiedFinding extends AdjudicationFinding {
  /** Juror ids that reported this quote for this candidate and file. */
  reportedBy: string[];
}

export type JurorVerdictStatus = "valid" | "abstained" | "cancelled";

export interface JurorVerdict {
  jurorId: string;
  modelId: string;
  round: number;
  status: JurorVerdictStatus;
  /** Candidate ids, best first. Empty unless `status === "valid"`. */
  ranking: string[];
  /** What this juror saw: label → candidate id, in presentation order. */
  presentation: Array<{ label: string; candidateId: string }>;
  /** Findings whose quote was found in the named candidate's content. */
  verifiedFindings: AdjudicationFinding[];
  /** Findings dropped because the quote was not found (or too short). */
  droppedFindings: AdjudicationFinding[];
  /** One short assessment per candidate the juror chose to summarise. */
  assessments: Array<{ candidateId: string; summary: string }>;
  /** Why the verdict was not counted (malformed output, caller error, …). */
  abstainReason?: string;
  /** Raw model output (empty when the call failed before any content). */
  raw: string;
  usage?: TokenUsage;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface RankedCandidate {
  candidateId: string;
  /** Canonical neutral label (input order A, B, C…). */
  label: string;
  /** 1-based position in the aggregate ranking. */
  rank: number;
  /** Borda points: n-1 for a first place, 0 for a last place, summed over votes. */
  points: number;
  firstPlaceVotes: number;
  /** Severity-weighted count of verified findings (high 3, medium 2, low 1). */
  findingWeight: number;
  /** Names of checks with status "failed". */
  failedChecks: string[];
  /** False when this candidate failed a check and at least one candidate did not. */
  eligible: boolean;
}

export interface AdjudicationAgreement {
  /** Kendall's W over counted votes, or null with fewer than 2 votes. */
  kendallW: number | null;
  threshold: number;
  /** Number of jurors whose latest verdict was valid. */
  votes: number;
}

export type NoClearWinnerReason = "insufficient-votes" | "low-agreement" | "tie" | "incomplete";

export type AdjudicationStopReason = "completed" | "aborted" | "deadline" | "token-budget" | "cost-cap";

export interface AdjudicationRound {
  round: number;
  kind: "blind" | "rebuttal";
  verdicts: JurorVerdict[];
  agreement: AdjudicationAgreement;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface AdjudicationUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Model calls that returned (successfully or not). */
  calls: number;
  /** Calls whose caller reported no usage; their tokens are chars/4 estimates. */
  estimatedCalls: number;
  /** Running USD estimate; present only when a cost cap was configured. */
  costUSD?: number;
}

export interface AdjudicationResult {
  task: string;
  candidates: Array<{ id: string; label: string; checks: CandidateCheck[] }>;
  verdict: "winner" | "no-clear-winner";
  /** Candidate id of the recommended candidate, or null. */
  recommended: string | null;
  /** Top eligible candidate in the aggregate ranking, recommended or not. */
  leader: string | null;
  noClearWinnerReason?: NoClearWinnerReason;
  ranking: RankedCandidate[];
  agreement: AdjudicationAgreement;
  /** Verified findings per candidate, in canonical candidate order. */
  findings: Array<{
    candidateId: string;
    label: string;
    verified: VerifiedFinding[];
    dropped: number;
  }>;
  /** Total findings dropped by quote verification, across all verdicts. */
  droppedFindings: number;
  /** Jurors whose top pick differs from `leader`. */
  dissent: Array<{ jurorId: string; topPick: string }>;
  rounds: AdjudicationRound[];
  synthesis?: SynthesisResult;
  usage: AdjudicationUsage;
  stopReason: AdjudicationStopReason;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface AdjudicationBudget {
  /** Token ceiling across every call (reported usage, else chars/4 estimate). */
  maxTokens?: number;
  /** Wall-clock deadline in ms from the start of `adjudicate()`. */
  deadlineMs?: number;
  /** USD cost cap, priced by the caller. */
  costCap?: CostCap;
}

export interface AdjudicationOptions {
  /** The task every candidate attempted. Required, non-empty. */
  task: string;
  /** 2 to 26 candidates. Ids must be unique. */
  candidates: AdjudicationCandidate[];
  /** At least two jurors. Ids must be unique and must not be "judge". */
  jurors: Participant[];
  /** 1 = blind round only; 2+ allows rebuttal rounds on low agreement. Default 2, max 3. */
  maxRounds?: number;
  /** Kendall's W at or above which a leader may be recommended. Default 0.3. */
  agreementThreshold?: number;
  /** Juror sampling temperature. Default 0.2. */
  jurorTemperature?: number;
  /** Max output tokens per juror call. Default 2000. */
  maxOutputTokens?: number;
  /** Minimum normalized quote length for a finding to count as verified. Default 8. */
  minQuoteLength?: number;
  /** Optional judge synthesis over the jurors' verdicts (never votes). */
  judge?: ConsensusOptions["judge"];
  /** Seeds the per-juror candidate order for deterministic replay. */
  randomSeed?: number;
  signal?: AbortSignal;
  budget?: AdjudicationBudget;
}

// ── Adjudication events ─────────────────────────────────────

export interface AdjudicationRoundStartEvent {
  round: number;
  kind: "blind" | "rebuttal";
  jurorIds: string[];
}

export interface JurorStartEvent {
  round: number;
  jurorId: string;
  modelId: string;
}

export interface JurorTokenEvent {
  round: number;
  jurorId: string;
  token: string;
}

export interface JurorCompleteEvent {
  round: number;
  verdict: JurorVerdict;
}

export interface AdjudicationRoundCompleteEvent {
  round: number;
  agreement: AdjudicationAgreement;
  ranking: RankedCandidate[];
  durationMs: number;
}

export interface RebuttalTriggeredEvent {
  /** The rebuttal round that is about to start. */
  round: number;
  kendallW: number;
  threshold: number;
}

export interface BudgetStopEvent {
  reason: Exclude<AdjudicationStopReason, "completed" | "aborted">;
  usage: AdjudicationUsage;
}

export interface AdjudicationFinalEvent {
  result: AdjudicationResult;
}

export interface AdjudicationEventMap {
  roundStart: (event: AdjudicationRoundStartEvent) => void;
  jurorStart: (event: JurorStartEvent) => void;
  jurorToken: (event: JurorTokenEvent) => void;
  jurorComplete: (event: JurorCompleteEvent) => void;
  roundComplete: (event: AdjudicationRoundCompleteEvent) => void;
  rebuttalTriggered: (event: RebuttalTriggeredEvent) => void;
  synthesisStart: (event: SynthesisStartEvent) => void;
  synthesisToken: (event: SynthesisTokenEvent) => void;
  synthesisComplete: (event: SynthesisCompleteEvent) => void;
  budgetStop: (event: BudgetStopEvent) => void;
  finalResult: (event: AdjudicationFinalEvent) => void;
  error: (error: Error) => void;
}

export type AdjudicationEventName = keyof AdjudicationEventMap;
