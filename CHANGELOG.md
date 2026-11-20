# Changelog

All notable changes to `ai-consensus-core` will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.13.0] — 2026-11-20

### Added — attempt adjudication

`AdjudicationEngine` judges N candidate solutions to the same task (e.g. best-of-N branches): one blind parallel round of jurors, deterministic aggregation, a rebuttal round only when agreement is below threshold, then the existing non-voting judge. See README "Attempt adjudication".

- `AdjudicationEngine` (sibling of `ConsensusEngine`, same `ModelCaller`, its own typed event map) with `adjudicate(options)`
- Blinding: per-juror shuffled neutral labels drawn from `randomSeed`; candidate ids never reach a model
- Strict juror contract (`parseJurorVerdict`, `buildJurorVerdictJsonSchema`): malformed output is an abstention
- Quote verification with dropped counts (`verifyFindings`, `quoteAppearsIn`, `mergeFindings`, `normalizeQuote`, `stripDiffMarkers`)
- Aggregation (`bordaCount`, `kendallW`, `rankCandidates`, `decideVerdict`, `computeDissent`, `findingWeights`); failed-check eligibility rule; a Borda tie at the top is "no clear winner"
- Budget: `budget.maxTokens`, `budget.deadlineMs`, `budget.costCap` next to `signal`; breaches return a partial result with `stopReason` `token-budget` / `deadline` / `cost-cap` / `aborted`
- Prompt builders: `buildJurorSystemPrompt`, `buildJurorUserPrompt`, `buildAdjudicationJudgeUserPrompt`
- Schemas and constants: `CandidateCheckSchema`, `AdjudicationCandidateSchema`, `CHECK_STATUSES`, `FINDING_SEVERITIES`, `CANDIDATE_LABELS`, `SEVERITY_WEIGHT`, `DEFAULT_MIN_QUOTE_LENGTH`, `ADJUDICATION_DEFAULTS`, `MAX_ADJUDICATION_ROUNDS`, `MAX_ADJUDICATION_CANDIDATES`

### Added — ported from Roundtable

- `extractClaims`, `parseClaimsJSON`, `buildClaimExtractorUserPrompt`, `CLAIM_EXTRACTOR_SYSTEM_PROMPT`, and the `ClaimContradiction` / `ClaimDigest` types (prompt, parser and fuzzy quote check unchanged)
- `CostCapExceededError`, `assertWithinCostCap` and the `CostCap` type

### Changed — `extractConfidence` reads the trailing marker

`extractConfidence` now returns the value of the **last** `confidence:` marker followed by digits, instead of the first marker. A marker without digits (e.g. "Confidence: high") is skipped rather than returning 50. The protocol asks for the score on the final line; before, an inline mention or a previewed score earlier in a response captured it, and "Confidence: high … CONFIDENCE: 80" scored 50. These are the semantics Roundtable always used.

This changes `ConsensusEngine.run()` scores for responses that mention "confidence:" before their trailing line; responses with a single trailing marker score exactly as before. The default (50 when no marker has digits) and clamping are unchanged.

### Backward compatibility

Apart from the `extractConfidence` change above, additive only. Every other 0.12 export keeps identical runtime source, and the `.d.ts` files for the engine, prompts, stats, events and personas are byte-identical; `types.d.ts`, `parser.d.ts` and `index.d.ts` only gain declarations or doc text. No existing signature or type changed. No new runtime dependencies. Tests: 145 existing (one inverted for the parser change) + 115 new = 260.

## [0.12.0] — 2026-11-14

### Changed — zod 4

- `zod` dependency moved from `^3.24.1` to `^4.6.7`, which clears the high-severity zod advisory fixed in 4.6.6.
- The exported schemas (`PersonaSchema`, `ParticipantSchema`, and the rest) are now zod 4 schemas. Callers that compose them with their own zod 3 schemas should upgrade to zod 4. Validation messages follow zod 4 wording.
- README wording toned down to describe what the library does.

## [0.11.1] — 2026-05-25

