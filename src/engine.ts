// ─────────────────────────────────────────────────────────────
// ConsensusEngine — CVP orchestrator
// ─────────────────────────────────────────────────────────────
// Drives the full protocol: round scheduling, phase prompts,
// blind/sequential dispatch, confidence extraction, stats,
// disagreement detection, early stopping, optional judge synthesis.
//
// Zero LLM-provider coupling. A `ModelCaller` is the single
// extension point — see `types.ts`.

import { TypedEventEmitter } from "./events.js";
import { JUDGE_PERSONA } from "./personas.js";
import {
  extractConfidence,
  extractJudgeConfidence,
  extractJudgeSection,
} from "./parser.js";
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  buildParticipantSystemPrompt,
  getRoundMeta,
} from "./prompts.js";
import {
  average,
  consensusScore,
  detectDisagreements,
  mulberry32,
  shuffle,
  stddev,
} from "./stats.js";
import type {
  ConsensusEventMap,
  ConsensusOptions,
  ConsensusResult,
  Disagreement,
  ModelCaller,
  Participant,
  ParticipantResponse,
  Phase,
  RoundResult,
  StopReason,
  SynthesisResult,
} from "./types.js";

// ── Defaults ───────────────────────────────────────────────

const DEFAULTS = {
  maxRounds: 4,
  earlyStop: true,
  convergenceDelta: 3,
  disagreementThreshold: 20,
  blindFirstRound: true,
  randomizeOrder: true,
  participantTemperature: 0.7,
  maxOutputTokens: 1500,
  judgeTemperature: 0.3,
  judgeMaxOutputTokens: 1500,
} as const;

const MAX_ROUNDS_CAP = 10;
const MIN_PARTICIPANTS = 2;

// ── Public engine ──────────────────────────────────────────

export class ConsensusEngine extends TypedEventEmitter<ConsensusEventMap> {
  readonly #caller: ModelCaller;

  constructor(caller: ModelCaller) {
    super();
    this.#caller = caller;
  }

  /**
   * Run the Consensus Validation Protocol end-to-end.
   *
   * Emits events throughout (see {@link ConsensusEventMap}). Resolves with the
   * final {@link ConsensusResult}. Rejects only on `AbortError` from a
   * cancelled run — per-participant ModelCaller failures are captured into
   * the per-response `error` field and do not abort the loop.
   */
  async run(options: ConsensusOptions): Promise<ConsensusResult> {
    const opts = normalizeOptions(options);
    const startedAt = Date.now();
    const rng = opts.randomSeed !== undefined ? mulberry32(opts.randomSeed) : Math.random;

    const allResponses: ParticipantResponse[] = [];
    const rounds: RoundResult[] = [];
    const roundScores: number[] = [];
    let stopReason: StopReason = "max-rounds";
    let earlyStopInfo: ConsensusResult["earlyStop"] | undefined;

    try {
      for (let round = 1; round <= opts.maxRounds; round++) {
        throwIfAborted(opts.signal);

        const { phase, label } = getRoundMeta(round, opts.maxRounds);
        const blind = round === 1 && opts.blindFirstRound;

        const order =
          !blind && opts.randomizeOrder && round > 1
            ? shuffle(opts.participants, rng)
            : opts.participants.slice();

        this.emit("roundStart", {
          round,
          phase,
          label,
          blind,
          participantIds: order.map((p) => p.id),
        });

        const roundStartedAt = Date.now();
        const previousResponses = allResponses.filter((r) => r.round < round);
        const roundResponses = await this.#runRound({
          round,
          phase,
          blind,
          order,
          previousResponses,
          totalRounds: opts.maxRounds,
          question: opts.question,
          temperature: opts.participantTemperature,
          maxOutputTokens: opts.maxOutputTokens,
          signal: opts.signal,
        });

        const roundCompletedAt = Date.now();
        allResponses.push(...roundResponses);

        const scored = roundResponses.filter((r) => !r.error);
        const confidences = scored.map((r) => r.confidence);
        const avg = average(confidences);
        const sd = stddev(confidences);
        const score = consensusScore(confidences);
        roundScores.push(score);

        const disagreements = detectDisagreements({
          round,
          responses: roundResponses,
          participants: opts.participants,
          threshold: opts.disagreementThreshold,
        });
        for (const d of disagreements) {
          this.emit("disagreementDetected", { round, disagreement: d });
        }

        const roundResult: RoundResult = {
          round,
          phase,
          label,
          blind,
          responses: roundResponses,
          averageConfidence: avg,
          stddev: sd,
          score,
          disagreements,
          startedAt: roundStartedAt,
          completedAt: roundCompletedAt,
          durationMs: roundCompletedAt - roundStartedAt,
        };
        rounds.push(roundResult);

        this.emit("roundComplete", {
          round,
          phase,
          averageConfidence: avg,
          stddev: sd,
          score,
          disagreements,
          responses: roundResponses,
          durationMs: roundResult.durationMs,
        });

        if (
          opts.earlyStop &&
          round >= 2 &&
          round < opts.maxRounds &&
          roundScores.length >= 2
        ) {
          const prev = roundScores[roundScores.length - 2]!;
          const delta = Math.abs(score - prev);
          if (delta <= opts.convergenceDelta) {
            const reason = `Consensus score delta ${delta.toFixed(1)} between rounds ${round - 1} and ${round} is at or below the convergence threshold (${opts.convergenceDelta}).`;
            earlyStopInfo = { round, delta, reason };
            stopReason = "converged";
            this.emit("earlyStop", { round, delta, reason });
            break;
          }
        }
      }

