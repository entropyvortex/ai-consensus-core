import { describe, expect, it, vi } from "vitest";
import { ConsensusEngine } from "../engine.js";
import { TEST_PERSONAS } from "./_fixtures.js";
import type {
  ConsensusOptions,
  ModelCallRequest,
  ModelCallResponse,
  ModelCaller,
  Participant,
  ToolCall,
  ToolCallContext,
  ToolCallTurn,
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutor,
} from "../types.js";

// ─────────────────────────────────────────────────────────────
// Tool-calling: a participant declares a tool, the model emits a
// tool-call request on its first turn, the engine dispatches it
// through the host's executor, then the model returns final content
// on the second turn — including the standard CONFIDENCE marker.
// ─────────────────────────────────────────────────────────────

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a file by absolute path.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

function buildParticipant(id: string, tools?: readonly ToolDefinition[]): Participant {
  const persona = TEST_PERSONAS[0]!;
  return tools ? { id, modelId: `model-${id}`, persona, tools: [...tools] } : { id, modelId: `model-${id}`, persona };
}

function baseOptions(overrides: Partial<ConsensusOptions> = {}): ConsensusOptions {
  return {
    question: "What does the build output say?",
    participants: [buildParticipant("p1", [READ_FILE_TOOL]), buildParticipant("p2")],
    maxRounds: 1,
    earlyStop: false,
    blindFirstRound: true,
    randomizeOrder: false,
    randomSeed: 1,
    ...overrides,
  };
}

/**
 * Build a scripted ModelCaller for tool-calling tests. `script[participantId]`
 * is an array of responses; each engine call to that participant pulls the
 * next entry. The judge isn't used in these tests.
 */
function scriptedCaller(
  script: Record<string, readonly ModelCallResponse[]>,
): { caller: ModelCaller; calls: ModelCallRequest[] } {
  const counters = new Map<string, number>();
  const calls: ModelCallRequest[] = [];
  const caller: ModelCaller = (req) => {
    calls.push(req);
    const seq = script[req.participantId];
    if (!seq) {
      return Promise.resolve({ content: `[no script for ${req.participantId}]\nCONFIDENCE: 50` });
    }
    const idx = counters.get(req.participantId) ?? 0;
    counters.set(req.participantId, idx + 1);
    const entry = seq[Math.min(idx, seq.length - 1)]!;
    return Promise.resolve(entry);
  };
  return { caller, calls };
}

