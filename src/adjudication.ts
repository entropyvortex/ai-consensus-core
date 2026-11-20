// ─────────────────────────────────────────────────────────────
// AdjudicationEngine — judge N candidate solutions to one task
// ─────────────────────────────────────────────────────────────
// Shape: one blind parallel round of jurors → deterministic
// aggregation (Borda count, Kendall's W) → optional rebuttal rounds
// while agreement is below threshold → optional non-voting judge.
//
// A sibling of ConsensusEngine rather than a method on it: the CVP
// event map, StopReason and result type are debate-specific, so
// adjudication gets its own typed event map and result instead of
// widening those exports. It shares the ModelCaller contract, the
// typed emitter, the seeded shuffle and the judge persona/prompts.

import {
  CANDIDATE_LABELS,
  computeDissent,
  decideVerdict,
  kendallW,
  rankCandidates,
} from "./aggregation.js";
import { TypedEventEmitter } from "./events.js";
import {
  buildJurorSystemPrompt,
  buildJurorUserPrompt,
  parseJurorVerdict,
  type ParsedJurorVerdict,
  type PresentedCandidate,
  type VerdictForRebuttal,
} from "./juror.js";
import { extractJudgeConfidence, extractJudgeSection } from "./parser.js";
import { JUDGE_PERSONA } from "./personas.js";
import { buildJudgeSystemPrompt } from "./prompts.js";
import { mulberry32, shuffle } from "./stats.js";
import {
  CandidateCheckSchema,
  type AdjudicationAgreement,
  type AdjudicationCandidate,
  type AdjudicationEventMap,
  type AdjudicationFinding,
  type AdjudicationOptions,
  type AdjudicationResult,
  type AdjudicationRound,
  type AdjudicationStopReason,
  type AdjudicationUsage,
  type CandidateCheck,
  type CostCap,
  type ModelCaller,
  type ModelCallResponse,
  type Participant,
  type RankedCandidate,
  type SynthesisResult,
  type TokenUsage,
} from "./types.js";
import { DEFAULT_MIN_QUOTE_LENGTH, mergeFindings, verifyFindings } from "./verification.js";

// ── Defaults ───────────────────────────────────────────────

const DEFAULTS = {
  maxRounds: 2,
  agreementThreshold: 0.3,
  jurorTemperature: 0.2,
  maxOutputTokens: 2000,
  minQuoteLength: DEFAULT_MIN_QUOTE_LENGTH,
  judgeTemperature: 0.3,
  judgeMaxOutputTokens: 1500,
} as const;

const MAX_ADJUDICATION_ROUNDS = 3;
const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = CANDIDATE_LABELS.length;
const MIN_JURORS = 2;

// ── Normalized run state ───────────────────────────────────

interface NormalizedCandidate {
  id: string;
  label: string;
  content: string;
  checks: CandidateCheck[];
}

interface NormalizedAdjudication {
  task: string;
  candidates: NormalizedCandidate[];
  jurors: Participant[];
  maxRounds: number;
  agreementThreshold: number;
  jurorTemperature: number;
  maxOutputTokens: number;
  minQuoteLength: number;
  judge: AdjudicationOptions["judge"];
  randomSeed: number | undefined;
  signal: AbortSignal | undefined;
  maxTokens: number | undefined;
  deadlineMs: number | undefined;
  costCap: CostCap | undefined;
}

interface Vote {
  jurorId: string;
  /** Candidate ids, best first. */
  ranking: string[];
  verified: AdjudicationFinding[];
  assessments: Array<{ candidateId: string; summary: string }>;
}

// ── Public engine ──────────────────────────────────────────

export class AdjudicationEngine extends TypedEventEmitter<AdjudicationEventMap> {
  readonly #caller: ModelCaller;

  constructor(caller: ModelCaller) {
    super();
    this.#caller = caller;
  }