### Fixed — judge-confidence parser contract

`buildJudgeSystemPrompt` now idempotently appends the `JUDGE_CONFIDENCE: [number 0-100]` directive, mirroring the `CONFIDENCE: [number 0-100]` handshake that `buildParticipantSystemPrompt` has always emitted. Previously, any caller that supplied a custom `ConsensusOptions.judge.systemPrompt` (instead of relying on `JUDGE_PERSONA.systemPrompt`, which has the directive inline) silently broke the parser contract: `extractJudgeConfidence` would not find the marker, fall through to its 50 default, and return a measurement-shaped value that polluted downstream statistics.

Discovered by a 12-run benchmark in `ai-consensus-mcp` where judge confidence was reported as exactly `μ=50.0, σ=0.0` across every run — the unmistakable fingerprint of the silent default. Every panel in that repo overrode `judgeSystemPrompt` and none re-emitted the marker.

- `buildJudgeSystemPrompt` auto-appends the directive when it is not already present in the supplied prompt
- Idempotency check is case-insensitive substring on `JUDGE_CONFIDENCE`, so `JUDGE_PERSONA`'s inline directive (and any diligent custom caller) is not duplicated
- New contract tests in `prompts.test.ts` mirror the existing participant-side test and fail loudly if a future edit breaks the handshake

### Backward compatibility

No public API change. The only observable difference is that `buildJudgeSystemPrompt`'s output string is longer when the input prompt lacks the marker. Callers that snapshot-test that output will need to regenerate snapshots. Callers that relied on the previous silent-50 behaviour will now see the real model-emitted value (which is the documented intent).

## [0.11.0] — 2026-04-30

### Added — tool calling

The engine can now drive a per-participant tool-call loop. Hosts plug in a `toolExecutor`; participants declare a `tools` list; the engine dispatches each `ToolCall` from the model, feeds the results back, and re-invokes the caller until the model returns final content or `maxToolIterations` is hit.

- `Participant.tools?: ToolDefinition[]` — per-participant tool inventory
- `ConsensusOptions.toolExecutor?: ToolExecutor` — host-supplied dispatcher
- `ConsensusOptions.maxToolIterations?: number` — loop cap (default 8, clamped to [1, 32])
- `ModelCallRequest.tools?: ToolDefinition[]` — forwarded verbatim to the caller
- `ModelCallRequest.toolCallTurns?: ToolCallTurn[]` — accumulated history on follow-up calls
- `ModelCallResponse.toolCalls?: ToolCall[]` — caller may return tool-call requests
- New types: `ToolDefinition`, `ToolCall`, `ToolCallTurn`, `ToolCallContext`, `ToolExecutionResult`, `ToolExecutor`
- New events: `toolCallStart`, `toolCallComplete`, `toolError`
- Schema export: `ToolDefinitionSchema`
- Constant export: `MAX_TOOL_ITERATIONS_CAP` (= 32)

See README "Tool calling" section for the full contract and integration recipe.

### Backward compatibility

100% backward compatible with 0.10.x. Every new field is optional; absence of `toolExecutor` ⇒ engine behaviour is byte-identical to 0.10. Existing tests pass without modification (130/130) plus 12 new tool-calling tests (142 total).

### Internal

- New private engine helper: `#runParticipantTurn` (drives the tool loop)
- New private engine helper: `#dispatchToolCalls` (per-iteration dispatch + events)
- Token usage is summed across loop iterations; the final response's `content` is the participant turn's output

## [0.10.0] — 2026-04-24

- Removed the seven Roundtable personas from the library; they live in `docs/personas.md` for callers to copy. Only `JUDGE_PERSONA` remains in code.
- Added `ConsensusOptions.judge.systemPrompt` to override the synthesis prompt (with documented contract on the `## Majority Position` / `## Synthesis Confidence` markers).
- Replaced ReDoS-prone regex parsers with linear string scans.

(Earlier history is in git; this CHANGELOG starts at 0.10.0.)
