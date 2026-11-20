import { describe, it, expect } from "vitest";
import {
  CLAIM_EXTRACTOR_SYSTEM_PROMPT,
  buildClaimExtractorUserPrompt,
  extractClaims,
  parseClaimsJSON,
} from "../claims.js";
import { CostCapExceededError, assertWithinCostCap } from "../budget.js";
import { extractConfidence } from "../parser.js";
import { TEST_PERSONAS } from "./_fixtures.js";
import type { ModelCallRequest, ModelCaller, Participant, ParticipantResponse } from "../types.js";

// parseClaimsJSON cases are ported from Roundtable's suite, which pinned
// this parser before it moved here.
describe("parseClaimsJSON — contract carried over from Roundtable", () => {
  it("returns empty for non-JSON noise", () => {
    expect(parseClaimsJSON("nope", new Set(["p-1"]))).toEqual([]);
    expect(parseClaimsJSON("", new Set(["p-1"]))).toEqual([]);
    expect(parseClaimsJSON("```json\nnot really\n```", new Set(["p-1"]))).toEqual([]);
  });

  it("extracts well-formed contradictions, tolerating surrounding noise", () => {
    const raw = `Some preamble. {"contradictions": [{"claim": "A vs B on X", "sides": [{"stance": "A says yes", "participantIds": ["p-1"], "quote": "Yes definitely"}, {"stance": "B says no", "participantIds": ["p-2"], "quote": "Absolutely not"}]}]} trailing`;
    const out = parseClaimsJSON(raw, new Set(["p-1", "p-2"]));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("claim-0");
    expect(out[0]!.claim).toBe("A vs B on X");
    expect(out[0]!.sides.map((s) => s.participantIds)).toEqual([["p-1"], ["p-2"]]);
  });

  it("drops sides with unknown participant ids (and the claim if <2 sides remain)", () => {
    const raw = `{"contradictions":[{"claim":"X","sides":[{"stance":"yes","participantIds":["p-1"],"quote":"q1"},{"stance":"no","participantIds":["p-ghost"],"quote":"q2"}]}]}`;
    expect(parseClaimsJSON(raw, new Set(["p-1", "p-2"]))).toHaveLength(0);
  });

  it("drops contradictions missing a claim or with fewer than two sides", () => {
    const raw = `{"contradictions":[{"claim":"","sides":[]},{"claim":"only one side","sides":[{"stance":"a","participantIds":["p-1"],"quote":"q"}]}]}`;
    expect(parseClaimsJSON(raw, new Set(["p-1"]))).toEqual([]);
  });

  it("drops a contradiction where one participant appears on two sides", () => {
    const raw = `{"contradictions":[{"claim":"X","sides":[{"stance":"yes","participantIds":["p-1"],"quote":"q1"},{"stance":"no","participantIds":["p-1"],"quote":"q2"}]}]}`;
    expect(parseClaimsJSON(raw, new Set(["p-1", "p-2"]))).toEqual([]);
  });

  it("keeps quotes found in the named participants' content and drops fabricated ones", () => {
    const raw = `{"contradictions":[{"claim":"X","sides":[{"stance":"yes","participantIds":["p-1"],"quote":"This is a long quote that should appear in p-1's actual content extensively"},{"stance":"no","participantIds":["p-2"],"quote":"This is a different long quote that should match p-2 content directly here"}]}]}`;
    const good = new Map([
      ["p-1", "Some preface. This is a long quote that should appear in p-1's actual content extensively. Some suffix."],
      ["p-2", "Header. This is a different long quote that should match p-2 content directly here. Footer."],
    ]);
    expect(parseClaimsJSON(raw, new Set(["p-1", "p-2"]), good)).toHaveLength(1);
    const bad = new Map([
      ["p-1", "Actual content of p-1, completely different from the fabricated quote."],
      ["p-2", "Actual content of p-2, also entirely unrelated to the so-called quote."],
    ]);
    expect(parseClaimsJSON(raw, new Set(["p-1", "p-2"]), bad)).toEqual([]);
  });

  it("caps output at 8 contradictions", () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({
      claim: `claim ${i}`,
      sides: [
        { stance: "a", participantIds: ["p-1"], quote: "q1" },
        { stance: "b", participantIds: ["p-2"], quote: "q2" },
      ],
    }));
    expect(parseClaimsJSON(JSON.stringify({ contradictions: arr }), new Set(["p-1", "p-2"]))).toHaveLength(8);
  });
});

function participant(id: string): Participant {
  return { id, modelId: `Prov/${id}-model`, persona: TEST_PERSONAS[0]! };
}

function response(participantId: string, content: string, error?: string): ParticipantResponse {
  return {
    participantId,
    modelId: "m",
    personaId: "pessimist",
    round: 3,
    phase: "synthesis",
    content,
    confidence: 70,
    ...(error ? { error } : {}),
    startedAt: 0,
    completedAt: 0,
    durationMs: 0,
  };
}