  /**
   * Adjudicate the candidates. Resolves with an {@link AdjudicationResult}
   * in every case except invalid options (which throw before any call):
   * caller errors and malformed juror output become abstentions, and an
   * abort, deadline or budget breach returns a partial result with the
   * matching `stopReason`.
   */
  async adjudicate(options: AdjudicationOptions): Promise<AdjudicationResult> {
    const opts = normalizeAdjudicationOptions(options);
    const startedAt = Date.now();
    const rng = opts.randomSeed !== undefined ? mulberry32(opts.randomSeed) : Math.random;

    // Every juror's presentation order is drawn before any call, in juror
    // order, so a seed fixes the whole run regardless of call timing.
    const indices = opts.candidates.map((_, i) => i);
    const presentations = opts.jurors.map(() => shuffle(indices, rng));
    const nonce = Math.floor(rng() * 0x1000000)
      .toString(16)
      .padStart(6, "0");

    const meter = new UsageMeter(opts.maxTokens, opts.costCap);
    const stop = new RunStop(opts.signal, opts.deadlineMs, (reason) => {
      if (reason !== "aborted" && reason !== "completed") {
        this.emit("budgetStop", { reason, usage: meter.snapshot() });
      }
    });

    const rounds: AdjudicationRound[] = [];
    const latest = new Map<string, Vote>();
    const allVerified: Array<{ jurorId: string; finding: AdjudicationFinding }> = [];
    const droppedByCandidate = new Map<string, number>();
    let firstRoundComplete = false;
    let agreement: AdjudicationAgreement = {
      kendallW: null,
      threshold: opts.agreementThreshold,
      votes: 0,
    };
    let synthesis: SynthesisResult | undefined;

    try {
      for (let round = 1; round <= opts.maxRounds; round++) {
        if (stop.cause) break;
        const kind = round === 1 ? "blind" : "rebuttal";
        if (kind === "rebuttal") {
          const w = agreement.kendallW;
          if (w === null || agreement.votes < 2 || w >= opts.agreementThreshold) break;
          this.emit("rebuttalTriggered", { round, kendallW: w, threshold: opts.agreementThreshold });
        }

        const calls = opts.jurors.map((juror, j) => {
          const order = presentations[j] ?? indices;
          const presented: PresentedCandidate[] = order.map((ci, p) => {
            const c = opts.candidates[ci]!;
            return { label: CANDIDATE_LABELS[p]!, content: c.content, checks: c.checks };
          });
          const labelToId = new Map(order.map((ci, p) => [CANDIDATE_LABELS[p]!, opts.candidates[ci]!.id]));
          const idToLabel = new Map([...labelToId].map(([label, id]) => [id, label]));
          const system = buildJurorSystemPrompt({
            personaSystemPrompt: juror.persona.systemPrompt,
            candidateCount: opts.candidates.length,
            kind,
          });
          const user = buildJurorUserPrompt({
            task: opts.task,
            presented,
            nonce,
            ...(kind === "rebuttal"
              ? {
                  rebuttal: {
                    kendallW: agreement.kendallW ?? 0,
                    own: toRebuttalView(latest.get(juror.id), idToLabel),
                    others: [...latest.values()]
                      .filter((v) => v.jurorId !== juror.id)
                      .map((v) => toRebuttalView(v, idToLabel)!),
                  },
                }
              : {}),
          });
          return { juror, system, user, labelToId };
        });

        const breach = meter.wouldBreach(
          calls.map((c) => ({
            modelId: c.juror.modelId,
            inputChars: c.system.length + c.user.length,
            maxOutputTokens: opts.maxOutputTokens,
          })),
        );
        if (breach) {
          stop.trip(breach);
          break;
        }

        const roundStartedAt = Date.now();
        this.emit("roundStart", { round, kind, jurorIds: opts.jurors.map((j) => j.id) });
        const verdicts = await Promise.all(
          calls.map((c) =>
            this.#runJuror({
              ...c,
              round,
              kind,
              opts,
              stop,
              meter,
            }),
          ),
        );
        const roundCompletedAt = Date.now();

        if (round === 1) firstRoundComplete = verdicts.every((v) => v.status !== "cancelled");
        for (const v of verdicts) {
          for (const f of v.verifiedFindings) allVerified.push({ jurorId: v.jurorId, finding: f });
          for (const f of v.droppedFindings) {
            droppedByCandidate.set(f.candidateId, (droppedByCandidate.get(f.candidateId) ?? 0) + 1);
          }
          if (v.status === "valid") {
            latest.set(v.jurorId, {
              jurorId: v.jurorId,
              ranking: v.ranking,
              verified: v.verifiedFindings,
              assessments: v.assessments,
            });
          }
        }

        const ranking = aggregate(opts.candidates, latest, allVerified);
        agreement = {
          kendallW: kendallW(rankingsOf(latest), opts.candidates.map((c) => c.id)),
          threshold: opts.agreementThreshold,
          votes: latest.size,
        };
        rounds.push({
          round,
          kind,
          verdicts,
          agreement,
          startedAt: roundStartedAt,
          completedAt: roundCompletedAt,
          durationMs: roundCompletedAt - roundStartedAt,
        });
        this.emit("roundComplete", {
          round,
          agreement,
          ranking,
          durationMs: roundCompletedAt - roundStartedAt,
        });
      }

