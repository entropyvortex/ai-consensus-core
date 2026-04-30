# ai-consensus-core

> Turn any set of AI models into a real roundtable.
> Production-grade Consensus Validation Protocol (CVP) for TypeScript — zero LLM-provider coupling, highly observable, shipped as a clean npm package.

[![npm](https://img.shields.io/npm/v/ai-consensus-core)](https://www.npmjs.com/package/ai-consensus-core)
[![license](https://img.shields.io/npm/l/ai-consensus-core)](./LICENSE)
[![types](https://img.shields.io/npm/types/ai-consensus-core)](#types)

This is the engine that powers [Roundtable](https://github.com/entropyvortex/roundtable) and the [`ai-consensus-mcp`](https://github.com/entropyvortex/ai-consensus-mcp) MCP server — extracted into a standalone library so anyone can wire multi-model debate into their own product.

## Why this exists

Most "multi-agent" frameworks are toys.
This one is built for real work.

You configure any number of models — Grok, Claude, Gemini, DeepSeek, whatever — give each a persona, and hand it a question. You get:

- **Blind Round 1, then sequential debate.** Each model defends its take under full cross-visibility.
- **Confidence scoring + disagreement detection.** Deterministic, no extra LLM calls.
- **Early stopping** when the group converges.
- **Optional judge synthesis** — a non-voting model produces majority/minority/unresolved sections.
- **Full observability.** Typed event stream fires on every round, every participant, every confidence shift, every disagreement.
- **Zero provider coupling.** The library never imports a provider SDK. You plug in a `ModelCaller` once and use any backend.

## Install

```bash
npm install ai-consensus-core
# or
pnpm add ai-consensus-core
# or
yarn add ai-consensus-core
```

ESM-only. Node ≥ 20. Runtime dependencies: `zod` + Node's built-in `events`. That's it.

## 60-second example

```ts
import {
  ConsensusEngine,
  type ModelCaller,
  type Persona,
} from "ai-consensus-core";

// 1) Bring your own personas. The library ships only the non-voting
//    JUDGE_PERSONA — debate personas are caller-owned content.
//    See docs/personas.md for a copy-paste block of the seven defaults.
const riskAnalyst: Persona = {
  id: "pessimist",
  name: "Risk Analyst",
  description: "Surfaces failure modes and tail risks.",
  systemPrompt: "You are a rigorous Risk Analyst. Surface hidden dangers, second-order effects, and plausible failure modes. Be precise and constructive.",
};
const firstPrinciples: Persona = {
  id: "first-principles",
  name: "First-Principles Engineer",
  description: "Decomposes every claim to axioms.",
  systemPrompt: "You are a First-Principles Engineer. Decompose every claim into fundamental axioms. Reject analogies and expose hidden premises.",
};
const domainExpert: Persona = {
  id: "domain-expert",
  name: "Domain Expert",
  description: "Practical implementation knowledge and edge cases.",
  systemPrompt: "You are a seasoned Domain Expert. Ground your analysis in real-world implementation details, anti-patterns, and edge cases.",
};

// 2) Adapt your provider of choice to the ModelCaller shape.
//    This one targets any OpenAI-compatible endpoint (Grok, Claude, OpenAI, Groq…).
const caller: ModelCaller = async ({ system, user, modelId, temperature, maxOutputTokens, signal }) => {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${process.env.GROK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      temperature,
      max_tokens: maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const json = await res.json();
  return { content: json.choices[0].message.content };
};

// 3) Wire up observability.
const engine = new ConsensusEngine(caller);

engine.on("roundStart", (e) => console.log(`▶ ${e.label}`));
engine.on("roundComplete", (e) => console.log(`  score=${e.score}`));
engine.on("disagreementDetected", (e) =>
  console.log(`  ⚠ ${e.disagreement.label} (Δ=${e.disagreement.severity})`),
);

// 4) Run.
const result = await engine.run({
  question: "Should early-stage startups adopt microservices from day one?",
  participants: [
    { id: "p1", modelId: "grok-4", persona: riskAnalyst },
    { id: "p2", modelId: "grok-4", persona: firstPrinciples },
    { id: "p3", modelId: "grok-4", persona: domainExpert },
  ],
  maxRounds: 4,
  judge: { modelId: "grok-4" }, // uses the shipped JUDGE_PERSONA
});

console.log(`Final score: ${result.finalScore}`);
console.log(result.synthesis?.majorityPosition);
```

## Protocol diagram

```
                        USER QUESTION
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │        ROUND 1 — INITIAL ANALYSIS                       │
  │        (blind=true, parallel, no cross-visibility)      │
  │                                                         │
  │    ┌─────┐   ┌─────┐   ┌─────┐   ┌─────┐                │
  │    │ P₁  │   │ P₂  │   │ P₃  │   │ Pₙ  │                │
  │    └──┬──┘   └──┬──┘   └──┬──┘   └──┬──┘                │
  │       │         │         │         │                   │
  │   ModelCaller   ModelCaller   ...   ModelCaller         │
  │       │         │         │         │                   │
  │       ▼         ▼         ▼         ▼                   │
  │     CONFIDENCE: N   ← extracted from trailing line      │
  └─────────────────────────┬───────────────────────────────┘
                            │
                            ▼
           score₁ = round(clamp(μ − 0.5·σ, 0, 100))
                            │
                            ▼
  ┌─────────────────────────────────────────────────────────┐
  │        ROUND 2 — COUNTERARGUMENTS                       │
  │        (sequential, randomized order, full history)     │
  │                                                         │
  │    P? ──► P? ──► P? ──► P?                              │
  │    Each participant sees every prior response           │
  │    from round 1 AND earlier in round 2.                 │
  └─────────────────────────┬───────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            │                               │
            ▼                               ▼
   |score₂ − score₁| ≤ Δ  ───yes──►   earlyStop event
            │ no                       stopReason = "converged"
            ▼
  ┌─────────────────────────────────────────────────────────┐
  │        ROUND 3 — EVIDENCE ASSESSMENT                    │
  └─────────────────────────┬───────────────────────────────┘
                            ▼
  ┌─────────────────────────────────────────────────────────┐
  │        ROUND 4..N − 1 — SYNTHESIS & REFINEMENT          │
  │        ROUND N        — FINAL SYNTHESIS                 │
  │        (loops until maxRounds or convergence)           │
  └─────────────────────────┬───────────────────────────────┘
                            ▼
               FINAL-ROUND RESPONSES
                            │
              ┌─────────────┴─────────────┐
              │                           │
       judge?=true                 (always)
              │                           │
              ▼                           ▼
    ┌──────────────────┐        ConsensusResult {
    │  JUDGE_PERSONA   │          rounds, finalScore,
    │  (non-voting)    │          finalAverageConfidence,
    │                  │          stopReason, synthesis?
    │ • Majority       │        }
    │ • Minority       │
    │ • Unresolved     │
    │ • JUDGE_CONFIDENCE
    └──────────────────┘
```

### Phase contract

| Round    | Phase                 | Label                                | Visibility           |
| -------- | --------------------- | ------------------------------------ | -------------------- |
| 1        | `initial-analysis`    | `Initial Analysis`                   | **blind** (parallel) |
| 2        | `counterarguments`    | `Counterarguments`                   | full history         |
| 3        | `evidence-assessment` | `Evidence Assessment`                | full history         |
| 4 … N−1  | `synthesis`           | `Synthesis & Refinement (Round k)`   | full history         |
| N (last) | `synthesis`           | `Final Synthesis`                    | full history         |

- **Round 1 is blind by default.** Participants run in parallel, see no one else. Flip `blindFirstRound: false` to go sequential (rare — mostly for deterministic replay).
- **Rounds 2+ are sequential.** Speaking order is randomized unless `randomizeOrder: false`. Each speaker sees everyone who came before them — including earlier speakers in the current round.
- **Every response must end with `CONFIDENCE: N`** where N is an integer 0–100. Missing marker → 50 (neutral).
- **Consensus score** = `round(clamp(μ − 0.5·σ, 0, 100))` using population stddev.
- **Disagreement detected** when two participants' confidences differ by ≥ 20 (tunable).
- **Early stop** when `|score_k − score_{k−1}| ≤ 3` (tunable). Only checked from round 2 onward.

## The `ModelCaller` contract

The library's single extension point. Implement it once for your provider; the engine calls it for every participant and the judge.

```ts
export type ModelCaller = (req: ModelCallRequest) => Promise<ModelCallResponse>;

export interface ModelCallRequest {
  participantId: string;      // "judge" for synthesis calls
  modelId: string;
  round: number;
  phase: Phase;               // "initial-analysis" | "counterarguments" | "evidence-assessment" | "synthesis"
  system: string;             // persona + phase instructions
  user: string;               // the question (or synthesis context for the judge)
  temperature: number;        // 0.7 participants, 0.3 judge (defaults — caller may override)
  maxOutputTokens: number;    // 1500 default
  signal?: AbortSignal;       // honor this
  onToken?: (t: string) => void; // optional streaming sink
}

export interface ModelCallResponse {
  content: string;            // must include the trailing CONFIDENCE: N line
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
```

**Implementation rules.**

1. **Honor `signal`.** The engine propagates cancellation; if you ignore it, your consumers can't cancel a run.
2. **Stream if you can.** Call `onToken` with each chunk; observers get real-time UI for free.
3. **Don't re-throw `AbortError` as something else.** The engine short-circuits cleanly on it.
4. **Don't swallow other errors.** Throw. The engine captures the error into `ParticipantResponse` and keeps running.
5. **Return the full content verbatim.** Do not strip the trailing `CONFIDENCE:` line — the parser needs it.

## Tool calling

Participants can invoke tools mid-turn. The library never executes a tool itself — it plumbs the request from the model to a host-supplied `ToolExecutor`, feeds the results back, and re-invokes the caller until the model returns final content (or `maxToolIterations` is exhausted).

```ts
import { ConsensusEngine, type ToolDefinition, type ToolExecutor } from "ai-consensus-core";

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read a file by absolute path.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const participants = [
  {
    id: "domain",
    modelId: "claude-sonnet-4-6",
    persona: domainExpertPersona,
    tools: [READ_FILE_TOOL], // declared per-participant
  },
  // …
];

const toolExecutor: ToolExecutor = async (call, ctx) => {
  // ctx: { participantId, round, phase, signal? }
  if (call.name === "read_file") {
    const args = call.arguments as { path: string };
    return { content: await readFile(args.path, "utf8") };
    // …or { error: "permission denied" } to feed an error back into the conversation
  }
  return { error: `unknown tool ${call.name}` };
};

const engine = new ConsensusEngine(modelCaller);
const result = await engine.run({
  question: "What does the build output say?",
  participants,
  toolExecutor,
  maxToolIterations: 8, // optional, default 8, clamped to [1, 32]
});
```

**ModelCaller responsibilities** (when `tools` is present on the request):

- Translate the `tools` array into whatever the underlying provider expects (OpenAI's `tools`, Anthropic's `tools`, etc.).
- Translate `toolCallTurns` (when present, on follow-up calls) into the conversation history the provider expects — typically: assistant message with tool_calls, then tool messages with results, in order.
- Parse the model's response and surface `toolCalls` on `ModelCallResponse` if the model wants to dispatch tools. Each `ToolCall` carries `{ id, name, arguments }` where `arguments` is **already JSON-parsed**. The library never parses the model's raw argument string.

**Engine guarantees:**

- The tool loop runs **per participant turn**, separately for each model call. Tool history does not leak between participants or between rounds.
- The executor receives a fresh `ToolCallContext` (with `participantId`, `round`, `phase`, `signal`) per call.
- An exception thrown by the executor is captured as a `{ error: message }` result and forwarded back into the conversation — the participant turn does not abort.
- `AbortError` thrown by the executor (or `signal` triggered) propagates up and aborts the whole run with `stopReason: "aborted"`.
- Hitting `maxToolIterations` breaks the loop and uses the last response's `content` — even if the model still wants more tools.
- Without `toolExecutor`, the engine ignores any `toolCalls` on the response: 0.10 behaviour preserved exactly.

**Events:**

```ts
engine.on("toolCallStart",    (e: ToolCallStartEvent)    => void);
engine.on("toolCallComplete", (e: ToolCallCompleteEvent) => void); // ok: boolean, durationMs, preview (≤ 200 chars)
engine.on("toolError",        (e: ToolErrorEvent)        => void); // fires when ok === false
```

`iteration` (1-based) on these events disambiguates round-trips within a single participant turn.

## Events

```ts
engine.on("roundStart",           (e: RoundStartEvent)           => void);
engine.on("participantStart",     (e: ParticipantStartEvent)     => void);
engine.on("participantToken",     (e: ParticipantTokenEvent)     => void); // only fires if caller streams
engine.on("participantComplete",  (e: ParticipantCompleteEvent)  => void);
engine.on("confidenceUpdate",     (e: ConfidenceUpdateEvent)     => void);
engine.on("disagreementDetected", (e: DisagreementDetectedEvent) => void);
engine.on("roundComplete",        (e: RoundCompleteEvent)        => void);
engine.on("earlyStop",            (e: EarlyStopEvent)            => void);
engine.on("synthesisStart",       (e: SynthesisStartEvent)       => void);
engine.on("synthesisToken",       (e: SynthesisTokenEvent)       => void);
engine.on("synthesisComplete",    (e: SynthesisCompleteEvent)    => void);
engine.on("finalResult",          (e: FinalResultEvent)          => void);
engine.on("toolCallStart",        (e: ToolCallStartEvent)        => void); // per dispatch
engine.on("toolCallComplete",     (e: ToolCallCompleteEvent)     => void);
engine.on("toolError",            (e: ToolErrorEvent)            => void); // ok === false
engine.on("error",                (err: Error)                   => void);
```

Event order for one round of three participants:

```
roundStart
  participantStart (p1) → [participantToken × N if streaming] → participantComplete → confidenceUpdate
  participantStart (p2) → …
  participantStart (p3) → …
  [disagreementDetected × 0..N]
roundComplete
[earlyStop?]
…next round
[synthesisStart → synthesisToken × N → synthesisComplete]
finalResult
```

## Options reference

```ts
interface ConsensusOptions {
  question: string;                       // required, non-empty
  participants: Participant[];            // required, ≥ 2, unique ids

  maxRounds?: number;                     // default 4, clamped to [1, 10]
  earlyStop?: boolean;                    // default true
  convergenceDelta?: number;              // default 3
  disagreementThreshold?: number;         // default 20

  blindFirstRound?: boolean;              // default true
  randomizeOrder?: boolean;               // default true
  participantTemperature?: number;        // default 0.7
  maxOutputTokens?: number;               // default 1500

  judge?: {
    modelId: string;
    caller?: ModelCaller;                 // defaults to engine's main caller
    temperature?: number;                 // default 0.3
    maxOutputTokens?: number;             // default 1500
  };

  randomSeed?: number;                    // deterministic round-order shuffle
  signal?: AbortSignal;                   // cancellation
}
```

## Personas

The library ships **only** the non-voting judge persona (`JUDGE_PERSONA`).
Debate personas are caller-owned content — construct any object matching
`PersonaSchema` and pass it on each `Participant`.

For a copy-paste block of the seven debate personas from the Roundtable
playbook (Risk Analyst, First-Principles Engineer, VC Specialist,
Scientific Skeptic, Optimistic Futurist, Devil's Advocate, Domain Expert),
see [`docs/personas.md`](./docs/personas.md).

The judge:

| id      | Name             | Role                                                                        |
| ------- | ---------------- | --------------------------------------------------------------------------- |
| `judge` | Consensus Judge  | Non-voting synthesizer. Produces Majority / Minority / Unresolved sections. |

`JUDGE_PERSONA.systemPrompt` is the engine's default when
`ConsensusOptions.judge.systemPrompt` is omitted. Override it only if the
replacement emits the same four `##` headings and trailing
`JUDGE_CONFIDENCE: N` line — `extractJudgeSection` /
`extractJudgeConfidence` key off that contract.

```ts
import { JUDGE_PERSONA, PersonaSchema, type Persona } from "ai-consensus-core";

// Validate caller-supplied personas at the boundary:
const persona = PersonaSchema.parse(untrusted);
```

## Scoring

```ts
import { consensusScore, detectDisagreements } from "ai-consensus-core";

consensusScore([85, 82, 78, 40]);

detectDisagreements({
  round: 2,
  responses,        // ParticipantResponse[]
  participants,
  threshold: 20,
});
```

## Cancellation

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);

const result = await engine.run({ ...options, signal: ac.signal });
// result.stopReason === "aborted" if the timeout fires
```

The signal is forwarded into every `ModelCaller` invocation. Any provider that respects `AbortSignal` (most do) tears down cleanly.

## Deterministic replay

Pass `randomSeed` to make round-order shuffling reproducible. Combined with a deterministic `ModelCaller` (e.g. one that replays recorded responses), a whole run becomes bit-for-bit reproducible — perfect for snapshot tests.

```ts
await engine.run({ ...options, randomSeed: 42 });
```

## Types

Everything is exported from the root:

```ts
import type {
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
  ConsensusEventMap,
  RoundStartEvent,
  ParticipantStartEvent,
  ParticipantCompleteEvent,
  RoundCompleteEvent,
  FinalResultEvent,
  // …etc
} from "ai-consensus-core";
```

Zod schemas are exported too, for boundary validation on your side:

```ts
import { PersonaSchema, ParticipantSchema } from "ai-consensus-core";

ParticipantSchema.parse(untrustedInput);
```

## Development

```bash
git clone https://github.com/entropyvortex/ai-consensus-core.git
cd ai-consensus-core
npm install
npm run test        # 136 tests, vitest
npm run test:coverage
npm run build       # emits ESM + .d.ts into dist/
```

## Design notes

- **Why `avg − 0.5·σ` and not median / majority vote?** A high mean with a tight spread should score higher than a high mean with one strong dissenter. A simple linear penalty on stddev does this cheaply and keeps the score on the same 0–100 scale as the raw confidences.
- **Why confidence-delta disagreements, not claim extraction?** Extracting claims from free text is fragile and expensive. A 20-point confidence gap is a strong, cheap, deterministic signal. If you want richer structure, run the judge.
- **Why sequential rounds 2+ instead of parallel?** The protocol wants each speaker to have full visibility of the conversation so far. Parallel would let participants ignore each other and defeat the debate.
- **Why the `CONFIDENCE: N` marker instead of structured outputs?** Every provider supports it. Structured outputs across five-plus providers is a coupling surface we didn't want.

## Philosophy

Most multi-agent frameworks are toys. They hard-code a single provider, assume a single use case, or pile opinions on top of opinions until the engine is unshippable.

This library is the opposite of that. It's the minimum viable mechanism for multi-model consensus — no provider SDK, no CLI, no server, no opinions beyond the protocol itself. You bring the models and the shell; we bring the engine.

If you care about serious multi-AI reasoning, persistent agent memory, and safe, powerful tooling — this is the foundation layer.

## See also

- [`ai-consensus-mcp`](https://github.com/entropyvortex/ai-consensus-mcp) — thin stdio MCP server that wraps this library and exposes `consensus` as a single tool for Claude Code / Cursor / Windsurf / any MCP host.

## License

MIT

---

**Part of the [entropyvortex](https://github.com/entropyvortex) stack** — practical, no-bullshit AI open source by [Marcelo Ceccon](https://github.com/marceloceccon).

Made with ❤️ in Brazil.

MIT License • Built to ship.