      // Judge synthesis (optional)
      const lastRound = rounds[rounds.length - 1];
      let synthesis: SynthesisResult | undefined;
      if (opts.judge && lastRound) {
        throwIfAborted(opts.signal);
        synthesis = await this.#runJudge({
          judgeModelId: opts.judge.modelId,
          judgeCaller: opts.judge.caller ?? this.#caller,
          judgeTemperature: opts.judge.temperature ?? DEFAULTS.judgeTemperature,
          judgeMaxOutputTokens:
            opts.judge.maxOutputTokens ?? DEFAULTS.judgeMaxOutputTokens,
          finalResponses: lastRound.responses,
          participants: opts.participants,
          question: opts.question,
          lastRoundNumber: lastRound.round,
          signal: opts.signal,
        });
      }

      const completedAt = Date.now();
      const finalConfidences = lastRound
        ? lastRound.responses.filter((r) => !r.error).map((r) => r.confidence)
        : [];

      const result: ConsensusResult = {
        question: opts.question,
        participants: opts.participants,
        rounds,
        roundsCompleted: rounds.length,
        finalScore: lastRound?.score ?? 0,
        finalAverageConfidence: average(finalConfidences),
        finalStddev: stddev(finalConfidences),
        stopReason,
        earlyStop: earlyStopInfo,
        synthesis,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      };

      this.emit("finalResult", { result });
      return result;
    } catch (err) {
      if (isAbortError(err)) {
        const completedAt = Date.now();
        const lastRound = rounds[rounds.length - 1];
        const finalConfidences = lastRound
          ? lastRound.responses.filter((r) => !r.error).map((r) => r.confidence)
          : [];
        const result: ConsensusResult = {
          question: opts.question,
          participants: opts.participants,
          rounds,
          roundsCompleted: rounds.length,
          finalScore: lastRound?.score ?? 0,
          finalAverageConfidence: average(finalConfidences),
          finalStddev: stddev(finalConfidences),
          stopReason: "aborted",
          earlyStop: earlyStopInfo,
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
        };
        this.emit("finalResult", { result });
        return result;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      throw error;
    }
  }

  // ── Round orchestration ──────────────────────────────────

  async #runRound(args: {
    round: number;
    phase: Phase;
    blind: boolean;
    order: readonly Participant[];
    previousResponses: readonly ParticipantResponse[];
    totalRounds: number;
    question: string;
    temperature: number;
    maxOutputTokens: number;
    signal: AbortSignal | undefined;
  }): Promise<ParticipantResponse[]> {
    const {
      round,
      phase,
      blind,
      order,
      previousResponses,
      totalRounds,
      question,
      temperature,
      maxOutputTokens,
      signal,
    } = args;

    if (blind) {
      const promises = order.map((participant) =>
        this.#callParticipant({
          participant,
          round,
          phase,
          totalRounds,
          question,
          previousResponses: [],
          temperature,
          maxOutputTokens,
          signal,
          runningConfidences: [],
        }),
      );
      return Promise.all(promises);
    }

    const collected: ParticipantResponse[] = [];
    for (const participant of order) {
      throwIfAborted(signal);
      const visible = [...previousResponses, ...collected];
      const confidencesSoFar = collected
        .filter((r) => !r.error)
        .map((r) => r.confidence);
      const response = await this.#callParticipant({
        participant,
        round,
        phase,
        totalRounds,
        question,
        previousResponses: visible,
        temperature,
        maxOutputTokens,
        signal,
        runningConfidences: confidencesSoFar,
      });
      collected.push(response);
    }
    return collected;
  }

  // ── Single participant call ──────────────────────────────

  async #callParticipant(args: {
    participant: Participant;
    round: number;
    phase: Phase;
    totalRounds: number;
    question: string;
    previousResponses: readonly ParticipantResponse[];
    temperature: number;
    maxOutputTokens: number;
    signal: AbortSignal | undefined;
    runningConfidences: readonly number[];
  }): Promise<ParticipantResponse> {
    const {
      participant,
      round,
      phase,
      totalRounds,
      question,
      previousResponses,
      temperature,
      maxOutputTokens,
      signal,
      runningConfidences,
    } = args;

    const system = buildParticipantSystemPrompt({
      personaSystemPrompt: participant.persona.systemPrompt,
      phase,
      round,
      totalRounds,
      previousResponses,
    });

    this.emit("participantStart", {
      round,
      phase,
      participantId: participant.id,
      modelId: participant.modelId,
      personaId: participant.persona.id,
    });

    const startedAt = Date.now();
    let content = "";
    let error: string | undefined;
    let usage: ParticipantResponse["usage"];

    try {
      const result = await this.#caller({
        participantId: participant.id,
        modelId: participant.modelId,
        round,
        phase,
        system,
        user: question,
        temperature,
        maxOutputTokens,
        signal,
        onToken: (token) => {
          this.emit("participantToken", {
            round,
            participantId: participant.id,
            token,
          });
        },
      });
      content = result.content;
      usage = result.usage;
    } catch (err) {
      if (isAbortError(err)) throw err;
      error = err instanceof Error ? err.message : String(err);
      content = content || `[Error from ${participant.modelId}: ${error}]`;
    }

    const completedAt = Date.now();
    const confidence = error ? 0 : extractConfidence(content);

    const response: ParticipantResponse = {
      participantId: participant.id,
      modelId: participant.modelId,
      personaId: participant.persona.id,
      round,
      phase,
      content,
      confidence,
      error,
      usage,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };

    this.emit("participantComplete", { round, phase, response });

    if (!error) {
      const withSelf = [...runningConfidences, confidence];
      this.emit("confidenceUpdate", {
        round,
        participantId: participant.id,
        confidence,
        runningAverage: average(withSelf),
      });
    }

    return response;
  }

  // ── Judge synthesizer ────────────────────────────────────

  async #runJudge(args: {
    judgeModelId: string;
    judgeCaller: ModelCaller;
    judgeTemperature: number;
    judgeMaxOutputTokens: number;
    finalResponses: readonly ParticipantResponse[];
    participants: readonly Participant[];
    question: string;
    lastRoundNumber: number;
    signal: AbortSignal | undefined;
  }): Promise<SynthesisResult> {
    const {
      judgeModelId,
      judgeCaller,
      judgeTemperature,
      judgeMaxOutputTokens,
      finalResponses,
      participants,
      question,
      lastRoundNumber,
      signal,
    } = args;

    this.emit("synthesisStart", { modelId: judgeModelId });

    const system = buildJudgeSystemPrompt({
      judgeSystemPrompt: JUDGE_PERSONA.systemPrompt,
      question,
    });
    const user = buildJudgeUserPrompt({
      finalResponses,
      participants,
    });

    const startedAt = Date.now();
    let content = "";
    let usage: SynthesisResult["usage"];

    try {
      const result = await judgeCaller({
        participantId: "judge",
        modelId: judgeModelId,
        round: lastRoundNumber,
        phase: "synthesis",
        system,
        user,
        temperature: judgeTemperature,
        maxOutputTokens: judgeMaxOutputTokens,
        signal,
        onToken: (token) => {
          this.emit("synthesisToken", { token });
        },
      });
      content = result.content;
      usage = result.usage;
    } catch (err) {
      if (isAbortError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      content = content || `[Judge error from ${judgeModelId}: ${msg}]`;
    }

    const completedAt = Date.now();

    const synthesis: SynthesisResult = {
      modelId: judgeModelId,
      content,
      majorityPosition: extractJudgeSection(content, "Majority Position"),
      minorityPositions: extractJudgeSection(content, "Minority Positions"),
      unresolvedDisputes: extractJudgeSection(content, "Unresolved Disputes"),
      judgeConfidence: extractJudgeConfidence(content),
      usage,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };

    this.emit("synthesisComplete", { synthesis });
    return synthesis;
  }
}

