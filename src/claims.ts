// ─────────────────────────────────────────────────────────────
// Claim extractor — semantic contradictions between the final
// responses of a run, as one extra model call.
// ─────────────────────────────────────────────────────────────
// Ported from Roundtable (lib/consensus-engine.ts) with its prompt,
// parser and fuzzy quote check unchanged, so Roundtable can drop its
// copy. Soft-fails: a provider error or unparseable output yields an
// empty digest, never a thrown error (aborts still propagate).

import type {
  ClaimContradiction,
  ClaimDigest,
  ModelCaller,
  Participant,
  ParticipantResponse,
  TokenUsage,
} from "./types.js";

export const CLAIM_EXTRACTOR_SYSTEM_PROMPT = `You are a CONTRADICTION EXTRACTOR. You read the final-round responses from a multi-AI debate and extract the SUBSTANTIVE semantic contradictions between participants.

Output ONLY a JSON object with the following shape — no markdown fences, no preamble, no commentary:

{
  "contradictions": [
    {
      "claim": "<one-line summary of the contested point>",
      "sides": [
        {
          "stance": "<position taken by this side, in 1 sentence>",
          "participantIds": ["<id>", ...],
          "quote": "<verbatim quote from one participant on this side, max 240 chars>"
        }
      ]
    }
  ]
}

Rules:
- Only include contradictions where TWO OR MORE participants take genuinely opposing positions on the same point. Do not invent disagreements.
- Each side must include a verbatim quote from at least one named participant on that side.
- If there are no real contradictions, return {"contradictions": []}.
- Use participant ids exactly as given (e.g., "p-1", "p-2").
- Limit to at most 6 contradictions; pick the most decision-relevant.
- Output ONLY the JSON object. No other text.`;

function stripTrailingConfidence(content: string): string {
  return content.replace(/\nCONFIDENCE:\s*\d+\s*$/i, "").trim();
}

/**
 * User prompt for the extractor: every non-errored final response, headed
 * `<participantId> — <persona name> (<modelId>)`, with the trailing
 * `CONFIDENCE: N` line stripped.
 */
export function buildClaimExtractorUserPrompt(params: {
  finalResponses: readonly ParticipantResponse[];
  participants: readonly Participant[];
}): string {
  const blocks = params.finalResponses
    .filter((r) => !r.error)
    .map((r) => {
      const p = params.participants.find((x) => x.id === r.participantId);
      const label = p ? `${r.participantId} — ${p.persona.name} (${p.modelId})` : r.participantId;
      return `### ${label}\n${stripTrailingConfidence(r.content)}`;
    });
  return `Below are the final-round responses from each participant. Extract the substantive semantic contradictions between them per your instructions.\n\n${blocks.join("\n\n---\n\n")}`;
}

/** Best-effort JSON extraction from a string that may have wrapping noise. */
function extractJSONObject(text: string): unknown {
  const trimmed = text.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}

/** Normalise text for fuzzy quote-match: strip MD/punctuation/whitespace. */
function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_~"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the quote's first 80 normalised characters (minimum 30)
 * appear in one of the named participants' responses. Tolerates
 * paraphrased tails; this is the claims check, not the stricter
 * adjudication quote verification.
 */
function quoteAppearsInResponse(
  quote: string,
  participantIds: readonly string[],
  contentByParticipant: ReadonlyMap<string, string>,
): boolean {
  if (!quote) return false;
  const needleFull = normaliseForMatch(quote);
  if (needleFull.length === 0) return false;
  const needle = needleFull.length > 80 ? needleFull.slice(0, 80) : needleFull;
  if (needle.length < 30) return false;
  for (const id of participantIds) {
    const content = contentByParticipant.get(id);
    if (!content) continue;
    if (normaliseForMatch(content).includes(needle)) return true;
  }
  return false;
}

/**
 * Parse extractor output into contradictions. Defensive: any bad shape
 * becomes an empty array. Keeps at most 8 entries; each needs a claim,
 * at least two sides with a stance, known participant ids and a quote,
 * and no participant on two sides. When `contentByParticipant` is given,
 * each side's quote must appear in one of its participants' responses.
 */