describe("tool calling — happy path", () => {
  it("dispatches a tool call, feeds results back, and uses the second-turn content", async () => {
    const fileContent = "build OK — 0 errors, 1 warning";
    const { caller, calls } = scriptedCaller({
      p1: [
        // First turn: model wants to call read_file
        { content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "/build.log" } }] },
        // Second turn: model has the result, gives final answer + confidence
        { content: `The build log says: ${fileContent}\nCONFIDENCE: 80` },
      ],
      p2: [{ content: "agreed.\nCONFIDENCE: 75" }],
    });

    const executor = vi.fn<(call: ToolCall, ctx: ToolCallContext) => Promise<ToolExecutionResult>>();
    executor.mockResolvedValue({ content: fileContent });

    const events: { name: string; payload: unknown }[] = [];
    const engine = new ConsensusEngine(caller);
    engine.on("toolCallStart", (e) => events.push({ name: "toolCallStart", payload: e }));
    engine.on("toolCallComplete", (e) => events.push({ name: "toolCallComplete", payload: e }));
    engine.on("toolError", (e) => events.push({ name: "toolError", payload: e }));

    const result = await engine.run(baseOptions({ toolExecutor: executor }));

    // Executor called exactly once with the right call + context.
    expect(executor).toHaveBeenCalledTimes(1);
    const callArgs = executor.mock.calls[0]!;
    expect(callArgs[0]).toEqual({ id: "call_1", name: "read_file", arguments: { path: "/build.log" } });
    expect(callArgs[1].participantId).toBe("p1");
    expect(callArgs[1].round).toBe(1);

    // p1 was invoked twice: first turn (gets toolCalls), second turn (final).
    const p1Calls = calls.filter((c) => c.participantId === "p1");
    expect(p1Calls).toHaveLength(2);
    expect(p1Calls[0]!.tools).toEqual([READ_FILE_TOOL]);
    expect(p1Calls[0]!.toolCallTurns).toBeUndefined();
    expect(p1Calls[1]!.tools).toEqual([READ_FILE_TOOL]);
    expect(p1Calls[1]!.toolCallTurns).toHaveLength(1);
    const turn = p1Calls[1]!.toolCallTurns![0]!;
    expect(turn.toolCalls[0]!.name).toBe("read_file");
    expect(turn.toolResults[0]).toEqual({ content: fileContent });

    // The final response uses the second-turn content + CONFIDENCE.
    const p1Response = result.rounds[0]!.responses.find((r) => r.participantId === "p1")!;
    expect(p1Response.content).toContain("build OK");
    expect(p1Response.confidence).toBe(80);
    expect(p1Response.error).toBeUndefined();

    // Events fired with the right shapes.
    const startEvents = events.filter((e) => e.name === "toolCallStart");
    const completeEvents = events.filter((e) => e.name === "toolCallComplete");
    expect(startEvents).toHaveLength(1);
    expect(completeEvents).toHaveLength(1);
    expect((completeEvents[0]!.payload as { ok: boolean }).ok).toBe(true);
  });

  it("ignores toolCalls when no toolExecutor is configured (0.10 backward compat)", async () => {
    const { caller } = scriptedCaller({
      p1: [
        // Model returns a stray toolCalls field even though host has no executor.
        {
          content: "Direct answer despite the tool-call hint.\nCONFIDENCE: 65",
          toolCalls: [{ id: "call_x", name: "ignored", arguments: {} }],
        },
      ],
      p2: [{ content: "yep.\nCONFIDENCE: 70" }],
    });

    const engine = new ConsensusEngine(caller);
    const observed: string[] = [];
    engine.on("toolCallStart", () => observed.push("start"));

    const result = await engine.run(baseOptions()); // no toolExecutor

    expect(observed).toEqual([]); // no events fired
    const p1 = result.rounds[0]!.responses.find((r) => r.participantId === "p1")!;
    expect(p1.content).toContain("Direct answer");
    expect(p1.confidence).toBe(65);
  });

  it("does not pass `tools` to the caller when the participant has none", async () => {
    const { caller, calls } = scriptedCaller({
      p1: [{ content: "answer.\nCONFIDENCE: 60" }],
      p2: [{ content: "agreed.\nCONFIDENCE: 60" }],
    });

    const engine = new ConsensusEngine(caller);
    await engine.run(
      baseOptions({
        participants: [buildParticipant("p1"), buildParticipant("p2")],
        toolExecutor: vi.fn(),
      }),
    );
    for (const c of calls) {
      expect(c.tools).toBeUndefined();
    }
  });
});

describe("tool calling — error handling", () => {
  it("captures executor exceptions as { error } results and continues", async () => {
    const { caller } = scriptedCaller({
      p1: [
        { content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: {} }] },
        { content: "I couldn't read it but here's my best guess.\nCONFIDENCE: 50" },
      ],
      p2: [{ content: "ok.\nCONFIDENCE: 55" }],
    });

    const executor: ToolExecutor = () => {
      throw new Error("filesystem blew up");
    };

    const engine = new ConsensusEngine(caller);
    const errors: { call: ToolCall; error: string }[] = [];
    engine.on("toolError", (e) => errors.push({ call: e.call, error: e.error }));

    const result = await engine.run(baseOptions({ toolExecutor: executor }));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe("filesystem blew up");
    // The participant kept going and produced final content.
    const p1 = result.rounds[0]!.responses.find((r) => r.participantId === "p1")!;
    expect(p1.error).toBeUndefined();
    expect(p1.content).toContain("best guess");
    expect(p1.confidence).toBe(50);
  });

  it("forwards executor-returned { error } as a toolError event with ok:false", async () => {
    const { caller } = scriptedCaller({
      p1: [
        { content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: {} }] },
        { content: "moving on.\nCONFIDENCE: 60" },
      ],
      p2: [{ content: "ok.\nCONFIDENCE: 60" }],
    });

    const executor: ToolExecutor = () => Promise.resolve({ error: "permission denied" });

    const engine = new ConsensusEngine(caller);
    let completeOk: boolean | undefined;
    let errorPayload: string | undefined;
    engine.on("toolCallComplete", (e) => {
      completeOk = e.ok;
    });
    engine.on("toolError", (e) => {
      errorPayload = e.error;
    });

    await engine.run(baseOptions({ toolExecutor: executor }));

    expect(completeOk).toBe(false);
    expect(errorPayload).toBe("permission denied");
  });
});