describe("extractClaims — contract: one call, soft-fail, quotes checked against responses", () => {
  const participants = [participant("p-1"), participant("p-2")];
  const finalResponses = [
    response("p-1", "Ship it now because the latency budget is already met in production.\nCONFIDENCE: 80"),
    response("p-2", "Do not ship: the rollback path has never been exercised under load.\nCONFIDENCE: 40"),
    response("p-3", "[Error]", "boom"),
  ];
  const good = JSON.stringify({
    contradictions: [
      {
        claim: "Ship now?",
        sides: [
          { stance: "yes", participantIds: ["p-1"], quote: "Ship it now because the latency budget is already met" },
          { stance: "no", participantIds: ["p-2"], quote: "the rollback path has never been exercised under load" },
        ],
      },
    ],
  });

  it("builds the prompt from non-errored responses without the CONFIDENCE line", () => {
    const user = buildClaimExtractorUserPrompt({ finalResponses, participants });
    expect(user).toContain("### p-1 — Risk Analyst (Prov/p-1-model)");
    expect(user).not.toContain("CONFIDENCE: 80");
    expect(user).not.toContain("p-3");
  });

  it("calls the caller once and returns verified contradictions with usage", async () => {
    const calls: ModelCallRequest[] = [];
    const caller: ModelCaller = async (req) => {
      calls.push(req);
      return { content: good, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
    };
    const digest = await extractClaims(caller, { modelId: "judge-m", finalResponses, participants });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      participantId: "claims",
      modelId: "judge-m",
      round: 3,
      phase: "synthesis",
      system: CLAIM_EXTRACTOR_SYSTEM_PROMPT,
      temperature: 0.2,
      maxOutputTokens: 1500,
    });
    expect(digest.contradictions).toHaveLength(1);
    expect(digest).toMatchObject({ modelId: "judge-m", rawContent: good, usage: { totalTokens: 3 } });
    expect(digest.error).toBeUndefined();
  });

  it("soft-fails on a caller error and on unparseable output", async () => {
    const failing: ModelCaller = async () => {
      throw new Error("HTTP 500");
    };
    const d1 = await extractClaims(failing, { modelId: "m", finalResponses, participants });
    expect(d1).toMatchObject({ contradictions: [], error: "HTTP 500", rawContent: "" });
    const garbage: ModelCaller = async () => ({ content: "this is not json at all" });
    const d2 = await extractClaims(garbage, { modelId: "m", finalResponses, participants });
    expect(d2.contradictions).toEqual([]);
    expect(d2.error).toBeUndefined();
  });

  it("propagates aborts", async () => {
    const aborting: ModelCaller = async () => {
      throw new DOMException("Aborted", "AbortError");
    };
    await expect(extractClaims(aborting, { modelId: "m", finalResponses, participants })).rejects.toThrow(
      "Aborted",
    );
  });
});

describe("extractConfidence — contract: last marker followed by digits (Roundtable parity)", () => {
  it("picks the trailing marker over an earlier preview", () => {
    expect(extractConfidence("I had CONFIDENCE: 30 earlier but after reviewing\n\nCONFIDENCE: 88")).toBe(88);
  });

  it("ignores markers without digits", () => {
    expect(extractConfidence("Confidence: high in the approach.\n\nCONFIDENCE: 72")).toBe(72);
  });

  it("clamps, defaults to 50, and is case-insensitive", () => {
    expect(extractConfidence("no marker here")).toBe(50);
    expect(extractConfidence("CONFIDENCE: 150")).toBe(100);
    expect(extractConfidence("confidence:\n 9")).toBe(9);
    expect(extractConfidence("JUDGE_CONFIDENCE: 61")).toBe(61);
    expect(extractConfidence("CONFIDENCE: none")).toBe(50);
  });
});

describe("cost cap — contract: throw only when strictly above a positive cap", () => {
  it("formats the error like Roundtable did", () => {
    const err = new CostCapExceededError(0.5, 0.1);
    expect(err.message).toBe("Cost cap exceeded: estimated $0.5000 > $0.1000 cap");
    expect(err.name).toBe("CostCapExceededError");
    expect(err).toMatchObject({ runningCostUSD: 0.5, capUSD: 0.1 });
  });

  it("asserts against the cap", () => {
    expect(() => assertWithinCostCap(0.2, 0.1)).toThrow(CostCapExceededError);
    expect(() => assertWithinCostCap(0.1, 0.1)).not.toThrow();
    expect(() => assertWithinCostCap(99, undefined)).not.toThrow();
    expect(() => assertWithinCostCap(99, 0)).not.toThrow();
  });
});