export function parseClaimsJSON(
  rawOutput: string,
  validParticipantIds: ReadonlySet<string>,
  contentByParticipant?: ReadonlyMap<string, string>,
): ClaimContradiction[] {
  const parsed = extractJSONObject(rawOutput);
  if (!parsed || typeof parsed !== "object") return [];
  const list = (parsed as { contradictions?: unknown }).contradictions;
  if (!Array.isArray(list)) return [];

  const out: ClaimContradiction[] = [];
  for (let i = 0; i < list.length && out.length < 8; i++) {
    const entry: unknown = list[i];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const claim = typeof e["claim"] === "string" ? e["claim"].trim() : "";
    if (!claim) continue;

    const sidesIn: unknown[] = Array.isArray(e["sides"]) ? (e["sides"] as unknown[]) : [];
    const sides: ClaimContradiction["sides"] = [];
    const seenParticipants = new Set<string>();
    let dropEntry = false;

    for (const s of sidesIn) {
      if (!s || typeof s !== "object") continue;
      const sObj = s as Record<string, unknown>;
      const stance = typeof sObj["stance"] === "string" ? sObj["stance"].trim() : "";
      const quote = typeof sObj["quote"] === "string" ? sObj["quote"].trim().slice(0, 600) : "";
      const idsRaw: unknown[] = Array.isArray(sObj["participantIds"])
        ? (sObj["participantIds"] as unknown[])
        : [];
      const ids = idsRaw
        .filter((id): id is string => typeof id === "string")
        .filter((id) => validParticipantIds.has(id));
      if (!stance || ids.length === 0 || !quote) continue;

      for (const id of ids) {
        if (seenParticipants.has(id)) {
          dropEntry = true;
          break;
        }
      }
      if (dropEntry) break;
      ids.forEach((id) => seenParticipants.add(id));

      if (contentByParticipant && !quoteAppearsInResponse(quote, ids, contentByParticipant)) {
        continue;
      }
      sides.push({ stance, participantIds: ids, quote });
    }

    if (dropEntry) continue;
    if (sides.length < 2) continue;
    out.push({ id: `claim-${i}`, claim: claim.slice(0, 240), sides });
  }
  return out;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/**
 * Run the claim extractor once over `finalResponses`. The call goes to
 * `caller` with `participantId` (default "claims"), phase "synthesis",
 * temperature 0.2 and 1500 max output tokens unless overridden.
 */
export async function extractClaims(
  caller: ModelCaller,
  params: {
    modelId: string;
    finalResponses: readonly ParticipantResponse[];
    participants: readonly Participant[];
    participantId?: string;
    round?: number;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  },
): Promise<ClaimDigest> {
  const user = buildClaimExtractorUserPrompt(params);
  const round =
    params.round ?? params.finalResponses.reduce((max, r) => Math.max(max, r.round), 1);
  let content = "";
  let usage: TokenUsage | undefined;
  let error: string | undefined;
  try {
    const response = await caller({
      participantId: params.participantId ?? "claims",
      modelId: params.modelId,
      round,
      phase: "synthesis",
      system: CLAIM_EXTRACTOR_SYSTEM_PROMPT,
      user,
      temperature: params.temperature ?? 0.2,
      maxOutputTokens: params.maxOutputTokens ?? 1500,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    content = response.content;
    usage = response.usage;
  } catch (err) {
    if (isAbortError(err)) throw err;
    error = err instanceof Error ? err.message : String(err);
  }

  const valid = params.finalResponses.filter((r) => !r.error);
  const contradictions = error
    ? []
    : parseClaimsJSON(
        content,
        new Set(params.participants.map((p) => p.id)),
        new Map(valid.map((r) => [r.participantId, stripTrailingConfidence(r.content)])),
      );
  return {
    modelId: params.modelId,
    contradictions,
    rawContent: content,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  };
}