describe("tool calling — iteration cap", () => {
  it("breaks after maxToolIterations even if model keeps requesting tools", async () => {
    // Model never gives up — every response has a tool call.
    const looping: ModelCallResponse = {
      content: "",
      toolCalls: [{ id: `call_x`, name: "read_file", arguments: {} }],
    };
    // Caller returns the looping response forever for p1.
    const calls: ModelCallRequest[] = [];
    const caller: ModelCaller = (req) => {
      calls.push(req);
      if (req.participantId === "p2") {
        return Promise.resolve({ content: "ok.\nCONFIDENCE: 50" });
      }
      return Promise.resolve(looping);
    };

    let executorCalls = 0;
    const executor: ToolExecutor = () => {
      executorCalls += 1;
      return Promise.resolve({ content: "..." });
    };

    const engine = new ConsensusEngine(caller);
    const result = await engine.run(baseOptions({ toolExecutor: executor, maxToolIterations: 3 }));

    expect(executorCalls).toBe(3);
    // p1 was called maxToolIterations+1 times: one initial + 3 loop iterations,
    // each followed by a re-invocation. After the 3rd dispatch, the engine
    // breaks before re-invoking. So total p1 calls = 1 + 3 = 4.
    const p1Calls = calls.filter((c) => c.participantId === "p1");
    expect(p1Calls).toHaveLength(4);
    // The final response uses the LAST caller response's content (empty).
    const p1 = result.rounds[0]!.responses.find((r) => r.participantId === "p1")!;
    expect(p1.error).toBeUndefined();
    expect(p1.content).toBe("");
  });

  it("clamps maxToolIterations to [1, 32]", async () => {
    // Caller always asks for tools; if cap weren't clamped to 1, executor
    // would run more times. We verify the cap by setting 0 (clamped to 1).
    const calls: ModelCallRequest[] = [];
    const caller: ModelCaller = (req) => {
      calls.push(req);
      if (req.participantId === "p2") return Promise.resolve({ content: "ok.\nCONFIDENCE: 50" });
      return Promise.resolve({
        content: "",
        toolCalls: [{ id: "x", name: "read_file", arguments: {} }],
      });
    };
    let execs = 0;
    const executor: ToolExecutor = () => {
      execs += 1;
      return Promise.resolve({ content: "x" });
    };
    const engine = new ConsensusEngine(caller);
    await engine.run(baseOptions({ toolExecutor: executor, maxToolIterations: 0 }));
    expect(execs).toBe(1); // clamped to 1
  });
});

describe("tool calling — abort", () => {
  it("propagates AbortError from the executor and finalizes with stopReason=aborted", async () => {
    const ac = new AbortController();
    const { caller } = scriptedCaller({
      p1: [
        { content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: {} }] },
        { content: "shouldn't get here.\nCONFIDENCE: 50" },
      ],
      p2: [{ content: "ok.\nCONFIDENCE: 50" }],
    });

    const executor: ToolExecutor = () => {
      ac.abort();
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    };

    const engine = new ConsensusEngine(caller);
    const result = await engine.run(baseOptions({ toolExecutor: executor, signal: ac.signal }));
    expect(result.stopReason).toBe("aborted");
  });
});