      if (opts.judge && !stop.cause && latest.size > 0) {
        const judgeModelId = opts.judge.modelId;
        const system = buildJudgeSystemPrompt({
          judgeSystemPrompt: opts.judge.systemPrompt ?? JUDGE_PERSONA.systemPrompt,
          question: opts.task,
        });
        const user = buildAdjudicationJudgeUserPrompt({
          candidates: opts.candidates,
          ranking: aggregate(opts.candidates, latest, allVerified),
          agreement,
          jurors: opts.jurors,
          rounds,
        });
        const maxOut = opts.judge.maxOutputTokens ?? DEFAULTS.judgeMaxOutputTokens;
        const breach = meter.wouldBreach([
          { modelId: judgeModelId, inputChars: system.length + user.length, maxOutputTokens: maxOut },
        ]);
        if (breach) {
          stop.trip(breach);
        } else {
          synthesis = await this.#runJudge({
            caller: opts.judge.caller ?? this.#caller,
            modelId: judgeModelId,
            system,
            user,
            temperature: opts.judge.temperature ?? DEFAULTS.judgeTemperature,
            maxOutputTokens: maxOut,
            round: rounds.length,
            stop,
            meter,
          });
        }
      }

      const ranking = aggregate(opts.candidates, latest, allVerified);
      const decision = decideVerdict({
        ranking,
        kendallW: agreement.kendallW,
        votes: latest.size,
        threshold: opts.agreementThreshold,
        complete: firstRoundComplete,
      });
      const merged = mergeFindings(allVerified);
      const completedAt = Date.now();
      const result: AdjudicationResult = {
        task: opts.task,
        candidates: opts.candidates.map((c) => ({ id: c.id, label: c.label, checks: c.checks })),
        verdict: decision.verdict,
        recommended: decision.recommended,
        leader: decision.leader,
        ...(decision.reason ? { noClearWinnerReason: decision.reason } : {}),
        ranking,
        agreement,
        findings: opts.candidates.map((c) => ({
          candidateId: c.id,
          label: c.label,
          verified: merged.filter((f) => f.candidateId === c.id),
          dropped: droppedByCandidate.get(c.id) ?? 0,
        })),
        droppedFindings: [...droppedByCandidate.values()].reduce((a, b) => a + b, 0),
        dissent: computeDissent([...latest.values()], decision.leader),
        rounds,
        ...(synthesis ? { synthesis } : {}),
        usage: meter.snapshot(),
        stopReason: stop.cause ?? "completed",
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      };
      this.emit("finalResult", { result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.listenerCount("error") > 0) this.emit("error", error);
      throw error;
    } finally {
      stop.dispose();
    }
  }

  // ── One juror call ───────────────────────────────────────

  async #runJuror(args: {
    juror: Participant;
    system: string;
    user: string;
    labelToId: Map<string, string>;
    round: number;
    kind: "blind" | "rebuttal";
    opts: NormalizedAdjudication;
    stop: RunStop;
    meter: UsageMeter;
  }) {
    const { juror, system, user, labelToId, round, kind, opts, stop, meter } = args;
    const presentation = [...labelToId].map(([label, candidateId]) => ({ label, candidateId }));
    this.emit("jurorStart", { round, jurorId: juror.id, modelId: juror.modelId });
    const startedAt = Date.now();

    let raw = "";
    let usage: TokenUsage | undefined;
    let status: "valid" | "abstained" | "cancelled" = "abstained";
    let abstainReason: string | undefined;
    let parsed: ParsedJurorVerdict | undefined;

    try {
      const response: ModelCallResponse = await raceAbort(
        this.#caller({
          participantId: juror.id,
          modelId: juror.modelId,
          round,
          phase: kind === "blind" ? "initial-analysis" : "counterarguments",
          system,
          user,
          temperature: opts.jurorTemperature,
          maxOutputTokens: opts.maxOutputTokens,
          signal: stop.signal,
          onToken: (token) => {
            this.emit("jurorToken", { round, jurorId: juror.id, token });
          },
        }),
        stop.signal,
      );
      raw = response.content;
      usage = response.usage;
      meter.record(juror.modelId, usage, system.length + user.length, raw.length);
      const result = parseJurorVerdict(raw, [...labelToId.keys()]);
      if (result.ok) {
        status = "valid";
        parsed = result.verdict;
      } else {
        abstainReason = result.reason;
      }
    } catch (err) {
      if (stop.signal.aborted) {
        status = "cancelled";
        abstainReason = `cancelled: ${stop.cause ?? "aborted"}`;
      } else {
        meter.recordFailure();
        abstainReason = `caller error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const breach = meter.breached();
    if (breach) stop.trip(breach);

    const toId = (label: string) => labelToId.get(label)!;
    const findings: AdjudicationFinding[] = (parsed?.findings ?? []).map((f) => ({
      candidateId: toId(f.candidate),
      severity: f.severity,
      file: f.file,
      line: f.line,
      quote: f.quote,
      issue: f.issue,
    }));
    const { verified, dropped } = verifyFindings(findings, opts.candidates, opts.minQuoteLength);
    const completedAt = Date.now();
    const verdict = {
      jurorId: juror.id,
      modelId: juror.modelId,
      round,
      status,
      ranking: parsed ? parsed.ranking.map(toId) : [],
      presentation,
      verifiedFindings: verified,
      droppedFindings: dropped,
      assessments: (parsed?.assessments ?? []).map((a) => ({
        candidateId: toId(a.candidate),
        summary: a.summary,
      })),
      ...(abstainReason !== undefined ? { abstainReason } : {}),
      raw,
      ...(usage ? { usage } : {}),
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };
    this.emit("jurorComplete", { round, verdict });
    return verdict;
  }

  // ── Judge synthesis ──────────────────────────────────────

  async #runJudge(args: {
    caller: ModelCaller;
    modelId: string;
    system: string;
    user: string;
    temperature: number;
    maxOutputTokens: number;
    round: number;
    stop: RunStop;
    meter: UsageMeter;
  }): Promise<SynthesisResult | undefined> {
    const { caller, modelId, system, user, temperature, maxOutputTokens, round, stop, meter } = args;
    this.emit("synthesisStart", { modelId });
    const startedAt = Date.now();
    let content = "";
    let usage: TokenUsage | undefined;
    try {
      const response = await raceAbort(
        caller({
          participantId: "judge",
          modelId,
          round,
          phase: "synthesis",
          system,
          user,
          temperature,
          maxOutputTokens,
          signal: stop.signal,
          onToken: (token) => {
            this.emit("synthesisToken", { token });
          },
        }),
        stop.signal,
      );
      content = response.content;
      usage = response.usage;
      meter.record(modelId, usage, system.length + user.length, content.length);
    } catch (err) {
      if (stop.signal.aborted) return undefined;
      meter.recordFailure();
      const msg = err instanceof Error ? err.message : String(err);
      content = `[Judge error from ${modelId}: ${msg}]`;
    }
    const breach = meter.breached();
    if (breach) stop.trip(breach);
    const completedAt = Date.now();
    const synthesis: SynthesisResult = {
      modelId,
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

// ── Judge prompt ───────────────────────────────────────────

function describeChecks(checks: readonly CandidateCheck[]): string {
  return checks.length === 0 ? "none reported" : checks.map((c) => `${c.name} ${c.status}`).join(", ");
}

/**
 * User prompt for the non-voting judge: the deterministic aggregate, then
 * each juror's latest verdict in canonical labels. Candidate content and
 * candidate ids are not included.
 */
export function buildAdjudicationJudgeUserPrompt(params: {
  candidates: ReadonlyArray<{ id: string; label: string; checks: readonly CandidateCheck[] }>;
  ranking: readonly RankedCandidate[];
  agreement: AdjudicationAgreement;
  jurors: readonly Participant[];
  rounds: readonly AdjudicationRound[];
}): string {
  const labelOf = new Map(params.candidates.map((c) => [c.id, c.label]));
  const L = (id: string) => labelOf.get(id) ?? "?";
  const w = params.agreement.kendallW;
  const head = [
    `Below are the verdicts of ${params.jurors.length} jurors who independently compared ${params.candidates.length} anonymous candidate solutions to the task (labels ${params.candidates.map((c) => c.label).join(", ")}). Nobody, including you, knows who produced which candidate.`,
    "The aggregate ranking was computed deterministically from the jurors' rankings (Borda count). It is not yours to change: synthesize what the jurors said, where they agree, and where they do not.",
    "",
    `Aggregate ranking: ${params.ranking.map((r) => `${r.label} (${r.points} pts${r.eligible ? "" : ", ineligible: failed checks"})`).join(" > ")}`,
    `Agreement (Kendall's W): ${w === null ? "n/a" : w.toFixed(2)} over ${params.agreement.votes} counted vote(s)`,
    "Check results:",
    ...params.candidates.map((c) => `- ${c.label}: ${describeChecks(c.checks)}`),
  ];
  const latestByJuror = new Map<string, AdjudicationRound["verdicts"][number]>();
  for (const round of params.rounds) {
    for (const v of round.verdicts) {
      const prev = latestByJuror.get(v.jurorId);
      if (v.status === "valid" || !prev || prev.status !== "valid") latestByJuror.set(v.jurorId, v);
    }
  }
  const blocks = params.jurors.map((juror, i) => {
    const v = latestByJuror.get(juror.id);
    const title = `### Juror ${i + 1} — ${juror.persona.name} (${juror.modelId})`;
    if (!v || v.status !== "valid") {
      return `${title}\nNo counted verdict (${v?.abstainReason ?? "did not run"}).`;
    }
    const lines = [title, `Ranking: ${v.ranking.map(L).join(" > ")}`];
    for (const a of v.assessments) lines.push(`- ${L(a.candidateId)}: ${a.summary}`);
    if (v.verifiedFindings.length > 0) {
      lines.push("Verified findings:");
      for (const f of v.verifiedFindings) {
        const at = f.line === null ? f.file : `${f.file}:${f.line}`;
        lines.push(`- [${L(f.candidateId)}] ${f.severity} ${at} — ${f.issue}`);
      }
    }
    if (v.droppedFindings.length > 0) {
      lines.push(`(${v.droppedFindings.length} finding(s) dropped: quote not found in the candidate)`);
    }
    return lines.join("\n");
  });
  return `${head.join("\n")}\n\n${blocks.join("\n\n")}`;
}

// ── Helpers ─────────────────────────────────────────────────

function rankingsOf(latest: Map<string, Vote>): string[][] {
  return [...latest.values()].map((v) => v.ranking);
}

function aggregate(
  candidates: readonly NormalizedCandidate[],
  latest: Map<string, Vote>,
  allVerified: ReadonlyArray<{ jurorId: string; finding: AdjudicationFinding }>,
): RankedCandidate[] {
  return rankCandidates({
    candidates,
    rankings: rankingsOf(latest),
    findings: mergeFindings(allVerified),
  });
}

function toRebuttalView(
  vote: Vote | undefined,
  idToLabel: Map<string, string>,
): VerdictForRebuttal | null {
  if (!vote) return null;
  const L = (id: string) => idToLabel.get(id) ?? "?";
  return {
    ranking: vote.ranking.map(L),
    findings: vote.verified.map((f) => ({
      candidate: L(f.candidateId),
      severity: f.severity,
      file: f.file,
      line: f.line,
      quote: f.quote,
      issue: f.issue,
    })),
    assessments: vote.assessments.map((a) => ({ candidate: L(a.candidateId), summary: a.summary })),
  };
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/**
 * Settle with `work`, or reject as soon as `signal` aborts — so a caller
 * that ignores its signal cannot hold the run past a deadline. A late
 * settlement of `work` is swallowed.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Internal stop switch: user abort, deadline, or a budget breach. First cause wins. */
class RunStop {
  readonly #controller = new AbortController();
  #cause: AdjudicationStopReason | undefined;
  readonly #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #user: AbortSignal | undefined;
  readonly #onUserAbort = () => this.trip("aborted");
  readonly #onTrip: (reason: AdjudicationStopReason) => void;

  constructor(
    user: AbortSignal | undefined,
    deadlineMs: number | undefined,
    onTrip: (reason: AdjudicationStopReason) => void,
  ) {
    this.#user = user;
    this.#onTrip = onTrip;
    if (user?.aborted) this.trip("aborted");
    else user?.addEventListener("abort", this.#onUserAbort, { once: true });
    this.#timer =
      deadlineMs !== undefined ? setTimeout(() => this.trip("deadline"), deadlineMs) : undefined;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get cause(): AdjudicationStopReason | undefined {
    return this.#cause;
  }

  trip(cause: AdjudicationStopReason): void {
    if (this.#cause) return;
    this.#cause = cause;
    this.#controller.abort(abortError());
    this.#onTrip(cause);
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#user?.removeEventListener("abort", this.#onUserAbort);
  }
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** Token and cost accounting with the pre-dispatch and post-call budget checks. */
class UsageMeter {
  #input = 0;
  #output = 0;
  #calls = 0;
  #estimated = 0;
  #cost = 0;
  readonly #maxTokens: number | undefined;
  readonly #costCap: CostCap | undefined;

  constructor(maxTokens: number | undefined, costCap: CostCap | undefined) {
    this.#maxTokens = maxTokens;
    this.#costCap = costCap;
  }

  record(modelId: string, usage: TokenUsage | undefined, inputChars: number, outputChars: number) {
    this.#calls += 1;
    const u: TokenUsage = usage ?? {
      inputTokens: estimateTokens(inputChars),
      outputTokens: estimateTokens(outputChars),
      totalTokens: estimateTokens(inputChars) + estimateTokens(outputChars),
    };
    if (!usage) this.#estimated += 1;
    this.#input += u.inputTokens;
    this.#output += u.outputTokens;
    if (this.#costCap) this.#cost += this.#costCap.estimateUSD(modelId, u);
  }

  /** A call that failed without usage: counted, no tokens attributed. */
  recordFailure() {
    this.#calls += 1;
  }

  /**
   * Would dispatching these calls (input estimated at chars/4, output at
   * its full `maxOutputTokens`) cross a ceiling? Worst case on purpose: a
   * single parallel round cannot be stopped half-way by a post-hoc check.
   */
  wouldBreach(
    calls: ReadonlyArray<{ modelId: string; inputChars: number; maxOutputTokens: number }>,
  ): "token-budget" | "cost-cap" | undefined {
    let tokens = 0;
    let cost = 0;
    for (const c of calls) {
      const u = {
        inputTokens: estimateTokens(c.inputChars),
        outputTokens: c.maxOutputTokens,
        totalTokens: estimateTokens(c.inputChars) + c.maxOutputTokens,
      };
      tokens += u.totalTokens;
      if (this.#costCap) cost += this.#costCap.estimateUSD(c.modelId, u);
    }
    if (this.#maxTokens !== undefined && this.#input + this.#output + tokens > this.#maxTokens) {
      return "token-budget";
    }
    if (this.#costCap && this.#cost + cost > this.#costCap.limitUSD) return "cost-cap";
    return undefined;
  }

  breached(): "token-budget" | "cost-cap" | undefined {
    if (this.#maxTokens !== undefined && this.#input + this.#output > this.#maxTokens) {
      return "token-budget";
    }
    if (this.#costCap && this.#cost > this.#costCap.limitUSD) return "cost-cap";
    return undefined;
  }

  snapshot(): AdjudicationUsage {
    return {
      inputTokens: this.#input,
      outputTokens: this.#output,
      totalTokens: this.#input + this.#output,
      calls: this.#calls,
      estimatedCalls: this.#estimated,
      ...(this.#costCap ? { costUSD: this.#cost } : {}),
    };
  }
}

function finiteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function fail(msg: string): never {
  throw new Error(`AdjudicationEngine: ${msg}`);
}

function normalizeAdjudicationOptions(options: AdjudicationOptions): NormalizedAdjudication {
  if (typeof options.task !== "string" || options.task.trim().length === 0) {
    fail("`task` must be a non-empty string.");
  }
  const candidates = options.candidates;
  if (!Array.isArray(candidates) || candidates.length < MIN_CANDIDATES) {
    fail(`at least ${MIN_CANDIDATES} candidates are required (got ${candidates?.length ?? 0}).`);
  }
  if (candidates.length > MAX_CANDIDATES) {
    fail(`at most ${MAX_CANDIDATES} candidates are supported (got ${candidates.length}).`);
  }
  const candidateIds = new Set<string>();
  const normalizedCandidates = candidates.map((c: AdjudicationCandidate, i) => {
    if (typeof c?.id !== "string" || c.id.length === 0) fail(`candidate ${i} needs a non-empty id.`);
    if (candidateIds.has(c.id)) fail(`duplicate candidate id "${c.id}".`);
    candidateIds.add(c.id);
    if (typeof c.content !== "string") fail(`candidate "${c.id}" content must be a string.`);
    const checks = (c.checks ?? []).map((check, k) => {
      const parsed = CandidateCheckSchema.safeParse(check);
      if (!parsed.success) fail(`candidate "${c.id}" check ${k} is invalid.`);
      return parsed.data!;
    });
    return { id: c.id, label: CANDIDATE_LABELS[i]!, content: c.content, checks };
  });

  const jurors = options.jurors;
  if (!Array.isArray(jurors) || jurors.length < MIN_JURORS) {
    fail(`at least ${MIN_JURORS} jurors are required (got ${jurors?.length ?? 0}).`);
  }
  const jurorIds = new Set<string>();
  for (const j of jurors) {
    if (j.id === "judge") fail('juror id "judge" is reserved for the synthesizer.');
    if (jurorIds.has(j.id)) fail(`duplicate juror id "${j.id}".`);
    jurorIds.add(j.id);
  }

  const threshold = options.agreementThreshold ?? DEFAULTS.agreementThreshold;
  if (!finiteNumber(threshold) || threshold < 0 || threshold > 1) {
    fail("`agreementThreshold` must be a number in [0, 1].");
  }
  const budget = options.budget ?? {};
  if (budget.maxTokens !== undefined && !(finiteNumber(budget.maxTokens) && budget.maxTokens > 0)) {
    fail("`budget.maxTokens` must be a positive number.");
  }
  if (budget.deadlineMs !== undefined && !(finiteNumber(budget.deadlineMs) && budget.deadlineMs > 0)) {
    fail("`budget.deadlineMs` must be a positive number.");
  }
  if (budget.costCap && !(finiteNumber(budget.costCap.limitUSD) && budget.costCap.limitUSD > 0)) {
    fail("`budget.costCap.limitUSD` must be a positive number.");
  }
  if (options.randomSeed !== undefined && !(Number.isInteger(options.randomSeed) && options.randomSeed >= 0)) {
    fail("`randomSeed` must be a non-negative integer.");
  }

  const maxRounds = Math.max(
    1,
    Math.min(MAX_ADJUDICATION_ROUNDS, Math.trunc(options.maxRounds ?? DEFAULTS.maxRounds)),
  );
  return {
    task: options.task,
    candidates: normalizedCandidates,
    jurors: jurors.slice(),
    maxRounds,
    agreementThreshold: threshold,
    jurorTemperature: options.jurorTemperature ?? DEFAULTS.jurorTemperature,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    minQuoteLength: options.minQuoteLength ?? DEFAULTS.minQuoteLength,
    judge: options.judge,
    randomSeed: options.randomSeed,
    signal: options.signal,
    maxTokens: budget.maxTokens,
    deadlineMs: budget.deadlineMs,
    costCap: budget.costCap,
  };
}

export {
  DEFAULTS as ADJUDICATION_DEFAULTS,
  MAX_ADJUDICATION_ROUNDS,
  MAX_CANDIDATES as MAX_ADJUDICATION_CANDIDATES,
};
