// ─────────────────────────────────────────────────────────────
// Verification — drop juror findings whose quote is not in the
// candidate they name. Deterministic string matching, no LLM calls.
// ─────────────────────────────────────────────────────────────

import type { AdjudicationCandidate, AdjudicationFinding, VerifiedFinding } from "./types.js";

/** Default minimum normalized quote length. Shorter quotes match too easily. */
export const DEFAULT_MIN_QUOTE_LENGTH = 8;

/** Collapse every whitespace run to one space and trim. */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Remove one leading unified-diff marker (`+`, `-` or space) from every
 * line, except file headers (`+++ ` / `--- `). Lets a juror quote code
 * from a diff without the markers.
 */
export function stripDiffMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) return line;
      const c = line[0];
      return c === "+" || c === "-" || c === " " ? line.slice(1) : line;
    })
    .join("\n");
}

/** Haystacks for one candidate: the content as-is, and without diff markers. */
function haystacks(content: string): [string, string] {
  return [normalizeQuote(content), normalizeQuote(stripDiffMarkers(content))];
}

function appears(quote: string, hay: readonly [string, string], minLength: number): boolean {
  const needle = normalizeQuote(quote);
  if (needle.length < minLength) return false;
  return hay[0].includes(needle) || hay[1].includes(needle);
}

/**
 * True when `quote` appears in `content` after whitespace normalization,
 * either verbatim or with diff markers stripped from the content. Quotes
 * shorter than `minLength` (after normalization) never verify.
 */
export function quoteAppearsIn(
  quote: string,
  content: string,
  minLength: number = DEFAULT_MIN_QUOTE_LENGTH,
): boolean {
  return appears(quote, haystacks(content), minLength);
}

/**
 * Split findings into verified and dropped. A finding is verified when its
 * quote appears in the content of the candidate it names; a finding naming
 * an unknown candidate is dropped.
 */
export function verifyFindings(
  findings: readonly AdjudicationFinding[],
  candidates: readonly Pick<AdjudicationCandidate, "id" | "content">[],
  minLength: number = DEFAULT_MIN_QUOTE_LENGTH,
): { verified: AdjudicationFinding[]; dropped: AdjudicationFinding[] } {
  const cache = new Map<string, [string, string]>();
  const contentById = new Map(candidates.map((c) => [c.id, c.content]));
  const verified: AdjudicationFinding[] = [];
  const dropped: AdjudicationFinding[] = [];
  for (const f of findings) {
    const content = contentById.get(f.candidateId);
    if (content === undefined) {
      dropped.push(f);
      continue;
    }
    let hay = cache.get(f.candidateId);
    if (!hay) {
      hay = haystacks(content);
      cache.set(f.candidateId, hay);
    }
    (appears(f.quote, hay, minLength) ? verified : dropped).push(f);
  }
  return { verified, dropped };
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

/**
 * Merge verified findings that name the same candidate, file and
 * (normalized) quote. Keeps the first report's text, the highest severity,
 * and every reporting juror id, in first-seen order.
 */
export function mergeFindings(
  reports: readonly { jurorId: string; finding: AdjudicationFinding }[],
): VerifiedFinding[] {
  const byKey = new Map<string, VerifiedFinding>();
  for (const { jurorId, finding } of reports) {
    const key = `${finding.candidateId}\u0000${finding.file}\u0000${normalizeQuote(finding.quote)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...finding, reportedBy: [jurorId] });
      continue;
    }
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = finding.severity;
    }
    if (!existing.reportedBy.includes(jurorId)) existing.reportedBy.push(jurorId);
  }
  return [...byKey.values()];
}
