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
  ModelCallRequest,
  ModelCallResponse,
  ModelCaller,
  Participant,
  ParticipantResponse,
  Phase,
  RoundResult,
  StopReason,
  SynthesisResult,
  ToolCall,
  ToolCallContext,
  ToolCallTurn,
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutor,
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
  maxToolIterations: 8,
} as const;

const MAX_ROUNDS_CAP = 10;
const MIN_PARTICIPANTS = 2;
const MAX_TOOL_ITERATIONS_CAP = 32;
const TOOL_RESULT_PREVIEW_CHARS = 200;

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
          toolExecutor: opts.toolExecutor,
          maxToolIterations: opts.maxToolIterations,
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
          judgeSystemPrompt: opts.judge.systemPrompt ?? JUDGE_PERSONA.systemPrompt,
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
    toolExecutor: ToolExecutor | undefined;
    maxToolIterations: number;
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
      toolExecutor,
      maxToolIterations,
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
          toolExecutor,
          maxToolIterations,
        }),
      );
      return Promise.all(promises);
    }

    const collected: ParticipantResponse[] = [];
    for (const participant of order) {
      throwIfAborted(signal);
      const visible = [...previousResponses, ...collected];
      const confidencesSoFar = collected.filter((r) => !r.error).map((r) => r.confidence);
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
        toolExecutor,
        maxToolIterations,
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
    toolExecutor: ToolExecutor | undefined;
    maxToolIterations: number;
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
      toolExecutor,
      maxToolIterations,
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
      const turn = await this.#runParticipantTurn({
        participant,
        round,
        phase,
        system,
        question,
        temperature,
        maxOutputTokens,
        signal,
        toolExecutor,
        maxToolIterations,
      });
      content = turn.content;
      usage = turn.usage;
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

  // ── Participant turn (handles the tool-call loop) ────────

  /**
   * Runs a participant's turn end-to-end. When `toolExecutor` is provided
   * AND the participant declares tools AND the model returns tool-call
   * requests, the engine loops:
   *   1. Dispatch each tool call to the executor.
   *   2. Append the (calls, results) pair to `toolCallTurns`.
   *   3. Re-invoke the caller with the accumulated history.
   *   4. Repeat until the response carries no tool calls or `maxToolIterations`
   *      is exceeded.
   *
   * Without an executor, this runs exactly one model call — preserving the
   * 0.10 single-call behaviour byte-for-byte.
   *
   * Token usage from each iteration is summed; the final response's
   * `content` is what becomes the participant's turn output.
   */
  async #runParticipantTurn(args: {
    participant: Participant;
    round: number;
    phase: Phase;
    system: string;
    question: string;
    temperature: number;
    maxOutputTokens: number;
    signal: AbortSignal | undefined;
    toolExecutor: ToolExecutor | undefined;
    maxToolIterations: number;
  }): Promise<{ content: string; usage: ParticipantResponse["usage"] }> {
    const {
      participant,
      round,
      phase,
      system,
      question,
      temperature,
      maxOutputTokens,
      signal,
      toolExecutor,
      maxToolIterations,
    } = args;

    const tools: readonly ToolDefinition[] | undefined =
      participant.tools && participant.tools.length > 0 ? participant.tools : undefined;
    const useToolLoop = Boolean(toolExecutor) && tools !== undefined;

    const toolCallTurns: ToolCallTurn[] = [];
    let mergedUsage: ParticipantResponse["usage"];
    let lastResponse: ModelCallResponse | undefined;
    let iter = 0;

    while (true) {
      const req: ModelCallRequest = {
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
        ...(tools !== undefined ? { tools } : {}),
        ...(toolCallTurns.length > 0
          ? { toolCallTurns: toolCallTurns.map((t) => ({ ...t })) }
          : {}),
      };

      lastResponse = await this.#caller(req);
      mergedUsage = mergeUsage(mergedUsage, lastResponse.usage);

      const calls: readonly ToolCall[] = lastResponse.toolCalls ?? [];
      if (!useToolLoop || calls.length === 0) break;
      if (iter >= maxToolIterations) break;
      iter += 1;

      const results = await this.#dispatchToolCalls({
        participant,
        round,
        phase,
        iteration: iter,
        calls,
        toolExecutor: toolExecutor!,
        signal,
      });
      toolCallTurns.push({ toolCalls: calls, toolResults: results });
    }

    return {
      content: lastResponse?.content ?? "",
      usage: mergedUsage,
    };
  }

  /**
   * Dispatch the tool calls of a single iteration through the host executor.
   * Errors thrown by the executor are caught and converted into
   * `{ error: message }` results so the conversation can continue. Aborts
   * propagate up so the engine's outer abort handling can finalise the run.
   */
  async #dispatchToolCalls(args: {
    participant: Participant;
    round: number;
    phase: Phase;
    iteration: number;
    calls: readonly ToolCall[];
    toolExecutor: ToolExecutor;
    signal: AbortSignal | undefined;
  }): Promise<ToolExecutionResult[]> {
    const { participant, round, phase, iteration, calls, toolExecutor, signal } = args;
    const ctx: ToolCallContext = {
      participantId: participant.id,
      round,
      phase,
      ...(signal ? { signal } : {}),
    };
    const results: ToolExecutionResult[] = [];

    for (const call of calls) {
      throwIfAborted(signal);
      this.emit("toolCallStart", {
        participantId: participant.id,
        round,
        phase,
        iteration,
        call,
      });
      const startedAt = Date.now();
      let result: ToolExecutionResult;
      try {
        result = await toolExecutor(call, ctx);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        result = { error: message };
      }
      results.push(result);

      const ok = !("error" in result);
      const previewSource = ok
        ? "content" in result
          ? result.content
          : ""
        : "error" in result
          ? result.error
          : "";
      const preview = truncate(previewSource, TOOL_RESULT_PREVIEW_CHARS);
      const durationMs = Date.now() - startedAt;

      this.emit("toolCallComplete", {
        participantId: participant.id,
        round,
        phase,
        iteration,
        call,
        durationMs,
        ok,
        preview,
      });
      if (!ok) {
        const error = "error" in result ? result.error : "unknown";
        this.emit("toolError", {
          participantId: participant.id,
          round,
          phase,
          iteration,
          call,
          error,
        });
      }
    }

    return results;
  }

  // ── Judge synthesizer ────────────────────────────────────

  async #runJudge(args: {
    judgeModelId: string;
    judgeCaller: ModelCaller;
    judgeTemperature: number;
    judgeMaxOutputTokens: number;
    judgeSystemPrompt: string;
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
      judgeSystemPrompt,
      finalResponses,
      participants,
      question,
      lastRoundNumber,
      signal,
    } = args;

    this.emit("synthesisStart", { modelId: judgeModelId });

    const system = buildJudgeSystemPrompt({
      judgeSystemPrompt,
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
  toolExecutor: ToolExecutor | undefined;
  maxToolIterations: number;
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
  const maxToolIterations = clampInt(
    options.maxToolIterations ?? DEFAULTS.maxToolIterations,
    1,
    MAX_TOOL_ITERATIONS_CAP,
  );

  return {
    question: options.question,
    participants: options.participants.slice(),
    maxRounds,
    earlyStop: options.earlyStop ?? DEFAULTS.earlyStop,
    convergenceDelta: options.convergenceDelta ?? DEFAULTS.convergenceDelta,
    disagreementThreshold: options.disagreementThreshold ?? DEFAULTS.disagreementThreshold,
    blindFirstRound: options.blindFirstRound ?? DEFAULTS.blindFirstRound,
    randomizeOrder: options.randomizeOrder ?? DEFAULTS.randomizeOrder,
    participantTemperature: options.participantTemperature ?? DEFAULTS.participantTemperature,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    judge: options.judge,
    randomSeed: options.randomSeed,
    signal: options.signal,
    toolExecutor: options.toolExecutor,
    maxToolIterations,
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
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function mergeUsage(
  acc: ParticipantResponse["usage"],
  next: ParticipantResponse["usage"],
): ParticipantResponse["usage"] {
  if (!next) return acc;
  if (!acc) return next;
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    totalTokens: acc.totalTokens + next.totalTokens,
  };
}

function truncate(s: string, n: number): string {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export { DEFAULTS as CONSENSUS_DEFAULTS, MAX_ROUNDS_CAP, MAX_TOOL_ITERATIONS_CAP };
