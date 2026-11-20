import { TEST_PERSONAS } from "./_fixtures.js";
import type {
  AdjudicationCandidate,
  ModelCallRequest,
  ModelCallResponse,
  ModelCaller,
  Participant,
  TokenUsage,
} from "../types.js";

// Candidate ids look like real refs on purpose: the blinding tests assert
// that none of them ever reaches a prompt.
export const CANDIDATES: AdjudicationCandidate[] = [
  { id: "refs/heads/attempt-claude", content: "diff --git a/src/sum.ts b/src/sum.ts\n+export const sum = (a, b) => a + b; // ALPHA\n+export const zero = 0;" },
  { id: "refs/heads/attempt-codex", content: "diff --git a/src/sum.ts b/src/sum.ts\n+export function sum(a, b) {\n+  return a - b; // BETA\n+}" },
  { id: "refs/heads/attempt-grok", content: "diff --git a/src/sum.ts b/src/sum.ts\n+export const sum = (...xs) => xs.reduce((a, b) => a + b, 0); // GAMMA" },
];

/** Content tag per candidate, used by fake jurors to recognise candidates. */
export const TAG_OF: Record<string, string> = {
  "refs/heads/attempt-claude": "ALPHA",
  "refs/heads/attempt-codex": "BETA",
  "refs/heads/attempt-grok": "GAMMA",
};

export function J(id: string, personaIdx = 0): Participant {
  return { id, modelId: `model-${id}`, persona: TEST_PERSONAS[personaIdx % TEST_PERSONAS.length]! };
}

export interface Presented {
  label: string;
  content: string;
}

/** Parse the candidate blocks out of a juror user prompt. */
export function presentedIn(user: string): Presented[] {
  const out: Presented[] = [];
  const re = /<<<BEGIN CANDIDATE ([A-Z]) ([0-9a-f]{6})>>>\n([\s\S]*?)\n<<<END CANDIDATE \1 \2>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(user)) !== null) out.push({ label: m[1]!, content: m[3]! });
  return out;
}

/** Label under which the candidate carrying `tag` was shown. */
export function labelFor(user: string, tag: string): string {
  const hit = presentedIn(user).find((p) => p.content.includes(tag));
  if (!hit) throw new Error(`tag ${tag} not presented`);
  return hit.label;
}

export interface JurorScript {
  /** Content tags, best first. */
  prefer?: string[];
  /** Findings by tag; `quote` is copied into the output verbatim. */
  findings?: Array<{ tag: string; quote: string; severity?: "high" | "medium" | "low"; file?: string }>;
  /** Raw output instead of a JSON verdict. */
  raw?: string;
  /** Throw this message instead of answering. */
  throws?: string;
  /** Never settle (ignores the signal) — for deadline / abort tests. */
  hang?: boolean;
  /** Resolve after this many ms (honours the signal). */
  delayMs?: number;
  usage?: TokenUsage;
  /** Script for rebuttal rounds; defaults to the same script. */
  rebuttal?: JurorScript;
}

export interface ScriptedCaller {
  caller: ModelCaller;
  calls: ModelCallRequest[];
}

export const JUDGE_BODY = `## Majority Position
Most jurors preferred A.

## Minority Positions
One juror preferred C.

## Unresolved Disputes
- None

## Synthesis Confidence
JUDGE_CONFIDENCE: 77`;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * A fake ModelCaller driven per juror id. Jurors only see the prompt: they
 * find candidates by content tag and answer in the labels they were shown.
 */
export function scriptedCaller(
  scripts: Record<string, JurorScript>,
  judge: { body?: string; throws?: string; usage?: TokenUsage } = {},
): ScriptedCaller {
  const calls: ModelCallRequest[] = [];
  const caller: ModelCaller = async (req): Promise<ModelCallResponse> => {
    calls.push(req);
    if (req.participantId === "judge") {
      if (judge.throws) throw new Error(judge.throws);
      req.onToken?.("judging");
      return { content: judge.body ?? JUDGE_BODY, ...(judge.usage ? { usage: judge.usage } : {}) };
    }
    const base = scripts[req.participantId];
    if (!base) throw new Error(`no script for ${req.participantId}`);
    const script = req.phase === "counterarguments" && base.rebuttal ? base.rebuttal : base;
    if (script.hang) return new Promise<ModelCallResponse>(() => undefined);
    if (script.delayMs) await sleep(script.delayMs, req.signal);
    if (script.throws) throw new Error(script.throws);
    req.onToken?.("{");
    if (script.raw !== undefined) {
      return { content: script.raw, ...(script.usage ? { usage: script.usage } : {}) };
    }
    const prefer = script.prefer ?? ["ALPHA", "BETA", "GAMMA"];
    const content = JSON.stringify({
      ranking: prefer.map((tag) => labelFor(req.user, tag)),
      assessments: prefer.map((tag) => ({ candidate: labelFor(req.user, tag), summary: `about ${tag}` })),
      findings: (script.findings ?? []).map((f) => ({
        candidate: labelFor(req.user, f.tag),
        severity: f.severity ?? "high",
        file: f.file ?? "src/sum.ts",
        line: null,
        quote: f.quote,
        issue: `problem in ${f.tag}`,
      })),
    });
    return { content, ...(script.usage ? { usage: script.usage } : {}) };
  };
  return { caller, calls };
}