describe("tool calling — turn isolation", () => {
  it("does not leak toolCallTurns across separate participant turns", async () => {
    const { caller, calls } = scriptedCaller({
      p1: [
        { content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
        { content: "p1 done.\nCONFIDENCE: 70" },
      ],
      p2: [{ content: "p2 done.\nCONFIDENCE: 75" }],
    });
    const executor: ToolExecutor = () => Promise.resolve({ content: "value" });

    const engine = new ConsensusEngine(caller);
    await engine.run(baseOptions({ toolExecutor: executor }));

    // p2's only call must have an empty/absent toolCallTurns (it didn't call tools).
    const p2Calls = calls.filter((c) => c.participantId === "p2");
    expect(p2Calls).toHaveLength(1);
    expect(p2Calls[0]!.toolCallTurns).toBeUndefined();
  });

  it("emits monotonically increasing iteration counters within a turn", async () => {
    const looping = (cid: string): ModelCallResponse => ({
      content: "",
      toolCalls: [{ id: cid, name: "read_file", arguments: {} }],
    });
    let p1Calls = 0;
    const caller: ModelCaller = (req) => {
      if (req.participantId === "p2") return Promise.resolve({ content: "ok.\nCONFIDENCE: 50" });
      p1Calls += 1;
      // Two iterations of looping, then final content.
      if (p1Calls <= 2) return Promise.resolve(looping(`c${p1Calls}`));
      return Promise.resolve({ content: "done.\nCONFIDENCE: 80" });
    };
    const executor: ToolExecutor = () => Promise.resolve({ content: "ok" });

    const engine = new ConsensusEngine(caller);
    const iterations: number[] = [];
    engine.on("toolCallStart", (e) => iterations.push(e.iteration));

    await engine.run(baseOptions({ toolExecutor: executor }));
    expect(iterations).toEqual([1, 2]);
  });
});

describe("tool calling — turn payload integrity", () => {
  it("usage from each iteration is summed, not replaced", async () => {
    let n = 0;
    const caller: ModelCaller = (req) => {
      if (req.participantId === "p2") {
        return Promise.resolve({
          content: "ok.\nCONFIDENCE: 50",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
      }
      n += 1;
      if (n === 1) {
        return Promise.resolve({
          content: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: {} }],
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        });
      }
      return Promise.resolve({
        content: "done.\nCONFIDENCE: 70",
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
      });
    };
    const executor: ToolExecutor = () => Promise.resolve({ content: "x" });

    const engine = new ConsensusEngine(caller);
    const result = await engine.run(baseOptions({ toolExecutor: executor }));
    const p1 = result.rounds[0]!.responses.find((r) => r.participantId === "p1")!;
    expect(p1.usage).toEqual({ inputTokens: 150, outputTokens: 40, totalTokens: 190 });
  });

  it("the toolCallTurns forwarded to the caller mirror what the executor actually returned", async () => {
    const { caller, calls } = scriptedCaller({
      p1: [
        {
          content: "",
          toolCalls: [
            { id: "c1", name: "read_file", arguments: { p: "/a" } },
            { id: "c2", name: "read_file", arguments: { p: "/b" } },
          ],
        },
        { content: "done.\nCONFIDENCE: 70" },
      ],
      p2: [{ content: "ok.\nCONFIDENCE: 50" }],
    });
    const executor: ToolExecutor = (call) =>
      Promise.resolve({ content: `result-for-${(call.arguments as { p: string }).p}` });

    const engine = new ConsensusEngine(caller);
    await engine.run(baseOptions({ toolExecutor: executor }));

    const followUp = calls.filter((c) => c.participantId === "p1")[1]!;
    const turns: readonly ToolCallTurn[] = followUp.toolCallTurns!;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolCalls).toHaveLength(2);
    expect(turns[0]!.toolResults).toEqual([
      { content: "result-for-/a" },
      { content: "result-for-/b" },
    ]);
  });
});