// ── Helpers ─────────────────────────────────────────────────

interface NormalizedOptions {
  question: string;
  participants: Participant[];
  maxRounds: number;
  earlyStop: boolean;
  convergenceDelta: number;
  disagreementThreshold: number;
  blindFirstRound: boolean;
  randomizeOrder: boolean;
  participantTemperature: number;
  maxOutputTokens: number;
  judge: ConsensusOptions["judge"];
  randomSeed: number | undefined;
  signal: AbortSignal | undefined;
}

function normalizeOptions(options: ConsensusOptions): NormalizedOptions {
  if (!options.question || options.question.trim().length === 0) {
    throw new Error("ConsensusEngine: `question` must be a non-empty string.");
  }
  if (!Array.isArray(options.participants) || options.participants.length < MIN_PARTICIPANTS) {
    throw new Error(
      `ConsensusEngine: at least ${MIN_PARTICIPANTS} participants are required (got ${
        options.participants?.length ?? 0
      }).`,
    );
  }
  const ids = new Set<string>();
  for (const p of options.participants) {
    if (ids.has(p.id)) {
      throw new Error(`ConsensusEngine: duplicate participant id "${p.id}".`);
    }
    ids.add(p.id);
  }

  const maxRounds = clampInt(options.maxRounds ?? DEFAULTS.maxRounds, 1, MAX_ROUNDS_CAP);

  return {
    question: options.question,
    participants: options.participants.slice(),
    maxRounds,
    earlyStop: options.earlyStop ?? DEFAULTS.earlyStop,
    convergenceDelta: options.convergenceDelta ?? DEFAULTS.convergenceDelta,
    disagreementThreshold: options.disagreementThreshold ?? DEFAULTS.disagreementThreshold,
    blindFirstRound: options.blindFirstRound ?? DEFAULTS.blindFirstRound,
    randomizeOrder: options.randomizeOrder ?? DEFAULTS.randomizeOrder,
    participantTemperature:
      options.participantTemperature ?? DEFAULTS.participantTemperature,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    judge: options.judge,
    randomSeed: options.randomSeed,
    signal: options.signal,
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new DOMException("Aborted", "AbortError");
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) || (
    err instanceof Error && err.name === "AbortError"
  );
}

export { DEFAULTS as CONSENSUS_DEFAULTS, MAX_ROUNDS_CAP };
