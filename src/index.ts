// ─────────────────────────────────────────────────────────────
// ai-consensus-core — public API
// ─────────────────────────────────────────────────────────────

export {
  ConsensusEngine,
  CONSENSUS_DEFAULTS,
  MAX_ROUNDS_CAP,
  MAX_TOOL_ITERATIONS_CAP,
} from "./engine.js";

export { JUDGE_PERSONA } from "./personas.js";

export {
  buildParticipantSystemPrompt,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  formatPreviousResponses,
  getRoundMeta,
} from "./prompts.js";

export {
  extractConfidence,
  extractJudgeConfidence,
  extractJudgeSection,
  stripConfidenceLine,
} from "./parser.js";

/** @deprecated Use extractConfidence (same semantics since 0.13). */
export { extractTrailingConfidence } from "./parser.js";

export {
  average,
  stddev,
  consensusScore,
  detectDisagreements,
  shuffle,
  mulberry32,
} from "./stats.js";

export { TypedEventEmitter } from "./events.js";
export type { ConsensusEmitter } from "./events.js";

// Schemas (zod) — exported for callers that want boundary validation.
export { PersonaSchema, ParticipantSchema, ToolDefinitionSchema, PHASES } from "./types.js";

// Types
export type {
  Persona,
  Participant,
  Phase,
  TokenUsage,
  ModelCaller,
  ModelCallRequest,
  ModelCallResponse,
  ParticipantResponse,
  Disagreement,
  RoundResult,
  SynthesisResult,
  ConsensusResult,
  ConsensusOptions,
  StopReason,
  // Tool calling
  ToolDefinition,
  ToolCall,
  ToolCallTurn,
  ToolCallContext,
  ToolExecutionResult,
  ToolExecutor,
  // Events
  ConsensusEventMap,
  ConsensusEventName,
  RoundStartEvent,
  ParticipantStartEvent,
  ParticipantTokenEvent,
  ParticipantCompleteEvent,
  ConfidenceUpdateEvent,
  DisagreementDetectedEvent,
  RoundCompleteEvent,
  EarlyStopEvent,
  SynthesisStartEvent,
  SynthesisTokenEvent,
  SynthesisCompleteEvent,
  FinalResultEvent,
  ToolCallStartEvent,
  ToolCallCompleteEvent,
  ToolErrorEvent,
} from "./types.js";

// ── Attempt adjudication (0.13) ─────────────────────────────

export {
  AdjudicationEngine,
  ADJUDICATION_DEFAULTS,
  MAX_ADJUDICATION_ROUNDS,
  MAX_ADJUDICATION_CANDIDATES,
  buildAdjudicationJudgeUserPrompt,
} from "./adjudication.js";

export {
  CANDIDATE_LABELS,
  SEVERITY_WEIGHT,
  bordaCount,
  kendallW,
  findingWeights,
  rankCandidates,
  decideVerdict,
  computeDissent,
} from "./aggregation.js";
export type { VerdictDecision } from "./aggregation.js";

export {
  DEFAULT_MIN_QUOTE_LENGTH,
  normalizeQuote,
  stripDiffMarkers,
  quoteAppearsIn,
  verifyFindings,
  mergeFindings,
} from "./verification.js";

export {
  buildJurorSystemPrompt,
  buildJurorUserPrompt,
  buildJurorVerdictJsonSchema,
  parseJurorVerdict,
} from "./juror.js";
export type {
  ParsedJurorVerdict,
  JurorParseResult,
  PresentedCandidate,
  VerdictForRebuttal,
} from "./juror.js";

export {
  CandidateCheckSchema,
  AdjudicationCandidateSchema,
  CHECK_STATUSES,
  FINDING_SEVERITIES,
} from "./types.js";

export type {
  CheckStatus,
  CandidateCheck,
  AdjudicationCandidate,
  FindingSeverity,
  AdjudicationFinding,
  VerifiedFinding,
  JurorVerdictStatus,
  JurorVerdict,
  RankedCandidate,
  AdjudicationAgreement,
  NoClearWinnerReason,
  AdjudicationStopReason,
  AdjudicationRound,
  AdjudicationUsage,
  AdjudicationResult,
  AdjudicationBudget,
  AdjudicationOptions,
  AdjudicationEventMap,
  AdjudicationEventName,
  AdjudicationRoundStartEvent,
  JurorStartEvent,
  JurorTokenEvent,
  JurorCompleteEvent,
  AdjudicationRoundCompleteEvent,
  RebuttalTriggeredEvent,
  BudgetStopEvent,
  AdjudicationFinalEvent,
} from "./types.js";

// ── Claim extraction and cost cap (ported from Roundtable, 0.13) ──

export {
  CLAIM_EXTRACTOR_SYSTEM_PROMPT,
  buildClaimExtractorUserPrompt,
  parseClaimsJSON,
  extractClaims,
} from "./claims.js";
export { CostCapExceededError, assertWithinCostCap } from "./budget.js";
export type { ClaimContradiction, ClaimDigest, CostCap } from "./types.js";
