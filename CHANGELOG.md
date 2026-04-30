# Changelog

All notable changes to `ai-consensus-core` will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [SemVer](https://semver.org/spec/v2.0.0.html).

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
