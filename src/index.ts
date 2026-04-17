// ─────────────────────────────────────────────────────────────
// @entropyvortex/consensus-core — public API
// ─────────────────────────────────────────────────────────────

export { ConsensusEngine, CONSENSUS_DEFAULTS, MAX_ROUNDS_CAP } from "./engine.js";

export {
  PERSONAS,
  JUDGE_PERSONA,
  getPersonaById,
  getPersonaOrDefault,
} from "./personas.js";

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
export { PersonaSchema, ParticipantSchema, PHASES } from "./types.js";

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
} from "./types.js";
