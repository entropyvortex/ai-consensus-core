// ─────────────────────────────────────────────────────────────
// Parser — extractors for confidence and judge sections
// ─────────────────────────────────────────────────────────────

const CONFIDENCE_RE = /CONFIDENCE:\s*(\d+)/i;
const JUDGE_CONFIDENCE_RE = /JUDGE_CONFIDENCE:\s*\[?\s*(\d+)\s*\]?/i;

/**
 * Extract the trailing `CONFIDENCE: N` value. Clamps to [0, 100] and
 * defaults to 50 when the marker is absent.
 *
 * The default is intentional: an absent marker is a model compliance
 * issue, not a "low-confidence" signal, so we treat it as neutral rather
 * than letting it skew the consensus score downward.
 */
export function extractConfidence(text: string): number {
  const match = CONFIDENCE_RE.exec(text);
  if (!match) return 50;
  const n = Number.parseInt(match[1]!, 10);
  if (Number.isNaN(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

/**
 * Extract the judge's self-reported synthesis confidence. Tolerates both
 * `JUDGE_CONFIDENCE: 87` and `JUDGE_CONFIDENCE: [87]` forms, since the
 * JUDGE_PERSONA prompt wraps the placeholder in brackets.
 */
export function extractJudgeConfidence(text: string): number {
  const match = JUDGE_CONFIDENCE_RE.exec(text);
  if (!match) return 50;
  const n = Number.parseInt(match[1]!, 10);
  if (Number.isNaN(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

/**
 * Extract a named `## Heading`-style section from a judge synthesis.
 * Returns the trimmed section body, or "" if not found.
 */
export function extractJudgeSection(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const m = pattern.exec(text);
  return m ? m[1]!.trim() : "";
}

/**
 * Strip the trailing `CONFIDENCE: N` line from a body. Used when quoting
 * a participant response back to a downstream model, so the marker from
 * an earlier round doesn't bleed into the next round's parser pass.
 */
export function stripConfidenceLine(text: string): string {
  return text.replace(/\nCONFIDENCE:\s*\d+\s*$/i, "").trim();
}
